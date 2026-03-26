/**
 * NanoClaw Live Performance Dashboard
 *
 * Serves an HTML dashboard at GET /dashboard and a JSON API at GET /dashboard/data.
 * Uses the same SQLite database as the rest of the system (readonly).
 *
 * Usage:
 *   import { startDashboard } from './dashboard.js';
 *   startDashboard(8080);
 */

import http from 'http';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, [number, number]> = {
  haiku: [0.8, 4.0],
  sonnet: [3.0, 15.0],
  opus: [15.0, 75.0],
};

function tokenCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(MODEL_PRICING).find((k) => model.toLowerCase().includes(k)) ?? 'sonnet';
  const [inPrice, outPrice] = MODEL_PRICING[key];
  return (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
}

function resolveDbPath(): string {
  const storeDir = process.env.STORE_DIR || path.join(process.cwd(), 'store');
  return path.join(storeDir, 'messages.db');
}

function openDb(): Database.Database | null {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    | { name: string }
    | undefined;
  return !!row;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

interface DashboardData {
  generated_at: string;
  revenue: {
    by_business: { name: string; total_usd: number; deal_count: number }[];
    by_channel: { channel: string; total_usd: number }[];
    total_usd: number;
  };
  pipeline: {
    stages: { stage: string; count: number }[];
    win_rate: number;
  };
  response: {
    median_ms: number;
    reply_rate: number;
    count: number;
  };
  marketing: {
    sent: number;
    reply_rate: number;
    bounce_rate: number;
  };
  experiments: { category: string; leader: string; conversion_rate: number; samples: number }[];
  cost: {
    total_usd: number;
    per_conversation: number;
    per_conversion: number;
  };
  complaints: {
    open: number;
    resolved_week: number;
    avg_resolution_hours: number | null;
  };
  health: {
    task_success_rate: number;
    daily_spend_usd: number;
  };
}

function gatherData(): DashboardData {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();

  const empty: DashboardData = {
    generated_at: now.toISOString(),
    revenue: { by_business: [], by_channel: [], total_usd: 0 },
    pipeline: { stages: [], win_rate: 0 },
    response: { median_ms: 0, reply_rate: 0, count: 0 },
    marketing: { sent: 0, reply_rate: 0, bounce_rate: 0 },
    experiments: [],
    cost: { total_usd: 0, per_conversation: 0, per_conversion: 0 },
    complaints: { open: 0, resolved_week: 0, avg_resolution_hours: null },
    health: { task_success_rate: 0, daily_spend_usd: 0 },
  };

  const db = openDb();
  if (!db) return empty;

  try {
    const data = { ...empty };

    // Revenue from deals
    if (tableExists(db, 'deals')) {
      const bizRows = safe(
        () =>
          db
            .prepare(
              `SELECT COALESCE(source, group_folder, 'Other') AS name,
                      SUM(value_cents) AS total_cents,
                      COUNT(*) AS deal_count
               FROM deals WHERE stage = 'won' AND closed_at >= ?
               GROUP BY name ORDER BY total_cents DESC`,
            )
            .all(weekAgo) as { name: string; total_cents: number; deal_count: number }[],
        [],
      );
      data.revenue.by_business = bizRows.map((r) => ({
        name: r.name,
        total_usd: r.total_cents / 100,
        deal_count: r.deal_count,
      }));
      data.revenue.total_usd = bizRows.reduce((s, r) => s + r.total_cents, 0) / 100;
    } else if (tableExists(db, 'conversions')) {
      const rows = safe(
        () =>
          db
            .prepare(
              `SELECT COALESCE(business, channel, 'Other') AS name,
                      SUM(value_usd) AS total_usd, COUNT(*) AS deal_count
               FROM conversions WHERE stage='won' AND created_at >= ?
               GROUP BY name ORDER BY total_usd DESC`,
            )
            .all(weekAgo) as { name: string; total_usd: number; deal_count: number }[],
        [],
      );
      data.revenue.by_business = rows.map((r) => ({
        name: r.name,
        total_usd: r.total_usd,
        deal_count: r.deal_count,
      }));
      data.revenue.total_usd = rows.reduce((s, r) => s + r.total_usd, 0);
    }

    // Channel breakdown
    if (tableExists(db, 'conversions')) {
      data.revenue.by_channel = safe(
        () =>
          db
            .prepare(
              `SELECT COALESCE(channel,'unknown') AS channel, SUM(value_usd) AS total_usd
               FROM conversions WHERE stage='won' AND created_at >= ?
               GROUP BY channel ORDER BY total_usd DESC`,
            )
            .all(weekAgo) as { channel: string; total_usd: number }[],
        [],
      );
    }

    // Pipeline
    if (tableExists(db, 'deals')) {
      data.pipeline.stages = safe(
        () =>
          db
            .prepare(`SELECT stage, COUNT(*) AS count FROM deals WHERE created_at >= ? GROUP BY stage`)
            .all(weekAgo) as { stage: string; count: number }[],
        [],
      );
      const won = data.pipeline.stages.find((s) => s.stage === 'won')?.count ?? 0;
      const lost = data.pipeline.stages.find((s) => s.stage === 'lost')?.count ?? 0;
      data.pipeline.win_rate = won + lost > 0 ? won / (won + lost) : 0;
    }

    // Response performance
    if (tableExists(db, 'response_metrics')) {
      const stats = safe(
        () =>
          db
            .prepare(
              `SELECT COUNT(*) AS cnt,
                      SUM(CASE WHEN customer_replied=1 THEN 1 ELSE 0 END) AS replied
               FROM response_metrics WHERE created_at >= ?`,
            )
            .get(weekAgo) as { cnt: number; replied: number },
        { cnt: 0, replied: 0 },
      );
      data.response.count = stats.cnt;
      data.response.reply_rate = stats.cnt > 0 ? stats.replied / stats.cnt : 0;

      const medianRows = safe(
        () =>
          db
            .prepare(
              `SELECT response_time_ms FROM response_metrics
               WHERE created_at >= ? ORDER BY response_time_ms`,
            )
            .all(weekAgo) as { response_time_ms: number }[],
        [],
      );
      if (medianRows.length > 0) {
        const mid = Math.floor(medianRows.length / 2);
        data.response.median_ms =
          medianRows.length % 2 === 0
            ? (medianRows[mid - 1].response_time_ms + medianRows[mid].response_time_ms) / 2
            : medianRows[mid].response_time_ms;
      }
    }

    // Marketing
    if (tableExists(db, 'outreach_log')) {
      const m = safe(
        () =>
          db
            .prepare(
              `SELECT COUNT(*) AS sent,
                      SUM(CASE WHEN response_at IS NOT NULL THEN 1 ELSE 0 END) AS replies,
                      SUM(CASE WHEN status='bounced' THEN 1 ELSE 0 END) AS bounced
               FROM outreach_log WHERE sent_at >= ?`,
            )
            .get(weekAgo) as { sent: number; replies: number; bounced: number },
        { sent: 0, replies: 0, bounced: 0 },
      );
      data.marketing.sent = m.sent;
      data.marketing.reply_rate = m.sent > 0 ? m.replies / m.sent : 0;
      data.marketing.bounce_rate = m.sent > 0 ? m.bounced / m.sent : 0;
    }

    // Experiments
    if (tableExists(db, 'message_variants')) {
      const variants = safe(
        () =>
          db
            .prepare(
              `SELECT category, variant_name AS leader, times_used AS samples,
                      CASE WHEN times_used>0 THEN CAST(times_converted AS REAL)/times_used ELSE 0 END AS conversion_rate
               FROM message_variants WHERE status='active' AND times_used>0
               ORDER BY category, conversion_rate DESC`,
            )
            .all() as { category: string; leader: string; samples: number; conversion_rate: number }[],
        [],
      );
      const seen = new Set<string>();
      for (const v of variants) {
        if (seen.has(v.category)) continue;
        seen.add(v.category);
        data.experiments.push(v);
      }
    }

    // Cost
    if (tableExists(db, 'usage_log')) {
      const usage = safe(
        () =>
          db
            .prepare(
              `SELECT model, SUM(input_tokens) AS inp, SUM(output_tokens) AS out
               FROM usage_log WHERE timestamp >= ? GROUP BY model`,
            )
            .all(weekAgo) as { model: string; inp: number; out: number }[],
        [],
      );
      data.cost.total_usd = usage.reduce((s, r) => s + tokenCostUsd(r.model, r.inp, r.out), 0);

      const dailyUsage = safe(
        () =>
          db
            .prepare(
              `SELECT model, SUM(input_tokens) AS inp, SUM(output_tokens) AS out
               FROM usage_log WHERE timestamp >= ? GROUP BY model`,
            )
            .all(dayAgo) as { model: string; inp: number; out: number }[],
        [],
      );
      data.health.daily_spend_usd = dailyUsage.reduce(
        (s, r) => s + tokenCostUsd(r.model, r.inp, r.out),
        0,
      );

      // per-conversation and per-conversion
      const convCount = safe(
        () =>
          db
            .prepare(`SELECT COUNT(DISTINCT group_folder) AS c FROM usage_log WHERE timestamp >= ?`)
            .get(weekAgo) as { c: number },
        { c: 0 },
      );
      data.cost.per_conversation =
        convCount.c > 0 ? data.cost.total_usd / convCount.c : 0;

      if (tableExists(db, 'deals')) {
        const wonCount = safe(
          () =>
            (
              db.prepare(`SELECT COUNT(*) AS c FROM deals WHERE stage='won' AND closed_at >= ?`).get(weekAgo) as {
                c: number;
              }
            ).c,
          0,
        );
        data.cost.per_conversion = wonCount > 0 ? data.cost.total_usd / wonCount : 0;
      }
    }

    // Complaints
    if (tableExists(db, 'complaints')) {
      data.complaints.open = safe(
        () =>
          (db.prepare(`SELECT COUNT(*) AS c FROM complaints WHERE resolution_status != 'resolved'`).get() as { c: number }).c,
        0,
      );
      data.complaints.resolved_week = safe(
        () =>
          (
            db
              .prepare(`SELECT COUNT(*) AS c FROM complaints WHERE resolution_status='resolved' AND resolved_at >= ?`)
              .get(weekAgo) as { c: number }
          ).c,
        0,
      );
      data.complaints.avg_resolution_hours = safe(
        () =>
          (
            db
              .prepare(
                `SELECT AVG((julianday(resolved_at)-julianday(created_at))*24) AS h
                 FROM complaints WHERE resolution_status='resolved' AND resolved_at >= ?`,
              )
              .get(weekAgo) as { h: number | null }
          ).h,
        null,
      );
    }

    // Task health
    if (tableExists(db, 'task_run_logs')) {
      const t = safe(
        () =>
          db
            .prepare(
              `SELECT COUNT(*) AS total,
                      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok
               FROM task_run_logs WHERE run_at >= ?`,
            )
            .get(weekAgo) as { total: number; ok: number },
        { total: 0, ok: 0 },
      );
      data.health.task_success_rate = t.total > 0 ? t.ok / t.total : 0;
    }

    return data;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nanoclaw dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface-hover: #222632;
    --border: #2a2e3b;
    --text: #e4e6ed;
    --text-dim: #8b8fa3;
    --accent: #6c5ce7;
    --accent-glow: rgba(108,92,231,0.15);
    --green: #00b894;
    --green-dim: rgba(0,184,148,0.12);
    --red: #ff6b6b;
    --red-dim: rgba(255,107,107,0.12);
    --amber: #fdcb6e;
    --amber-dim: rgba(253,203,110,0.12);
    --blue: #74b9ff;
    --radius: 12px;
    --shadow: 0 2px 12px rgba(0,0,0,0.3);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }
  header {
    padding: 24px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .logo {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }
  .logo span { color: var(--accent); }
  .meta {
    font-size: 13px;
    color: var(--text-dim);
  }
  .meta .dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    margin-right: 6px;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%,100% { opacity:1; }
    50% { opacity:0.4; }
  }
  main {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px;
  }

  /* KPI bar */
  .kpi-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .kpi {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    text-align: center;
    transition: border-color 0.2s;
  }
  .kpi:hover { border-color: var(--accent); }
  .kpi-value {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }
  .kpi-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    margin-top: 4px;
  }
  .kpi-green .kpi-value { color: var(--green); }
  .kpi-accent .kpi-value { color: var(--accent); }
  .kpi-blue .kpi-value { color: var(--blue); }
  .kpi-amber .kpi-value { color: var(--amber); }

  /* Cards grid */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 20px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    box-shadow: var(--shadow);
    transition: transform 0.15s, border-color 0.2s;
  }
  .card:hover {
    transform: translateY(-2px);
    border-color: var(--accent);
  }
  .card-title {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--text-dim);
    margin-bottom: 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .metric-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.03);
  }
  .metric-row:last-child { border-bottom: none; }
  .metric-label { color: var(--text-dim); font-size: 14px; }
  .metric-value { font-weight: 600; font-size: 15px; }

  .trend-up { color: var(--green); }
  .trend-down { color: var(--red); }
  .trend-flat { color: var(--text-dim); }

  /* Funnel */
  .funnel-bar {
    height: 28px;
    border-radius: 6px;
    margin: 6px 0;
    display: flex;
    align-items: center;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    position: relative;
    overflow: hidden;
    min-width: 40px;
  }
  .funnel-bar .funnel-label {
    position: relative; z-index: 1;
    white-space: nowrap;
  }

  /* Experiment table */
  .exp-row {
    display: grid;
    grid-template-columns: 1fr 1.2fr 80px 60px;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    font-size: 13px;
    align-items: center;
  }
  .exp-row:last-child { border-bottom: none; }
  .exp-header {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    padding-bottom: 4px;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
  }
  .badge-green { background: var(--green-dim); color: var(--green); }
  .badge-amber { background: var(--amber-dim); color: var(--amber); }

  /* Revenue list */
  .rev-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.03);
  }
  .rev-item:last-child { border-bottom: none; }
  .rev-name { font-weight: 500; }
  .rev-amount { font-weight: 700; color: var(--green); font-size: 16px; }
  .rev-deals { font-size: 12px; color: var(--text-dim); margin-left: 8px; }

  .empty-state {
    text-align: center;
    padding: 24px;
    color: var(--text-dim);
    font-style: italic;
  }

  footer {
    text-align: center;
    padding: 32px;
    color: var(--text-dim);
    font-size: 12px;
  }

  @media (max-width: 720px) {
    header { padding: 16px; flex-direction: column; gap: 8px; }
    main { padding: 12px; }
    .grid { grid-template-columns: 1fr; }
    .kpi-bar { grid-template-columns: repeat(2, 1fr); }
    .kpi-value { font-size: 22px; }
  }
