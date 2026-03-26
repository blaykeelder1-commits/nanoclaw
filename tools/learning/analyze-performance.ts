#!/usr/bin/env npx tsx
/**
 * Weekly Performance Analysis Tool for NanoClaw Adaptive Learning
 *
 * Analyzes 7 days of data from the SQLite database and produces structured insights
 * per group. Graduates A/B test winners, appends lessons, writes performance-insights.json.
 *
 * Usage:
 *   npx tsx tools/learning/analyze-performance.ts --all-groups
 *   npx tsx tools/learning/analyze-performance.ts --group snak-group
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getDbPath } from '../shared/db-path.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerformanceInsights {
  generated_at: string;
  period: string;
  response_time: {
    median_ms: number | null;
    p95_ms: number | null;
    count: number;
    trend: 'improving' | 'stable' | 'declining';
  };
  conversion_funnel: {
    new_to_qualified: number | null;
    qualified_to_booked: number | null;
    overall: number | null;
    trend: 'improving' | 'stable' | 'declining';
  };
  complaints: {
    open: number;
    resolved_this_week: number;
    avg_resolution_hours: number | null;
    top_category: string | null;
  };
  outreach: {
    sent: number;
    reply_rate: number | null;
    bounce_rate: number | null;
  };
  cost: {
    total_usd: number;
    per_conversation: number | null;
    per_conversion: number | null;
  };
  task_health: {
    total_runs: number;
    error_rate: number | null;
    failing_tasks: string[];
  };
  experiments: ExperimentResult[];
  recommendations: string[];
}

interface ExperimentResult {
  category: string;
  leader: string;
  conversion_pct: number;
  sample_size: number;
  status: 'sufficient_data' | 'needs_more_data' | 'winner_graduated';
}

interface VariantRow {
  id: number;
  category: string;
  variant_name: string;
  template: string;
  times_used: number;
  times_converted: number;
  times_replied: number;
  status: string;
}

// ---------------------------------------------------------------------------
// Model pricing per million tokens
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  haiku: { input: 0.8, output: 4.0 },
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 15.0, output: 75.0 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function median(sorted: number[]): number | null {
  return percentile(sorted, 50);
}

function round2(n: number | null): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(n * 100) / 100;
}

function safeDiv(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function daysBefore(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function resolveModel(modelStr: string): string {
  const lower = modelStr.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return 'haiku';
}

function trendLabel(current: number | null, previous: number | null, lowerIsBetter = false): 'improving' | 'stable' | 'declining' {
  if (current === null || previous === null || previous === 0) return 'stable';
  const pctChange = (current - previous) / previous;
  const threshold = 0.1; // 10% change threshold
  if (Math.abs(pctChange) < threshold) return 'stable';
  if (lowerIsBetter) return pctChange < 0 ? 'improving' : 'declining';
  return pctChange > 0 ? 'improving' : 'declining';
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error('Database not found at', dbPath);
    process.exit(1);
  }
  return new Database(dbPath, { readonly: false }); // Need write for marking events processed
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as { name: string } | undefined;
  return !!row;
}

function safeAll<T = Record<string, unknown>>(db: Database.Database, table: string, sql: string, ...params: unknown[]): T[] {
  if (!tableExists(db, table)) return [];
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function safeGet<T = Record<string, unknown>>(db: Database.Database, table: string, sql: string, ...params: unknown[]): T | undefined {
  if (!tableExists(db, table)) return undefined;
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

function getProjectRoot(): string {
  // In container: /workspace/project, on host: cwd
  if (fs.existsSync('/workspace/project/groups')) return '/workspace/project';
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Analysis functions
// ---------------------------------------------------------------------------

function analyzeResponseMetrics(db: Database.Database, folder: string, weekStart: string, weekEnd: string, prevStart: string, prevEnd: string) {
  const rows = safeAll<{ response_time_ms: number }>(
    db, 'response_metrics',
    `SELECT response_time_ms FROM response_metrics
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?
     ORDER BY response_time_ms`,
    folder, weekStart, weekEnd,
  );

  const prevRows = safeAll<{ response_time_ms: number }>(
    db, 'response_metrics',
    `SELECT response_time_ms FROM response_metrics
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?
     ORDER BY response_time_ms`,
    folder, prevStart, prevEnd,
  );

  const times = rows.map(r => r.response_time_ms);
  const prevTimes = prevRows.map(r => r.response_time_ms);

  const replyRow = safeGet<{ total: number; replied: number }>(
    db, 'response_metrics',
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN customer_replied = 1 THEN 1 ELSE 0 END) as replied
     FROM response_metrics
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?`,
    folder, weekStart, weekEnd,
  );

  return {
    median_ms: round2(median(times)),
    p95_ms: round2(percentile(times, 95)),
    count: times.length,
    reply_rate: safeDiv(replyRow?.replied ?? 0, replyRow?.total ?? 0),
    trend: trendLabel(median(times), median(prevTimes), true),
  };
}

function analyzeConversionFunnel(db: Database.Database, folder: string, weekStart: string, weekEnd: string, prevStart: string, prevEnd: string) {
  // Current week deals by stage
  const stages = safeAll<{ stage: string; cnt: number }>(
    db, 'deals',
    `SELECT stage, COUNT(*) as cnt FROM deals
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?
     GROUP BY stage`,
    folder, weekStart, weekEnd,
  );

  const stageMap: Record<string, number> = {};
  for (const s of stages) stageMap[s.stage] = s.cnt;

  const newLeads = (stageMap['new'] ?? 0) + (stageMap['lead'] ?? 0) + (stageMap['qualified'] ?? 0) + (stageMap['booked'] ?? 0) + (stageMap['won'] ?? 0);
  const qualified = (stageMap['qualified'] ?? 0) + (stageMap['booked'] ?? 0) + (stageMap['won'] ?? 0);
  const booked = (stageMap['booked'] ?? 0) + (stageMap['won'] ?? 0);
  const won = stageMap['won'] ?? 0;

  const newToQualified = safeDiv(qualified, newLeads);
  const qualifiedToBooked = safeDiv(booked, qualified);
  const overall = safeDiv(won, newLeads);

  // Previous week for trend
  const prevStages = safeAll<{ stage: string; cnt: number }>(
    db, 'deals',
    `SELECT stage, COUNT(*) as cnt FROM deals
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?
     GROUP BY stage`,
    folder, prevStart, prevEnd,
  );

  const prevMap: Record<string, number> = {};
  for (const s of prevStages) prevMap[s.stage] = s.cnt;
  const prevNew = (prevMap['new'] ?? 0) + (prevMap['lead'] ?? 0) + (prevMap['qualified'] ?? 0) + (prevMap['booked'] ?? 0) + (prevMap['won'] ?? 0);
  const prevWon = prevMap['won'] ?? 0;
  const prevOverall = safeDiv(prevWon, prevNew);

  return {
    stages: stageMap,
    new_to_qualified: round2(newToQualified),
    qualified_to_booked: round2(qualifiedToBooked),
    overall: round2(overall),
    trend: trendLabel(overall, prevOverall),
  };
}

function analyzeLearningEvents(db: Database.Database, folder: string, weekStart: string, weekEnd: string) {
  const events = safeAll<{ event_type: string; details: string }>(
    db, 'learning_events',
    `SELECT event_type, details FROM learning_events
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?`,
    folder, weekStart, weekEnd,
  );

  const byType: Record<string, number> = {};
  const patterns: string[] = [];

  for (const e of events) {
    byType[e.event_type] = (byType[e.event_type] ?? 0) + 1;
    if (e.event_type === 'conversion_won' || e.event_type === 'conversion_lost') {
      try {
        const d = JSON.parse(e.details);
        if (d.reason) patterns.push(`${e.event_type}: ${d.reason}`);
        if (d.notes) patterns.push(`${e.event_type}: ${d.notes}`);
      } catch { /* ignore malformed JSON */ }
    }
  }

  return { byType, patterns };
}

