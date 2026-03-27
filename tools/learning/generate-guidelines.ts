#!/usr/bin/env npx tsx
/**
 * Adaptive Guidelines Generator
 * Reads performance data from the DB and writes adaptive-guidelines.md per group.
 *
 * Usage:
 *   npx tsx tools/learning/generate-guidelines.ts --all-groups
 *   npx tsx tools/learning/generate-guidelines.ts --group <folder>
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import { resolveGroupDir } from '../shared/group-path.js';
import fs from 'fs';
import path from 'path';

interface RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
}

interface StageConversion {
  from_stage: string;
  to_stage: string;
  count: number;
}

interface ChannelMetrics {
  channel: string;
  total: number;
  replied: number;
  reply_rate: number;
  median_response_ms: number;
}

interface MessageVariant {
  category: string;
  variant_name: string;
  times_used: number;
  times_converted: number;
  times_replied: number;
  status: string;
}

interface LengthBucket {
  bucket: string;
  channel: string;
  total: number;
  replied: number;
  reply_rate: number;
}

interface TaskFailure {
  task_id: string;
  fail_count: number;
  last_error: string | null;
}

interface ComplaintSpike {
  category: string;
  count: number;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}

function sevenDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function computeStageConversions(db: Database.Database, folder: string, since: string): StageConversion[] {
  return db.prepare(`
    SELECT from_stage, to_stage, COUNT(*) as count
    FROM deal_stage_log dsl
    JOIN deals d ON dsl.deal_id = d.id
    WHERE d.group_folder = ? AND dsl.changed_at >= ? AND dsl.from_stage IS NOT NULL
    GROUP BY from_stage, to_stage
  `).all(folder, since) as StageConversion[];
}

function findWeakestStage(conversions: StageConversion[]): string | null {
  const stages = ['new', 'qualified', 'appointment_booked', 'proposal'];
  const nextMap: Record<string, string[]> = {
    new: ['qualified'],
    qualified: ['appointment_booked'],
    appointment_booked: ['proposal'],
    proposal: ['closed_won'],
  };

  let worstRate = Infinity;
  let worstStage: string | null = null;

  for (const stage of stages) {
    const forward = nextMap[stage] || [];
    const totalOut = conversions.filter(c => c.from_stage === stage).reduce((s, c) => s + c.count, 0);
    const goodOut = conversions
      .filter(c => c.from_stage === stage && forward.includes(c.to_stage))
      .reduce((s, c) => s + c.count, 0);

    if (totalOut > 0) {
      const rate = goodOut / totalOut;
      if (rate < worstRate) {
        worstRate = rate;
        worstStage = stage;
      }
    }
  }

  if (worstStage && worstRate < Infinity) {
    return `${worstStage} → next stage conversion is ${Math.round(worstRate * 100)}%`;
  }
  return null;
}

function getChannelPerformance(db: Database.Database, folder: string, since: string): ChannelMetrics[] {
  const rows = db.prepare(`
    SELECT
      channel,
      COUNT(*) as total,
      SUM(CASE WHEN customer_replied = 1 THEN 1 ELSE 0 END) as replied,
      response_time_ms
    FROM response_metrics
    WHERE group_folder = ? AND created_at >= ?
    GROUP BY channel
  `).all(folder, since) as Array<{ channel: string; total: number; replied: number; response_time_ms: number }>;

  // Get median response time per channel
  const result: ChannelMetrics[] = [];
  for (const row of rows) {
    const times = db.prepare(`
      SELECT response_time_ms FROM response_metrics
      WHERE group_folder = ? AND channel = ? AND created_at >= ? AND response_time_ms IS NOT NULL
      ORDER BY response_time_ms
    `).all(folder, row.channel, since) as Array<{ response_time_ms: number }>;

    const median = times.length > 0 ? times[Math.floor(times.length / 2)].response_time_ms : 0;

    result.push({
      channel: row.channel,
      total: row.total,
      replied: row.replied,
      reply_rate: row.total > 0 ? row.replied / row.total : 0,
      median_response_ms: median,
    });
  }

  return result.sort((a, b) => b.reply_rate - a.reply_rate);
}

function getMessageVariantWinners(db: Database.Database): MessageVariant[] {
  return db.prepare(`
    SELECT category, variant_name, times_used, times_converted, times_replied, status
    FROM message_variants
    WHERE status = 'winner' OR (times_used >= 20 AND times_replied * 1.0 / times_used > 0.3)
    ORDER BY times_replied * 1.0 / NULLIF(times_used, 0) DESC
    LIMIT 5
  `).all() as MessageVariant[];
}

function getActiveExperiments(db: Database.Database): MessageVariant[] {
  return db.prepare(`
    SELECT category, variant_name, times_used, times_converted, times_replied, status
    FROM message_variants
    WHERE status = 'active' OR status = 'testing'
    ORDER BY category, variant_name
  `).all() as MessageVariant[];
}

function analyzeLengthBuckets(db: Database.Database, folder: string, since: string): LengthBucket[] {
  return db.prepare(`
    SELECT
      CASE
        WHEN message_length <= 160 THEN 'short (≤160)'
        WHEN message_length <= 320 THEN 'medium (161-320)'
        ELSE 'long (>320)'
      END as bucket,
      channel,
      COUNT(*) as total,
      SUM(CASE WHEN customer_replied = 1 THEN 1 ELSE 0 END) as replied
    FROM response_metrics
    WHERE group_folder = ? AND created_at >= ?
    GROUP BY bucket, channel
    HAVING total >= 5
    ORDER BY channel, bucket
  `).all(folder, since) as LengthBucket[];
}

function getFailingTasks(db: Database.Database, since: string): TaskFailure[] {
  return db.prepare(`
    SELECT task_id, COUNT(*) as fail_count,
      (SELECT error FROM task_run_logs t2
       WHERE t2.task_id = t1.task_id AND t2.status = 'error'
       ORDER BY run_at DESC LIMIT 1) as last_error
    FROM task_run_logs t1
    WHERE status = 'error' AND run_at >= ?
    GROUP BY task_id
    HAVING fail_count >= 3
    ORDER BY fail_count DESC
  `).all(since) as TaskFailure[];
}

function getComplaintSpikes(db: Database.Database, since: string): ComplaintSpike[] {
  return db.prepare(`
    SELECT category, COUNT(*) as count
    FROM complaints
    WHERE created_at >= ?
    GROUP BY category
    HAVING count >= 3
    ORDER BY count DESC
  `).all(since) as ComplaintSpike[];
}

function getDealFocusInsights(db: Database.Database, folder: string, since: string): string[] {
  const insights: string[] = [];

  // Overall conversion rates per stage
  const stages = ['new', 'qualified', 'appointment_booked', 'proposal'];
  const nextStage: Record<string, string> = {
    new: 'qualified',
    qualified: 'appointment_booked',
    appointment_booked: 'proposal',
    proposal: 'closed_won',
  };

  for (const stage of stages) {
    const entered = db.prepare(`
      SELECT COUNT(*) as c FROM deal_stage_log dsl
      JOIN deals d ON dsl.deal_id = d.id
      WHERE d.group_folder = ? AND dsl.to_stage = ? AND dsl.changed_at >= ?
    `).get(folder, stage, since) as { c: number };

    const advanced = db.prepare(`
      SELECT COUNT(*) as c FROM deal_stage_log dsl
      JOIN deals d ON dsl.deal_id = d.id
      WHERE d.group_folder = ? AND dsl.from_stage = ? AND dsl.to_stage = ? AND dsl.changed_at >= ?
    `).get(folder, stage, nextStage[stage], since) as { c: number };

    if (entered.c >= 3) {
      const rate = Math.round((advanced.c / entered.c) * 100);
      if (rate < 40) {
        const label = `${stage} → ${nextStage[stage]}`;
        insights.push(`${label} conversion is ${rate}% — below 40% target. Consider adding a timely follow-up at this stage.`);
      }
    }
  }

  // Response time impact
  const fastDeals = db.prepare(`
    SELECT COUNT(*) as c FROM response_metrics
    WHERE group_folder = ? AND created_at >= ? AND response_time_ms < 3600000 AND customer_replied = 1
  `).get(folder, since) as { c: number };
  const slowDeals = db.prepare(`
    SELECT COUNT(*) as c FROM response_metrics
    WHERE group_folder = ? AND created_at >= ? AND response_time_ms >= 3600000 AND customer_replied = 1
  `).get(folder, since) as { c: number };
  const fastTotal = db.prepare(`
    SELECT COUNT(*) as c FROM response_metrics
    WHERE group_folder = ? AND created_at >= ? AND response_time_ms < 3600000
  `).get(folder, since) as { c: number };
  const slowTotal = db.prepare(`
    SELECT COUNT(*) as c FROM response_metrics
    WHERE group_folder = ? AND created_at >= ? AND response_time_ms >= 3600000
  `).get(folder, since) as { c: number };

  if (fastTotal.c >= 5 && slowTotal.c >= 5) {
    const fastRate = fastDeals.c / fastTotal.c;
    const slowRate = slowDeals.c / slowTotal.c;
    if (fastRate > slowRate * 1.5) {
      insights.push(
        `Responses under 1 hour have ${Math.round(fastRate * 100)}% reply rate vs ${Math.round(slowRate * 100)}% for slower responses — prioritize speed.`,
      );
    }
  }

  return insights;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}

function generateForGroup(db: Database.Database, folder: string, groupsDir: string): void {
  const since = sevenDaysAgo();

  // --- Current Focus Areas ---
  const focusAreas: string[] = [];
  const conversions = computeStageConversions(db, folder, since);
  const weakest = findWeakestStage(conversions);
  if (weakest) focusAreas.push(weakest);
  const dealInsights = getDealFocusInsights(db, folder, since);
  focusAreas.push(...dealInsights);

  // --- What's Working ---
  const working: string[] = [];
  const channels = getChannelPerformance(db, folder, since);
  if (channels.length > 0) {
    const best = channels[0];
    if (best.reply_rate > 0) {
      working.push(
        `${best.channel} channel has ${Math.round(best.reply_rate * 100)}% reply rate` +
          (channels.length > 1
            ? ` vs ${Math.round(channels[channels.length - 1].reply_rate * 100)}% for ${channels[channels.length - 1].channel}`
            : '') +
          ` — prefer ${best.channel} for follow-ups`,
      );
    }
  }

  const winners = getMessageVariantWinners(db);
  for (const w of winners) {
    const rate = w.times_used > 0 ? Math.round((w.times_replied / w.times_used) * 100) : 0;
    working.push(`"${w.variant_name}" (${w.category}) has ${rate}% reply rate over ${w.times_used} sends`);
  }

  // --- What to Stop ---
  const stop: string[] = [];
  const lengthBuckets = analyzeLengthBuckets(db, folder, since);
  for (const bucket of lengthBuckets) {
    bucket.reply_rate = bucket.total > 0 ? bucket.replied / bucket.total : 0;
  }

  // Find channels where long messages perform significantly worse
  const channelNames = [...new Set(lengthBuckets.map(b => b.channel))];
  for (const ch of channelNames) {
    const chBuckets = lengthBuckets.filter(b => b.channel === ch);
    const longBucket = chBuckets.find(b => b.bucket === 'long (>320)');
    const shortBucket = chBuckets.find(b => b.bucket === 'short (≤160)');
    if (longBucket && shortBucket && shortBucket.reply_rate > 0) {
      const diff = Math.round((1 - longBucket.reply_rate / shortBucket.reply_rate) * 100);
      if (diff > 25) {
        stop.push(
          `Long messages (>320 chars) on ${ch} have ${diff}% lower reply rate than short messages — keep it concise`,
        );
      }
    }
  }

  // --- Active Experiments ---
  const experiments = getActiveExperiments(db);
  const experimentLines: string[] = [];
  for (const exp of experiments) {
    const remaining = Math.max(0, 30 - exp.times_used);
    experimentLines.push(
      `Testing "${exp.variant_name}" (${exp.category}) — ${exp.times_used} data points, need ${remaining} more before conclusion`,
    );
  }

  // --- Channel Performance ---
  const channelLines: string[] = [];
  for (const ch of channels) {
    channelLines.push(
      `- ${ch.channel}: ${Math.round(ch.reply_rate * 100)}% reply rate, ${formatMs(ch.median_response_ms)} median response`,
    );
  }

  // --- Risk Alerts ---
  const risks: string[] = [];
  const failingTasks = getFailingTasks(db, since);
  for (const t of failingTasks) {
    risks.push(`Task "${t.task_id}" failed ${t.fail_count} times${t.last_error ? ` — last error: ${t.last_error}` : ''}`);
  }
  const complaintSpikes = getComplaintSpikes(db, since);
  for (const c of complaintSpikes) {
    risks.push(`"${c.category}" complaints spiking: ${c.count} in the last 7 days`);
  }

  // --- Build the markdown ---
  const lines: string[] = [];
  lines.push('# Adaptive Guidelines');
  lines.push(`_Auto-generated from performance data. Last updated: ${today()}_`);
  lines.push('');

  lines.push('## Current Focus Areas');
  if (focusAreas.length > 0) {
    for (const f of focusAreas) lines.push(`- ${f}`);
  } else {
    lines.push('- No significant issues detected in the last 7 days');
  }
  lines.push('');

  lines.push("## What's Working");
  if (working.length > 0) {
    for (const w of working) lines.push(`- ${w}`);
  } else {
    lines.push('- Not enough data yet to identify winners');
  }
  lines.push('');

  lines.push('## What to Stop');
  if (stop.length > 0) {
    for (const s of stop) lines.push(`- ${s}`);
  } else {
    lines.push('- No anti-patterns detected yet');
  }
  lines.push('');

  lines.push('## Active Experiments');
  if (experimentLines.length > 0) {
    for (const e of experimentLines) lines.push(`- ${e}`);
  } else {
    lines.push('- No active experiments');
  }
  lines.push('');

  lines.push('## Channel Performance');
  if (channelLines.length > 0) {
    for (const c of channelLines) lines.push(c);
  } else {
    lines.push('- No channel data in the last 7 days');
  }
  lines.push('');

  lines.push('## Risk Alerts');
  if (risks.length > 0) {
    for (const r of risks) lines.push(`- ${r}`);
  } else {
    lines.push('- No risks detected');
  }
  lines.push('');

  // Write the file
  const outDir = resolveGroupDir(folder);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, 'adaptive-guidelines.md');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`Wrote ${outPath}`);
}

function main() {
  const args = process.argv.slice(2);
  const allGroups = args.includes('--all-groups');
  const singleGroup = parseFlag(args, '--group');

  if (!allGroups && !singleGroup) {
    console.error('Usage: generate-guidelines.ts --all-groups | --group <folder>');
    process.exit(1);
  }

  const db = getDb();

  // Resolve groups directory relative to project root
  const projectRoot = path.resolve(path.dirname(getDbPath()), '..');
  const groupsDir = path.join(projectRoot, 'groups');

  if (allGroups) {
    const groups = db.prepare('SELECT jid, name, folder FROM registered_groups').all() as RegisteredGroup[];
    if (groups.length === 0) {
      console.log('No registered groups found.');
      db.close();
      return;
    }
    for (const g of groups) {
      try {
        generateForGroup(db, g.folder, groupsDir);
      } catch (err) {
        console.error(`Error generating guidelines for ${g.folder}:`, err);
      }
    }
    console.log(`Generated guidelines for ${groups.length} group(s).`);
  } else if (singleGroup) {
    generateForGroup(db, singleGroup, groupsDir);
  }

  db.close();
}

main();