</style>
</head>
<body>

<header>
  <div class="logo"><span>nano</span>claw</div>
  <div class="meta"><span class="dot"></span>Live &mdash; <span id="timestamp">loading...</span></div>
</header>

<main>
  <div class="kpi-bar" id="kpi-bar"></div>
  <div class="grid" id="grid"></div>
</main>

<footer>nanoclaw adaptive learning system &mdash; auto-refreshes every 60s</footer>

<script>
const $ = (id) => document.getElementById(id);
const money = (v) => '$' + Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct = (v) => (v*100).toFixed(1) + '%';
const pctInt = (v) => (v*100).toFixed(0) + '%';

const FUNNEL_COLORS = {
  lead:'#6c5ce7', new:'#6c5ce7', qualified:'#a29bfe',
  appointment:'#74b9ff', booked:'#74b9ff', proposal:'#fdcb6e',
  won:'#00b894', closed_won:'#00b894', lost:'#ff6b6b', closed_lost:'#ff6b6b'
};
const FUNNEL_ORDER = ['lead','new','qualified','appointment','booked','proposal','won','closed_won','lost','closed_lost'];

function render(d) {
  $('timestamp').textContent = new Date(d.generated_at).toLocaleString();

  // KPI bar
  const totalRev = d.revenue.total_usd;
  const responseTime = d.response.median_ms > 0 ? (d.response.median_ms/1000).toFixed(1)+'s' : 'N/A';
  const winRate = d.pipeline.win_rate > 0 ? pctInt(d.pipeline.win_rate) : 'N/A';
  const dailySpend = d.health.daily_spend_usd;

  $('kpi-bar').innerHTML = [
    kpi('kpi-green', money(totalRev), 'Weekly Revenue'),
    kpi('kpi-accent', winRate, 'Win Rate'),
    kpi('kpi-blue', responseTime, 'Median Response'),
    kpi('kpi-amber', money(dailySpend), 'Daily API Spend'),
  ].join('');

  // Cards
  const cards = [];
  cards.push(revenueCard(d));
  cards.push(pipelineCard(d));
  cards.push(responseCard(d));
  cards.push(marketingCard(d));
  cards.push(experimentsCard(d));
  cards.push(costCard(d));
  cards.push(complaintsCard(d));
  cards.push(healthCard(d));

  $('grid').innerHTML = cards.join('');
}