function analyzeComplaints(db: Database.Database, folder: string, weekStart: string, weekEnd: string) {
  // Open complaints (all time for this group's channels)
  const openRow = safeGet<{ cnt: number }>(
    db, 'complaints',
    `SELECT COUNT(*) as cnt FROM complaints WHERE resolution_status = 'open'`,
  );

  const resolvedRow = safeGet<{ cnt: number }>(
    db, 'complaints',
    `SELECT COUNT(*) as cnt FROM complaints
     WHERE resolved_at >= ? AND resolved_at < ?
       AND resolution_status IN ('resolved', 'refunded')`,
    weekStart, weekEnd,
  );

  const avgRes = safeGet<{ avg_hours: number | null }>(
    db, 'complaints',
    `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) as avg_hours
     FROM complaints
     WHERE resolved_at >= ? AND resolved_at < ?`,
    weekStart, weekEnd,
  );

  const topCat = safeGet<{ category: string; cnt: number }>(
    db, 'complaints',
    `SELECT category, COUNT(*) as cnt FROM complaints
     WHERE created_at >= ? AND created_at < ?
     GROUP BY category ORDER BY cnt DESC LIMIT 1`,
    weekStart, weekEnd,
  );

  return {
    open: openRow?.cnt ?? 0,
    resolved_this_week: resolvedRow?.cnt ?? 0,
    avg_resolution_hours: round2(avgRes?.avg_hours ?? null),
    top_category: topCat?.category ?? null,
  };
}

