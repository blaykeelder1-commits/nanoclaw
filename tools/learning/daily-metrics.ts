#!/usr/bin/env npx tsx
/**
 * Daily Metrics Tool for NanoClaw Adaptive Learning
 *
 * Lightweight daily snapshot: computes yesterday's key numbers and writes
 * daily-metrics.json to each group folder.
 *
 * Usage:
 *   npx tsx tools/learning/daily-metrics.ts --all-groups
 *   npx tsx tools/learning/daily-metrics.ts --group snak-group
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getDbPath } from '../shared/db-path.js';
import { resolveGroupDir } from '../shared/group-path.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DailyMetrics {
  generated_at: string;
  date: string;
  messages: {
    received: number;
    sent: number;
  };
  response_time: {
    median_ms: number | null;
  };
  leads: {
    new: number;
  };
  deals: {
    moved: number;
  };
  complaints: {
    opened: number;
    resolved: number;
  };
  cost: {
    total_usd: number;
  };
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

function round2(n: number | null): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(n * 100) / 100;
}

function resolveModel(modelStr: string): string {
  const lower = modelStr.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return 'haiku';
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as { name: string } | undefined;
  return !!row;
}

function safeGet<T = Record<string, unknown>>(db: Database.Database, table: string, sql: string, ...params: unknown[]): T | undefined {
  if (!tableExists(db, table)) return undefined;
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } catch {
    return undefined;
  }
}

function safeAll<T = Record<string, unknown>>(db: Database.Database, table: string, sql: string, ...params: unknown[]): T[] {
  if (!tableExists(db, table)) return [];
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function getProjectRoot(): string {
  if (fs.existsSync('/workspace/project/groups')) return '/workspace/project';
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Compute yesterday's boundaries
// ---------------------------------------------------------------------------

function getYesterdayBounds(): { start: string; end: string; dateStr: string } {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);

  const dateStr = yesterday.toISOString().split('T')[0];
  return {
    start: yesterday.toISOString(),
    end: todayMidnight.toISOString(),
    dateStr,
  };
}

// ---------------------------------------------------------------------------
// Compute daily metrics for a group
// ---------------------------------------------------------------------------

function computeMetrics(db: Database.Database, folder: string): DailyMetrics {
  const { start, end, dateStr } = getYesterdayBounds();

  // Messages received/sent
  const msgRow = safeGet<{ received: number; sent: number }>(
    db, 'messages',
    `SELECT
       SUM(CASE WHEN is_from_me = 0 AND is_bot_message = 0 THEN 1 ELSE 0 END) as received,
       SUM(CASE WHEN is_from_me = 1 OR is_bot_message = 1 THEN 1 ELSE 0 END) as sent
     FROM messages
     WHERE timestamp >= ? AND timestamp < ?`,
    start, end,
  );

  // Response time median
  const rtRows = safeAll<{ response_time_ms: number }>(
    db, 'response_metrics',
    `SELECT response_time_ms FROM response_metrics
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?
     ORDER BY response_time_ms`,
    folder, start, end,
  );

  let medianMs: number | null = null;
  if (rtRows.length > 0) {
    const mid = Math.floor(rtRows.length / 2);
    medianMs = rtRows.length % 2 === 0
      ? (rtRows[mid - 1].response_time_ms + rtRows[mid].response_time_ms) / 2
      : rtRows[mid].response_time_ms;
  }

  // New leads (deals created yesterday with stage 'new' or 'lead')
  const leadRow = safeGet<{ cnt: number }>(
    db, 'deals',
    `SELECT COUNT(*) as cnt FROM deals
     WHERE group_folder = ? AND created_at >= ? AND created_at < ?
       AND stage IN ('new', 'lead')`,
    folder, start, end,
  );

  // Deals moved (stage changes yesterday)
  const movedRow = safeGet<{ cnt: number }>(
    db, 'deal_stage_log',
    `SELECT COUNT(*) as cnt FROM deal_stage_log
     WHERE changed_at >= ? AND changed_at < ?`,
    start, end,
  );

  // Complaints opened/resolved
  const complaintOpenRow = safeGet<{ cnt: number }>(
    db, 'complaints',
    `SELECT COUNT(*) as cnt FROM complaints
     WHERE created_at >= ? AND created_at < ?`,
    start, end,
  );

  const complaintResolvedRow = safeGet<{ cnt: number }>(
    db, 'complaints',
    `SELECT COUNT(*) as cnt FROM complaints
     WHERE resolved_at >= ? AND resolved_at < ?
       AND resolution_status IN ('resolved', 'refunded')`,
    start, end,
  );

  // Cost
  const usageRows = safeAll<{ model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number }>(
    db, 'usage_log',
    `SELECT model, input_tokens, output_tokens, cache_read_tokens FROM usage_log
     WHERE group_folder = ? AND timestamp >= ? AND timestamp < ?`,
    folder, start, end,
  );

  let totalUsd = 0;
  for (const r of usageRows) {
    const modelKey = resolveModel(r.model);
    const pricing = MODEL_PRICING[modelKey] ?? MODEL_PRICING.haiku;
    const inputCost = ((r.input_tokens + (r.cache_read_tokens ?? 0)) / 1_000_000) * pricing.input;
    const outputCost = (r.output_tokens / 1_000_000) * pricing.output;
    totalUsd += inputCost + outputCost;
  }

  return {
    generated_at: new Date().toISOString(),
    date: dateStr,
    messages: {
      received: msgRow?.received ?? 0,
      sent: msgRow?.sent ?? 0,
    },
    response_time: {
      median_ms: round2(medianMs),
    },
    leads: {
      new: leadRow?.cnt ?? 0,
    },
    deals: {
      moved: movedRow?.cnt ?? 0,
    },
    complaints: {
      opened: complaintOpenRow?.cnt ?? 0,
      resolved: complaintResolvedRow?.cnt ?? 0,
    },
    cost: {
      total_usd: round2(totalUsd) ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const allGroups = hasFlag(args, '--all-groups');
  const singleGroup = parseFlag(args, '--group');

  if (!allGroups && !singleGroup) {
    console.error('Usage: npx tsx tools/learning/daily-metrics.ts --all-groups');
    console.error('       npx tsx tools/learning/daily-metrics.ts --group <folder>');
    process.exit(1);
  }

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error('Database not found at', dbPath);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const projectRoot = getProjectRoot();

  let folders: string[];

  if (singleGroup) {
    folders = [singleGroup];
  } else {
    const groups = safeAll<{ folder: string }>(
      db, 'registered_groups',
      `SELECT folder FROM registered_groups`,
    );

    if (groups.length === 0) {
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

  const { dateStr } = getYesterdayBounds();
  console.log(`Daily metrics for ${dateStr} | ${folders.length} group(s): ${folders.join(', ')}`);

  for (const folder of folders) {
    try {
      console.log(`\n  Processing ${folder}...`);
      const metrics = computeMetrics(db, folder);

      const groupDir = resolveGroupDir(folder);
      if (!fs.existsSync(groupDir)) {
        console.log(`  Group directory not found: ${groupDir}, skipping.`);
        continue;
      }

      const outPath = path.join(groupDir, 'daily-metrics.json');
      fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2), 'utf-8');
      console.log(`  Wrote ${outPath}`);
      console.log(`  Messages: ${metrics.messages.received} in / ${metrics.messages.sent} out | Response: ${metrics.response_time.median_ms ?? 'n/a'}ms | Leads: ${metrics.leads.new} | Cost: $${metrics.cost.total_usd}`);
    } catch (e) {
      console.error(`  Error processing ${folder}:`, e);
    }
  }

  db.close();
  console.log('\nDaily metrics complete.');
}

main();