function kpi(cls, value, label) {
  return '<div class="kpi '+cls+'"><div class="kpi-value">'+value+'</div><div class="kpi-label">'+label+'</div></div>';
}

function card(title, body) {
  return '<div class="card"><div class="card-title">'+title+'</div>'+body+'</div>';
}

function metricRow(label, value, cls) {
  return '<div class="metric-row"><span class="metric-label">'+label+'</span><span class="metric-value '+(cls||'')+'">'+value+'</span></div>';
}

function revenueCard(d) {
  if (!d.revenue.by_business.length) return card('Revenue', '<div class="empty-state">No revenue data</div>');
  let html = '';
  for (const b of d.revenue.by_business) {
    html += '<div class="rev-item"><span class="rev-name">'+esc(b.name)+'<span class="rev-deals">'+b.deal_count+' deals</span></span><span class="rev-amount">'+money(b.total_usd)+'</span></div>';
  }
  html += '<div class="rev-item" style="border-top:1px solid var(--border);margin-top:4px;padding-top:12px"><span class="rev-name" style="font-weight:700">Total</span><span class="rev-amount">'+money(d.revenue.total_usd)+'</span></div>';
  return card('Revenue', html);
}

function pipelineCard(d) {
  if (!d.pipeline.stages.length) return card('Pipeline Funnel', '<div class="empty-state">No pipeline data</div>');
  const sorted = d.pipeline.stages.slice().sort((a,b) => {
    const ai = FUNNEL_ORDER.indexOf(a.stage), bi = FUNNEL_ORDER.indexOf(b.stage);
    return (ai===-1?99:ai) - (bi===-1?99:bi);
  });
  const max = Math.max(...sorted.map(s=>s.count), 1);
  let html = '';
  for (const s of sorted) {
    const w = Math.max(20, (s.count/max)*100);
    const c = FUNNEL_COLORS[s.stage] || '#636e72';
    html += '<div class="funnel-bar" style="width:'+w+'%;background:'+c+'"><span class="funnel-label">'+esc(s.stage)+': '+s.count+'</span></div>';
  }
  return card('Pipeline Funnel', html);
}