function analyzeOutreach(db: Database.Database, folder: string, weekStart: string, weekEnd: string) {
  const row = safeGet<{ total: number; replied: number; bounced: number }>(
    db, 'outreach_log',
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN response_at IS NOT NULL THEN 1 ELSE 0 END) as replied,
       SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) as bounced
     FROM outreach_log
     WHERE sent_at >= ? AND sent_at < ?`,
    weekStart, weekEnd,
  );

  const total = row?.total ?? 0;
  return {
    sent: total,
    reply_rate: round2(safeDiv(row?.replied ?? 0, total)),
    bounce_rate: round2(safeDiv(row?.bounced ?? 0, total)),
  };
}

function analyzeTaskHealth(db: Database.Database, folder: string, weekStart: string, weekEnd: string) {
  const rows = safeAll<{ task_id: string; status: string }>(
    db, 'task_run_logs',
    `SELECT task_id, status FROM task_run_logs
     WHERE run_at >= ? AND run_at < ?`,
    weekStart, weekEnd,
  );

  const total = rows.length;
  const errors = rows.filter(r => r.status === 'error' || r.status === 'failed').length;
  const failingSet = new Set<string>();
  for (const r of rows) {
    if (r.status === 'error' || r.status === 'failed') failingSet.add(r.task_id);
  }

  return {
    total_runs: total,
    error_rate: round2(safeDiv(errors, total)),
    failing_tasks: Array.from(failingSet),
  };
}

function analyzeCost(db: Database.Database, folder: string, weekStart: string, weekEnd: string, conversationCount: number, conversionCount: number) {
  const rows = safeAll<{ model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number }>(
    db, 'usage_log',
    `SELECT model, input_tokens, output_tokens, cache_read_tokens FROM usage_log
     WHERE group_folder = ? AND timestamp >= ? AND timestamp < ?`,
    folder, weekStart, weekEnd,
  );

  let totalUsd = 0;
  for (const r of rows) {
    const modelKey = resolveModel(r.model);
    const pricing = MODEL_PRICING[modelKey] ?? MODEL_PRICING.haiku;
    // Cache read tokens are billed at input rate (already included in input_tokens for most setups,
    // but if tracked separately, they cost the same as input)
    const inputCost = ((r.input_tokens + (r.cache_read_tokens ?? 0)) / 1_000_000) * pricing.input;
    const outputCost = (r.output_tokens / 1_000_000) * pricing.output;
    totalUsd += inputCost + outputCost;
  }

  return {
    total_usd: round2(totalUsd) ?? 0,
    per_conversation: round2(safeDiv(totalUsd, conversationCount)),
    per_conversion: round2(safeDiv(totalUsd, conversionCount)),
  };
}

// ---------------------------------------------------------------------------
// A/B Testing - Proportion Z-Test
// ---------------------------------------------------------------------------

function analyzeExperiments(db: Database.Database): ExperimentResult[] {
  if (!tableExists(db, 'message_variants')) return [];

  const variants = safeAll<VariantRow>(
    db, 'message_variants',
    `SELECT * FROM message_variants WHERE status = 'active' ORDER BY category, variant_name`,
  );

  // Group by category
  const byCategory: Record<string, VariantRow[]> = {};
  for (const v of variants) {
    if (!byCategory[v.category]) byCategory[v.category] = [];
    byCategory[v.category].push(v);
  }

  const results: ExperimentResult[] = [];

  for (const [category, categoryVariants] of Object.entries(byCategory)) {
    if (categoryVariants.length < 2) continue;

    // Find leader by conversion rate
    let leader: VariantRow | null = null;
    let leaderRate = -1;
    let totalSample = 0;

    for (const v of categoryVariants) {
      totalSample += v.times_used;
      const rate = v.times_used > 0 ? v.times_converted / v.times_used : 0;
      if (rate > leaderRate) {
        leaderRate = rate;
        leader = v;
      }
    }

    if (!leader) continue;

    const hasSufficientData = categoryVariants.every(v => v.times_used >= 50);

    results.push({
      category,
      leader: leader.variant_name,
      conversion_pct: round2(leaderRate * 100) ?? 0,
      sample_size: totalSample,
      status: hasSufficientData ? 'sufficient_data' : 'needs_more_data',
    });
  }

  return results;
}

function graduateWinners(db: Database.Database, projectRoot: string, folder: string): string[] {
  if (!tableExists(db, 'message_variants')) return [];

  const variants = safeAll<VariantRow>(
    db, 'message_variants',
    `SELECT * FROM message_variants WHERE status = 'active' ORDER BY category, variant_name`,
  );

  const byCategory: Record<string, VariantRow[]> = {};
  for (const v of variants) {
    if (!byCategory[v.category]) byCategory[v.category] = [];
    byCategory[v.category].push(v);
  }

  const graduatedInsights: string[] = [];

  for (const [category, categoryVariants] of Object.entries(byCategory)) {
    if (categoryVariants.length < 2) continue;
    if (!categoryVariants.every(v => v.times_used >= 50)) continue;

    // Run pairwise z-tests to find winner
    let winner: VariantRow | null = null;
    let winnerBeatsAll = true;

    // Sort by conversion rate descending
    const sorted = [...categoryVariants].sort((a, b) => {
      const rateA = a.times_used > 0 ? a.times_converted / a.times_used : 0;
      const rateB = b.times_used > 0 ? b.times_converted / b.times_used : 0;
      return rateB - rateA;
    });

    const candidate = sorted[0];
    const p1 = candidate.times_converted / candidate.times_used;

    for (let i = 1; i < sorted.length; i++) {
      const other = sorted[i];
      const p2 = other.times_used > 0 ? other.times_converted / other.times_used : 0;
      const pPool = (candidate.times_converted + other.times_converted) / (candidate.times_used + other.times_used);

      if (pPool === 0 || pPool === 1) continue;

      const se = Math.sqrt(pPool * (1 - pPool) * (1 / candidate.times_used + 1 / other.times_used));
      if (se === 0) continue;

      const z = (p1 - p2) / se;
      if (Math.abs(z) <= 1.96) {
        winnerBeatsAll = false;
        break;
      }
    }

    if (winnerBeatsAll) {
      winner = candidate;

      // Graduate: mark winner, retire losers
      try {
        db.prepare(`UPDATE message_variants SET status = 'winner' WHERE id = ?`).run(winner.id);
        for (const v of categoryVariants) {
          if (v.id !== winner.id) {
            db.prepare(`UPDATE message_variants SET status = 'retired' WHERE id = ?`).run(v.id);
          }
        }
      } catch (e) {
        console.error(`  Failed to update variant statuses for ${category}:`, e);
      }

      const convPct = round2(p1 * 100);
      const insight = `A/B test winner for "${category}": "${winner.variant_name}" with ${convPct}% conversion rate (n=${winner.times_used}, p<0.05)`;
      graduatedInsights.push(insight);
      console.log(`  Graduated: ${insight}`);
    }
  }

  return graduatedInsights;
}

// ---------------------------------------------------------------------------
// Recommendations engine
// ---------------------------------------------------------------------------

function generateRecommendations(insights: PerformanceInsights): string[] {
  const recs: string[] = [];

  // Response time
  if (insights.response_time.median_ms !== null && insights.response_time.median_ms > 10000) {
    recs.push(`Median response time is ${Math.round(insights.response_time.median_ms / 1000)}s - consider caching common responses or using a faster model for simple queries.`);
  }
  if (insights.response_time.trend === 'declining') {
    recs.push('Response times are trending slower vs last week. Investigate whether message complexity has increased or system load is higher.');
  }

  // Funnel
  if (insights.conversion_funnel.new_to_qualified !== null && insights.conversion_funnel.new_to_qualified < 0.3) {
    recs.push(`Lead qualification rate is ${Math.round((insights.conversion_funnel.new_to_qualified ?? 0) * 100)}% - review initial response templates to better capture interest.`);
  }
  if (insights.conversion_funnel.trend === 'declining') {
    recs.push('Conversion funnel is trending downward. Review recent lost deals for common objections.');
  }

  // Complaints
  if (insights.complaints.open > 5) {
    recs.push(`${insights.complaints.open} open complaints need attention. Prioritize resolution to prevent churn.`);
  }

  // Outreach
  if (insights.outreach.reply_rate !== null && insights.outreach.sent > 20 && insights.outreach.reply_rate < 0.05) {
    recs.push(`Outreach reply rate is ${Math.round((insights.outreach.reply_rate ?? 0) * 100)}% - test different subject lines or sending times.`);
  }
  if (insights.outreach.bounce_rate !== null && insights.outreach.bounce_rate > 0.05) {
    recs.push(`Bounce rate is ${Math.round((insights.outreach.bounce_rate ?? 0) * 100)}% - clean your contact list to protect sender reputation.`);
  }

  // Cost
  if (insights.cost.per_conversation !== null && insights.cost.per_conversation > 0.50) {
    recs.push(`Cost per conversation ($${insights.cost.per_conversation}) is high. Consider routing simple queries to haiku.`);
  }

  // Task health
  if (insights.task_health.error_rate !== null && insights.task_health.error_rate > 0.1) {
    recs.push(`Task error rate is ${Math.round((insights.task_health.error_rate ?? 0) * 100)}% - check failing tasks: ${insights.task_health.failing_tasks.join(', ')}.`);
  }

  // Experiments
  const needsData = insights.experiments.filter(e => e.status === 'needs_more_data');
  if (needsData.length > 0) {
    recs.push(`${needsData.length} A/B test(s) still collecting data. Ensure traffic is being split evenly.`);
  }

  // Keep to 2-5 recommendations
  return recs.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Lessons.md management
// ---------------------------------------------------------------------------

function appendLessons(projectRoot: string, folder: string, insights: PerformanceInsights, graduatedInsights: string[], learningPatterns: string[]) {
  const lessonsPath = path.join(projectRoot, 'groups', folder, 'lessons.md');
  let existingContent = '';
  if (fs.existsSync(lessonsPath)) {
    existingContent = fs.readFileSync(lessonsPath, 'utf-8');
  }

  const today = isoDate(new Date());
  const newEntries: string[] = [];

  // Add graduated A/B test insights
  for (const insight of graduatedInsights) {
    if (!existingContent.includes(insight.substring(0, 40))) {
      newEntries.push(`- [${today}] Conversion & Sales: ${insight}`);
    }
  }

  // Add data-backed observations
  if (insights.response_time.trend === 'improving' && insights.response_time.count > 20) {
    const entry = `Response times improved - median ${insights.response_time.median_ms}ms`;
    if (!existingContent.includes('Response times improved')) {
      newEntries.push(`- [${today}] Efficiency: ${entry}`);
    }
  }

  if (insights.conversion_funnel.overall !== null && insights.conversion_funnel.overall > 0.2 && insights.conversion_funnel.trend === 'improving') {
    const entry = `Conversion rate at ${Math.round((insights.conversion_funnel.overall ?? 0) * 100)}% and improving`;
    if (!existingContent.includes('Conversion rate at')) {
      newEntries.push(`- [${today}] Conversion & Sales: ${entry}`);
    }
  }

  if (insights.complaints.avg_resolution_hours !== null && insights.complaints.avg_resolution_hours < 2) {
    const entry = `Complaint resolution averaging ${insights.complaints.avg_resolution_hours} hours`;
    if (!existingContent.includes('Complaint resolution averaging')) {
      newEntries.push(`- [${today}] Customer Service: ${entry}`);
    }
  }

  if (insights.outreach.reply_rate !== null && insights.outreach.reply_rate > 0.1 && insights.outreach.sent > 30) {
    const entry = `Outreach reply rate at ${Math.round((insights.outreach.reply_rate ?? 0) * 100)}% (${insights.outreach.sent} sent)`;
    if (!existingContent.includes('Outreach reply rate at')) {
      newEntries.push(`- [${today}] Channel Performance: ${entry}`);
    }
  }

  // Add unique learning patterns
  const seen = new Set<string>();
  for (const pattern of learningPatterns) {
    const key = pattern.substring(0, 50);
    if (!seen.has(key) && !existingContent.includes(key)) {
      seen.add(key);
      const cat = pattern.startsWith('conversion_won') ? 'Conversion & Sales' : 'Customer Service';
      newEntries.push(`- [${today}] ${cat}: ${pattern}`);
    }
  }

  if (newEntries.length === 0) {
    console.log('  No new lessons to add.');
    return;
  }

  // Ensure file exists with header
  if (!existingContent) {
    existingContent = '# Lessons Learned\n\nData-backed insights from performance analysis.\n\n';
  }

  const appendText = '\n' + newEntries.join('\n') + '\n';
  fs.writeFileSync(lessonsPath, existingContent + appendText, 'utf-8');
  console.log(`  Added ${newEntries.length} new lesson(s) to lessons.md`);
}

// ---------------------------------------------------------------------------
// Mark learning events processed
// ---------------------------------------------------------------------------

function markEventsProcessed(db: Database.Database, folder: string, weekEnd: string) {
  if (!tableExists(db, 'learning_events')) return;
  try {
    const result = db.prepare(
      `UPDATE learning_events SET processed = 1
       WHERE group_folder = ? AND processed = 0 AND created_at < ?`,
    ).run(folder, weekEnd);
    console.log(`  Marked ${result.changes} learning event(s) as processed.`);
  } catch (e) {
    console.error('  Failed to mark events processed:', e);
  }
}

// ---------------------------------------------------------------------------
// Main analysis for a single group
// ---------------------------------------------------------------------------

function analyzeGroup(db: Database.Database, folder: string, projectRoot: string) {
  console.log(`\nAnalyzing group: ${folder}`);

  const now = new Date();
  const weekEnd = now.toISOString();
  const weekStart = daysBefore(7).toISOString();
  const prevEnd = daysBefore(7).toISOString();
  const prevStart = daysBefore(14).toISOString();

  const periodStr = `${isoDate(daysBefore(7))} to ${isoDate(now)}`;

  // Run all analyses
  console.log('  Computing response metrics...');
  const responseMetrics = analyzeResponseMetrics(db, folder, weekStart, weekEnd, prevStart, prevEnd);

  console.log('  Computing conversion funnel...');
  const funnel = analyzeConversionFunnel(db, folder, weekStart, weekEnd, prevStart, prevEnd);

  console.log('  Analyzing learning events...');
  const learning = analyzeLearningEvents(db, folder, weekStart, weekEnd);

  console.log('  Analyzing complaints...');
  const complaints = analyzeComplaints(db, folder, weekStart, weekEnd);

  console.log('  Analyzing outreach...');
  const outreach = analyzeOutreach(db, folder, weekStart, weekEnd);

  console.log('  Checking task health...');
  const taskHealth = analyzeTaskHealth(db, folder, weekStart, weekEnd);

  // Count conversations for cost calc
  const convRow = safeGet<{ cnt: number }>(
    db, 'response_metrics',
    `SELECT COUNT(DISTINCT chat_jid) as cnt FROM response_metrics
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?`,
    folder, weekStart, weekEnd,
  );
  const conversationCount = convRow?.cnt ?? 0;

  // Count conversions (won deals)
  const wonRow = safeGet<{ cnt: number }>(
    db, 'deals',
    `SELECT COUNT(*) as cnt FROM deals
     WHERE group_folder = ? AND stage = 'won' AND updated_at >= ? AND updated_at < ?`,
    folder, weekStart, weekEnd,
  );
  const conversionCount = wonRow?.cnt ?? 0;

  console.log('  Computing cost...');
  const cost = analyzeCost(db, folder, weekStart, weekEnd, conversationCount, conversionCount);

  console.log('  Analyzing experiments...');
  const experiments = analyzeExperiments(db);

  // Build insights object
  const insights: PerformanceInsights = {
    generated_at: now.toISOString(),
    period: periodStr,
    response_time: {
      median_ms: responseMetrics.median_ms,
      p95_ms: responseMetrics.p95_ms,
      count: responseMetrics.count,
      trend: responseMetrics.trend,
    },
    conversion_funnel: {
      new_to_qualified: funnel.new_to_qualified,
      qualified_to_booked: funnel.qualified_to_booked,
      overall: funnel.overall,
      trend: funnel.trend,
    },
    complaints,
    outreach,
    cost,
    task_health: taskHealth,
    experiments,
    recommendations: [], // Filled below
  };

  insights.recommendations = generateRecommendations(insights);

  // Graduate A/B test winners
  console.log('  Checking for A/B test winners to graduate...');
  const graduatedInsights = graduateWinners(db, projectRoot, folder);

  // Update experiment statuses for graduated ones
  for (const exp of insights.experiments) {
    if (graduatedInsights.some(g => g.includes(exp.category))) {
      exp.status = 'winner_graduated';
    }
  }

  // Write performance-insights.json
  const groupDir = path.join(projectRoot, 'groups', folder);
  if (!fs.existsSync(groupDir)) {
    console.log(`  Group directory not found: ${groupDir}, skipping file writes.`);
    return;
  }

  const insightsPath = path.join(groupDir, 'performance-insights.json');
  fs.writeFileSync(insightsPath, JSON.stringify(insights, null, 2), 'utf-8');
  console.log(`  Wrote ${insightsPath}`);

  // Append to lessons.md
  console.log('  Updating lessons.md...');
  appendLessons(projectRoot, folder, insights, graduatedInsights, learning.patterns);

  // Mark learning events as processed
  markEventsProcessed(db, folder, weekEnd);

  console.log(`  Done with ${folder}.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const allGroups = hasFlag(args, '--all-groups');
  const singleGroup = parseFlag(args, '--group');

  if (!allGroups && !singleGroup) {
    console.error('Usage: npx tsx tools/learning/analyze-performance.ts --all-groups');
    console.error('       npx tsx tools/learning/analyze-performance.ts --group <folder>');
    process.exit(1);
  }

  const db = getDb();
  const projectRoot = getProjectRoot();

  let folders: string[];

  if (singleGroup) {
    folders = [singleGroup];
  } else {
    // Get all registered groups
    const groups = safeAll<{ folder: string }>(
      db, 'registered_groups',
      `SELECT folder FROM registered_groups`,
    );

    if (groups.length === 0) {
      // Fallback: scan groups directory
      const groupsDir = path.join(projectRoot, 'groups');
      if (fs.existsSync(groupsDir)) {
        folders = fs.readdirSync(groupsDir).filter(f => {
          const full = path.join(groupsDir, f);
          return fs.statSync(full).isDirectory();
        });
      } else {
        console.error('No registered groups found and groups/ directory missing.');
        process.exit(1);
      }
    } else {
      folders = groups.map(g => g.folder);
    }
  }

  console.log(`Performance analysis starting for ${folders.length} group(s): ${folders.join(', ')}`);
  console.log(`Period: last 7 days`);

  for (const folder of folders) {
    try {
      analyzeGroup(db, folder, projectRoot);
    } catch (e) {
      console.error(`Error analyzing group ${folder}:`, e);
    }
  }

  db.close();
  console.log('\nPerformance analysis complete.');
}

main();
