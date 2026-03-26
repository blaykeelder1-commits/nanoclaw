#!/usr/bin/env npx tsx
/**
 * Weekly Revenue & Performance Report for NanoClaw
 * Generates a WhatsApp-formatted summary from the local SQLite database.
 *
 * Usage:
 *   npx tsx tools/learning/revenue-report.ts
 *   npx tsx tools/learning/revenue-report.ts --days 14
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { getDbPath } from '../shared/db-path.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error('Database not found. Run NanoClaw first.');
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}

function money(cents: number): string {
  const abs = Math.abs(cents);
  const formatted = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cents < 0 ? `-$${formatted}` : `$${formatted}`;
}

function moneyUsd(usd: number): string {
  const abs = Math.abs(usd);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return usd < 0 ? `-$${formatted}` : `$${formatted}`;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function safeGet<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    | { name: string }
    | undefined;
  return !!row;
}

// Model pricing per million tokens (input / output)
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

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

function weekRange(days: number): { start: string; end: string; label: string } {
  const now = new Date();
  const end = now.toISOString();
  const start = new Date(now.getTime() - days * 86_400_000).toISOString();
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const label = `${fmt(new Date(start))} – ${fmt(now)}`;
  return { start, end, label };
}

interface RevenueRow {
  business: string;
  total_cents: number;
  deal_count: number;
}

function revenueSection(db: Database.Database, start: string): string {
  const lines: string[] = ['*Revenue*'];

  if (tableExists(db, 'deals')) {
    const rows = safeGet(
      () =>
        db
          .prepare(
            `SELECT COALESCE(source, group_folder, 'Other') AS business,
                    SUM(value_cents) AS total_cents,
                    COUNT(*) AS deal_count
             FROM deals
             WHERE stage = 'won' AND closed_at >= ?
             GROUP BY business
             ORDER BY total_cents DESC`,
          )
          .all(start) as RevenueRow[],
      [],
    );

    if (rows.length === 0) {
      lines.push('• No closed deals this period');
    } else {
      let grandTotal = 0;
      for (const r of rows) {
        lines.push(`• ${r.business}: ${money(r.total_cents)} (${r.deal_count} deals closed)`);
        grandTotal += r.total_cents;
      }
      lines.push(`• *Total: ${money(grandTotal)}*`);
    }
  } else if (tableExists(db, 'conversions')) {
    const rows = safeGet(
      () =>
        db
          .prepare(
            `SELECT COALESCE(business, channel, 'Other') AS business,
                    SUM(value_usd) AS total_usd,
                    COUNT(*) AS cnt
             FROM conversions
             WHERE stage = 'won' AND created_at >= ?
             GROUP BY business
             ORDER BY total_usd DESC`,
          )
          .all(start) as { business: string; total_usd: number; cnt: number }[],
      [],
    );

    if (rows.length === 0) {
      lines.push('• No conversions this period');
    } else {
      let grandTotal = 0;
      for (const r of rows) {
        lines.push(`• ${r.business}: ${moneyUsd(r.total_usd)} (${r.cnt} conversions)`);
        grandTotal += r.total_usd;
      }
      lines.push(`• *Total: ${moneyUsd(grandTotal)}*`);
    }
  } else {
    lines.push('• No data');
  }

  return lines.join('\n');
}

function pipelineSection(db: Database.Database, start: string): string {
  const lines: string[] = ['*Pipeline*'];

  if (!tableExists(db, 'deals')) {
    lines.push('• No data');
    return lines.join('\n');
  }

  const stageCounts = safeGet(
    () =>
      db
        .prepare(
          `SELECT stage, COUNT(*) AS cnt FROM deals
           WHERE created_at >= ?
           GROUP BY stage`,
        )
        .all(start) as { stage: string; cnt: number }[],
    [],
  );

  const map = new Map(stageCounts.map((r) => [r.stage, r.cnt]));

  const newLeads = map.get('lead') ?? map.get('new') ?? 0;
  const qualified = map.get('qualified') ?? 0;
  const appointment = map.get('appointment') ?? map.get('booked') ?? 0;
  const proposal = map.get('proposal') ?? 0;
  const won = map.get('won') ?? map.get('closed_won') ?? 0;
  const lost = map.get('lost') ?? map.get('closed_lost') ?? 0;
  const winRate = won + lost > 0 ? ((won / (won + lost)) * 100).toFixed(0) : '0';

  lines.push(`• New leads: ${newLeads}`);
  lines.push(`• Qualified: ${qualified}`);
  lines.push(`• Appointments booked: ${appointment}`);
  lines.push(`• Proposals: ${proposal}`);
  lines.push(`• Won: ${won} | Lost: ${lost}`);
  lines.push(`• Win rate: ${winRate}%`);

  return lines.join('\n');
}

function responseSection(db: Database.Database, start: string): string {
  const lines: string[] = ['*Response Performance*'];

  if (!tableExists(db, 'response_metrics')) {
    lines.push('• No data');
    return lines.join('\n');
  }

  const stats = safeGet(
    () =>
      db
        .prepare(
          `SELECT COUNT(*) AS cnt,
                  SUM(CASE WHEN customer_replied = 1 THEN 1 ELSE 0 END) AS replied
           FROM response_metrics WHERE created_at >= ?`,
        )
        .get(start) as { cnt: number; replied: number } | undefined,
    undefined,
  );

  const median = safeGet(
    () => {
      const rows = db
        .prepare(
          `SELECT response_time_ms FROM response_metrics
           WHERE created_at >= ? ORDER BY response_time_ms`,
        )
        .all(start) as { response_time_ms: number }[];
      if (rows.length === 0) return null;
      const mid = Math.floor(rows.length / 2);
      return rows.length % 2 === 0
        ? (rows[mid - 1].response_time_ms + rows[mid].response_time_ms) / 2
        : rows[mid].response_time_ms;
    },
    null,
  );

  const cnt = stats?.cnt ?? 0;
  const replied = stats?.replied ?? 0;

  lines.push(`• Median response time: ${median !== null ? (median / 1000).toFixed(1) + 's' : 'N/A'}`);
  lines.push(`• Customer reply rate: ${pct(replied, cnt)}`);
  lines.push(`• Messages handled: ${cnt}`);

  return lines.join('\n');
}

function marketingSection(db: Database.Database, start: string): string {
  const lines: string[] = ['*Marketing*'];

  if (!tableExists(db, 'outreach_log')) {
    lines.push('• No data');
    return lines.join('\n');
  }

  const stats = safeGet(
    () =>
      db
        .prepare(
          `SELECT COUNT(*) AS sent,
                  SUM(CASE WHEN response_at IS NOT NULL THEN 1 ELSE 0 END) AS replies,
                  SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced
           FROM outreach_log WHERE sent_at >= ?`,
        )
        .get(start) as { sent: number; replies: number; bounced: number } | undefined,
    undefined,
  );

  const sent = stats?.sent ?? 0;
  const replies = stats?.replies ?? 0;
  const bounced = stats?.bounced ?? 0;

  // Cost per conversion: total API spend / conversions
  let costPerConversion = 'N/A';
  if (tableExists(db, 'usage_log') && (tableExists(db, 'deals') || tableExists(db, 'conversions'))) {
    const spend = apiSpendUsd(db, start);
    let conversions = 0;
    if (tableExists(db, 'deals')) {
      const row = safeGet(
        () => db.prepare(`SELECT COUNT(*) AS c FROM deals WHERE stage='won' AND closed_at >= ?`).get(start) as { c: number },
        { c: 0 },
      );
      conversions = row.c;
    }
    if (conversions > 0) {
      costPerConversion = moneyUsd(spend / conversions);
    }
  }

  lines.push(`• Outreach sent: ${sent}`);
  lines.push(`• Reply rate: ${pct(replies, sent)}`);
  lines.push(`• Bounce rate: ${pct(bounced, sent)}`);
  lines.push(`• Cost per conversion: ${costPerConversion}`);

  return lines.join('\n');
}

function complaintsSection(db: Database.Database, start: string): string {
  const lines: string[] = ['*Customer Health*'];

  if (!tableExists(db, 'complaints')) {
    lines.push('• No data');
    return lines.join('\n');
  }

  const open = safeGet(
    () => (db.prepare(`SELECT COUNT(*) AS c FROM complaints WHERE resolution_status != 'resolved'`).get() as { c: number }).c,
    0,
  );

  const resolved = safeGet(
    () =>
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM complaints WHERE resolution_status = 'resolved' AND resolved_at >= ?`)
          .get(start) as { c: number }
      ).c,
    0,
  );

  const avgHours = safeGet(() => {
    const row = db
      .prepare(
        `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) AS avg_hrs
         FROM complaints
         WHERE resolution_status = 'resolved' AND resolved_at >= ?`,
      )
      .get(start) as { avg_hrs: number | null } | undefined;
    return row?.avg_hrs;
  }, null);

  lines.push(`• Open complaints: ${open}`);
  lines.push(`• Resolved this week: ${resolved}`);
  lines.push(`• Avg resolution: ${avgHours !== null ? avgHours.toFixed(1) + ' hours' : 'N/A'}`);

  return lines.join('\n');
}

function abTestSection(db: Database.Database): string {
  const lines: string[] = ['*A/B Tests*'];

  if (!tableExists(db, 'message_variants')) {
    lines.push('• No data');
    return lines.join('\n');
  }

  const leaders = safeGet(
    () =>
      db
        .prepare(
          `SELECT category, variant_name,
                  times_converted, times_used,
                  CASE WHEN times_used > 0 THEN CAST(times_converted AS REAL) / times_used ELSE 0 END AS conv_rate
           FROM message_variants
           WHERE status = 'active' AND times_used > 0
           ORDER BY category, conv_rate DESC`,
        )
        .all() as {
        category: string;
        variant_name: string;
        times_converted: number;
        times_used: number;
        conv_rate: number;
      }[],
    [],
  );

  if (leaders.length === 0) {
    lines.push('• No active experiments');
    return lines.join('\n');
  }

  // Pick top variant per category
  const seen = new Set<string>();
  for (const r of leaders) {
    if (seen.has(r.category)) continue;
    seen.add(r.category);
    lines.push(
      `• ${r.category}: "${r.variant_name}" winning at ${(r.conv_rate * 100).toFixed(0)}% conversion (${r.times_used} samples)`,
    );
  }

  return lines.join('\n');
}

function apiSpendUsd(db: Database.Database, start: string): number {
  if (!tableExists(db, 'usage_log')) return 0;

  const rows = safeGet(
    () =>
      db
        .prepare(
          `SELECT model, SUM(input_tokens) AS inp, SUM(output_tokens) AS out
           FROM usage_log WHERE timestamp >= ?
           GROUP BY model`,
        )
        .all(start) as { model: string; inp: number; out: number }[],
    [],
  );

  let total = 0;
  for (const r of rows) {
    total += tokenCostUsd(r.model, r.inp, r.out);
  }
  return total;
}

function systemHealthSection(db: Database.Database, start: string, days: number): string {
  const lines: string[] = ['*System Health*'];

  // Task success rate
  if (tableExists(db, 'task_run_logs')) {
    const stats = safeGet(
      () =>
        db
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok
             FROM task_run_logs WHERE run_at >= ?`,
          )
          .get(start) as { total: number; ok: number } | undefined,
      undefined,
    );
    const total = stats?.total ?? 0;
    const ok = stats?.ok ?? 0;
    lines.push(`• Task success rate: ${pct(ok, total)}`);
  } else {
    lines.push('• Task success rate: No data');
  }

  // Daily API spend
  const totalSpend = apiSpendUsd(db, start);
  const daily = days > 0 ? totalSpend / days : totalSpend;
  lines.push(`• Daily API spend: ${moneyUsd(daily)}`);

  // Uptime approximation from task_run_logs
  if (tableExists(db, 'task_run_logs')) {
    const uptime = safeGet(() => {
      const first = db
        .prepare(`SELECT MIN(run_at) AS earliest FROM task_run_logs WHERE run_at >= ?`)
        .get(start) as { earliest: string | null } | undefined;
      if (!first?.earliest) return null;
      const hours = (Date.now() - new Date(first.earliest).getTime()) / 3_600_000;
      return hours;
    }, null);
    lines.push(`• Uptime: ${uptime !== null ? uptime.toFixed(0) + ' hours' : 'N/A'}`);
  } else {
    lines.push('• Uptime: N/A');
  }

  return lines.join('\n');
}

function insightsSection(db: Database.Database, start: string): string {
  const lines: string[] = ['*Top Insights*'];
  const observations: string[] = [];

  // Best performing business
  if (tableExists(db, 'deals')) {
    const top = safeGet(
      () =>
        db
          .prepare(
            `SELECT COALESCE(source, group_folder, 'Unknown') AS biz, SUM(value_cents) AS rev
             FROM deals WHERE stage='won' AND closed_at >= ?
             GROUP BY biz ORDER BY rev DESC LIMIT 1`,
          )
          .get(start) as { biz: string; rev: number } | undefined,
      undefined,
    );
    if (top && top.rev > 0) {
      observations.push(`${top.biz} is the top revenue driver at ${money(top.rev)}`);
    }
  }

  // Response trend
  if (tableExists(db, 'response_metrics')) {
    const avg = safeGet(
      () =>
        (
          db
            .prepare(`SELECT AVG(response_time_ms) AS avg_ms FROM response_metrics WHERE created_at >= ?`)
            .get(start) as { avg_ms: number | null }
        ).avg_ms,
      null,
    );
    if (avg !== null) {
      if (avg < 5000) observations.push(`Average response time is fast at ${(avg / 1000).toFixed(1)}s`);
      else if (avg > 30000) observations.push(`Response time is slow (${(avg / 1000).toFixed(0)}s avg) — consider optimization`);
    }
  }

  // Best A/B variant
  if (tableExists(db, 'message_variants')) {
    const best = safeGet(
      () =>
        db
          .prepare(
            `SELECT category, variant_name,
                    CASE WHEN times_used > 0 THEN CAST(times_converted AS REAL) / times_used ELSE 0 END AS rate
             FROM message_variants WHERE status='active' AND times_used >= 10
             ORDER BY rate DESC LIMIT 1`,
          )
          .get() as { category: string; variant_name: string; rate: number } | undefined,
      undefined,
    );
    if (best && best.rate > 0) {
      observations.push(
        `"${best.variant_name}" (${best.category}) is converting at ${(best.rate * 100).toFixed(0)}% — scale this message`,
      );
    }
  }

  if (observations.length === 0) {
    observations.push('Not enough data yet for automated insights');
  }

  for (const obs of observations) {
    lines.push(`• ${obs}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const daysFlag = args.indexOf('--days');
  const days = daysFlag !== -1 && args[daysFlag + 1] ? parseInt(args[daysFlag + 1], 10) : 7;

  const db = openDb();
  const { start, label } = weekRange(days);

  const sections = [
    `*Weekly Performance Report*`,
    `_${label}_`,
    '',
    revenueSection(db, start),
    '',
    pipelineSection(db, start),
    '',
    responseSection(db, start),
    '',
    marketingSection(db, start),
    '',
    complaintsSection(db, start),
    '',
    abTestSection(db),
    '',
    systemHealthSection(db, start, days),
    '',
    insightsSection(db, start),
  ];

  console.log(sections.join('\n'));
  db.close();
}

main();