function responseCard(d) {
  const med = d.response.median_ms > 0 ? (d.response.median_ms/1000).toFixed(1)+'s' : 'N/A';
  return card('Response Performance',
    metricRow('Median Response Time', med) +
    metricRow('Customer Reply Rate', pct(d.response.reply_rate)) +
    metricRow('Messages Handled', d.response.count.toLocaleString())
  );
}

function marketingCard(d) {
  return card('Marketing',
    metricRow('Outreach Sent', d.marketing.sent.toLocaleString()) +
    metricRow('Reply Rate', pct(d.marketing.reply_rate)) +
    metricRow('Bounce Rate', pct(d.marketing.bounce_rate), d.marketing.bounce_rate > 0.05 ? 'trend-down' : '')
  );
}

function experimentsCard(d) {
  if (!d.experiments.length) return card('A/B Experiments', '<div class="empty-state">No active experiments</div>');
  let html = '<div class="exp-row exp-header"><span>Category</span><span>Leader</span><span>Conv.</span><span>n</span></div>';
  for (const e of d.experiments) {
    const badgeCls = e.conversion_rate >= 0.1 ? 'badge-green' : 'badge-amber';
    html += '<div class="exp-row"><span>'+esc(e.category)+'</span><span>'+esc(e.leader)+'</span><span class="badge '+badgeCls+'">'+pctInt(e.conversion_rate)+'</span><span style="color:var(--text-dim)">'+e.samples+'</span></div>';
  }
  return card('A/B Experiments', html);
}

