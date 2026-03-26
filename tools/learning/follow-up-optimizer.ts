#!/usr/bin/env npx tsx
/**
 * Follow-Up Optimizer
 * Identifies stale leads and generates follow-up recommendations.
 *
 * Usage:
 *   npx tsx tools/learning/follow-up-optimizer.ts --all-groups
 *   npx tsx tools/learning/follow-up-optimizer.ts --group <folder>
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';

interface StaleDeal {
  id: string;
  contact_id: string;
  group_folder: string;
  stage: string;
  updated_at: string;
  source: string | null;
}

interface FollowUpRecommendation {
  deal_id: string;
  contact_id: string;
  group_folder: string;
  stage: string;
  days_stale: number;
  channel_source: string;
  recommended_action: string;
  last_note: string;
}

const STALE_THRESHOLD_DAYS = 3;
const MAX_FOLLOWUPS_PER_DEAL = 3;
const STALE_STAGES = ['qualified', 'appointment_booked', 'proposal'];

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

function daysBetween(dateStr: string, now: Date): number {
  const d = new Date(dateStr);
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function getStaleDeals(db: Database.Database, folder: string | null): StaleDeal[] {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - STALE_THRESHOLD_DAYS);
  const thresholdISO = threshold.toISOString();

  if (folder) {
    return db.prepare(`
      SELECT id, contact_id, group_folder, stage, updated_at, source
      FROM deals
      WHERE group_folder = ?
        AND stage IN (${STALE_STAGES.map(() => '?').join(', ')})
        AND updated_at < ?
        AND closed_at IS NULL
      ORDER BY updated_at ASC
    `).all(folder, ...STALE_STAGES, thresholdISO) as StaleDeal[];
  }

  return db.prepare(`
    SELECT id, contact_id, group_folder, stage, updated_at, source
    FROM deals
    WHERE stage IN (${STALE_STAGES.map(() => '?').join(', ')})
      AND updated_at < ?
      AND closed_at IS NULL
    ORDER BY updated_at ASC
  `).all(...STALE_STAGES, thresholdISO) as StaleDeal[];
}

function recentFollowUpSent(db: Database.Database, contactId: string): boolean {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const row = db.prepare(`
    SELECT COUNT(*) as c FROM outreach_log
    WHERE contact_id = ? AND type = 'follow_up' AND sent_at >= ?
  `).get(contactId, threeDaysAgo.toISOString()) as { c: number } | undefined;

  return (row?.c ?? 0) > 0;
}

function totalFollowUps(db: Database.Database, contactId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM outreach_log
    WHERE contact_id = ? AND type = 'follow_up'
  `).get(contactId) as { c: number } | undefined;

  return row?.c ?? 0;
}

function getLastNote(db: Database.Database, dealId: string): string {
  const row = db.prepare(`
    SELECT note FROM deal_stage_log
    WHERE deal_id = ? AND note IS NOT NULL
    ORDER BY changed_at DESC
    LIMIT 1
  `).get(dealId) as { note: string } | undefined;

  return row?.note ?? '';
}

function main() {
  const args = process.argv.slice(2);
  const allGroups = args.includes('--all-groups');
  const singleGroup = parseFlag(args, '--group');

  if (!allGroups && !singleGroup) {
    console.error('Usage: follow-up-optimizer.ts --all-groups | --group <folder>');
    process.exit(1);
  }

  const db = getDb();
  const now = new Date();
  const folder = allGroups ? null : singleGroup!;

  const staleDeals = getStaleDeals(db, folder);
  const recommendations: FollowUpRecommendation[] = [];

  for (const deal of staleDeals) {
    // Skip if a follow-up was already sent in the last 3 days
    if (recentFollowUpSent(db, deal.contact_id)) continue;

    // Skip if maximum follow-ups reached
    if (totalFollowUps(db, deal.contact_id) >= MAX_FOLLOWUPS_PER_DEAL) continue;

    const daysStale = daysBetween(deal.updated_at, now);
    const lastNote = getLastNote(db, deal.id);

    recommendations.push({
      deal_id: deal.id,
      contact_id: deal.contact_id,
      group_folder: deal.group_folder,
      stage: deal.stage,
      days_stale: daysStale,
      channel_source: deal.source || 'unknown',
      recommended_action: 'follow_up',
      last_note: lastNote,
    });
  }

  // Sort by staleness (most stale first)
  recommendations.sort((a, b) => b.days_stale - a.days_stale);

  console.log(JSON.stringify(recommendations, null, 2));
  console.error(`\nSummary: ${recommendations.length} follow-up(s) recommended out of ${staleDeals.length} stale deal(s).`);

  db.close();
}

main();