function costCard(d) {
  return card('API Cost',
    metricRow('Weekly Total', money(d.cost.total_usd)) +
    metricRow('Per Conversation', money(d.cost.per_conversation)) +
    metricRow('Per Conversion', d.cost.per_conversion > 0 ? money(d.cost.per_conversion) : 'N/A')
  );
}

function complaintsCard(d) {
  const avg = d.complaints.avg_resolution_hours !== null ? d.complaints.avg_resolution_hours.toFixed(1)+' hrs' : 'N/A';
  return card('Customer Health',
    metricRow('Open Complaints', d.complaints.open.toString(), d.complaints.open > 3 ? 'trend-down' : '') +
    metricRow('Resolved This Week', d.complaints.resolved_week.toString(), 'trend-up') +
    metricRow('Avg Resolution', avg)
  );
}

function healthCard(d) {
  const rate = pct(d.health.task_success_rate);
  const cls = d.health.task_success_rate >= 0.95 ? 'trend-up' : d.health.task_success_rate >= 0.8 ? '' : 'trend-down';
  return card('System Health',
    metricRow('Task Success Rate', rate, cls) +
    metricRow('Daily API Spend', money(d.health.daily_spend_usd))
  );
}

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

async function load() {
  try {
    const r = await fetch('/dashboard/data');
    if (!r.ok) throw new Error(r.statusText);
    render(await r.json());
  } catch(e) {
    $('grid').innerHTML = '<div class="card" style="grid-column:1/-1"><div class="empty-state">Failed to load data: '+esc(e.message)+'</div></div>';
  }
}

load();
setInterval(load, 60000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function startDashboard(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0];

    if (req.method === 'GET' && (url === '/dashboard' || url === '/dashboard/')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(dashboardHtml());
      return;
    }

    if (req.method === 'GET' && url === '/dashboard/data') {
      const data = gatherData();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(data));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, () => {
    logger.info({ port }, 'Dashboard listening at http://localhost:%d/dashboard', port);
  });

  server.on('error', (err) => {
    logger.error({ err, port }, 'Dashboard server failed to start');
  });

  return server;
}

// Allow standalone execution
if (process.argv[1] && process.argv[1].includes('dashboard')) {
  const port = parseInt(process.argv[2] || '8080', 10);
  startDashboard(port);
}
