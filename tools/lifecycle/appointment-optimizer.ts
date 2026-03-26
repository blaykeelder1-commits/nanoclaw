#!/usr/bin/env npx tsx
/**
 * Appointment No-Show Detector & Follow-Up Recommender
 * Usage:
 *   npx tsx tools/lifecycle/appointment-optimizer.ts --all-groups
 *   npx tsx tools/lifecycle/appointment-optimizer.ts --group <folder>
 *
 * Finds deals stuck at appointment_booked for 2+ days with no stage advancement,
 * skips contacts who already received a follow-up in the last 2 days,
 * and outputs recommended follow-up actions as JSON to stdout.
 * Summary stats are printed to stderr.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';

interface NoShowResult {
  type: 'no_show';
  deal_id: string;
  contact_id: string;
  contact_name: string;
  company: string;
  group_folder: string;
  appointment_date: string;
  days_since: number;
  channel: string;
  suggested_message: string;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}

function getGroupFolders(db: Database.Database, specificGroup?: string): string[] {
  if (specificGroup) return [specificGroup];

  const rows = db.prepare(
    "SELECT DISTINCT group_folder FROM deals WHERE stage = 'appointment_booked'",
  ).all() as Array<{ group_folder: string }>;

  return rows.map(r => r.group_folder);
}

function generateMessage(firstName: string): string {
  return `Hey ${firstName}, looks like we missed each other. Want to reschedule? I've got openings this week.`;
}

function detectNoShows(db: Database.Database, groupFolder: string): NoShowResult[] {
  const results: NoShowResult[] = [];
  const now = Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

  // Find deals at appointment_booked stage for this group
  const deals = db.prepare(`
    SELECT d.id, d.contact_id, d.group_folder,
           c.first_name, c.last_name, c.company, c.channel_source
    FROM deals d
    LEFT JOIN contacts c ON d.contact_id = c.id
    WHERE d.stage = 'appointment_booked'
      AND d.group_folder = ?
  `).all(groupFolder) as Array<{
    id: string;
    contact_id: string;
    group_folder: string;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    channel_source: string | null;
  }>;

  for (const deal of deals) {
    // Get the timestamp when deal moved to appointment_booked
    const stageEntry = db.prepare(`
      SELECT changed_at FROM deal_stage_log
      WHERE deal_id = ? AND to_stage = 'appointment_booked'
      ORDER BY changed_at DESC
      LIMIT 1
    `).get(deal.id) as { changed_at: string } | undefined;

    if (!stageEntry) continue;

    const appointmentDate = new Date(stageEntry.changed_at);
    const elapsed = now - appointmentDate.getTime();

    // Must be 2+ days since appointment_booked transition
    if (elapsed < twoDaysMs) continue;

    // Check there's no stage advancement after the appointment_booked entry
    const laterAdvancement = db.prepare(`
      SELECT 1 FROM deal_stage_log
      WHERE deal_id = ?
        AND changed_at > ?
        AND to_stage != 'appointment_booked'
      LIMIT 1
    `).get(deal.id, stageEntry.changed_at);

    if (laterAdvancement) continue;

    // Check outreach_log — skip if follow-up sent in last 2 days
    const recentOutreach = db.prepare(`
      SELECT 1 FROM outreach_log
      WHERE contact_id = ?
        AND sent_at > ?
      LIMIT 1
    `).get(deal.contact_id, new Date(now - twoDaysMs).toISOString());

    if (recentOutreach) continue;

    const firstName = deal.first_name || 'there';
    const lastName = deal.last_name || '';
    const contactName = `${firstName}${lastName ? ' ' + lastName : ''}`.trim();
    const daysSince = Math.floor(elapsed / (24 * 60 * 60 * 1000));

    results.push({
      type: 'no_show',
      deal_id: deal.id,
      contact_id: deal.contact_id,
      contact_name: contactName,
      company: deal.company || '',
      group_folder: deal.group_folder,
      appointment_date: appointmentDate.toISOString().split('T')[0],
      days_since: daysSince,
      channel: deal.channel_source || 'whatsapp',
      suggested_message: generateMessage(firstName),
    });
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const allGroups = hasFlag(args, '--all-groups');
  const specificGroup = parseFlag(args, '--group');

  if (!allGroups && !specificGroup) {
    console.error('Usage: appointment-optimizer --all-groups | --group <folder>');
    process.exit(1);
  }

  const db = getDb();

  try {
    const folders = getGroupFolders(db, specificGroup);

    if (folders.length === 0) {
      console.error('[appointment-optimizer] No groups with appointment_booked deals found.');
      console.log(JSON.stringify([]));
      return;
    }

    const allResults: NoShowResult[] = [];

    for (const folder of folders) {
      const results = detectNoShows(db, folder);
      allResults.push(...results);
    }

    // Summary to stderr
    console.error(`[appointment-optimizer] Scanned ${folders.length} group(s): ${folders.join(', ')}`);
    console.error(`[appointment-optimizer] Found ${allResults.length} no-show(s) needing follow-up`);

    if (allResults.length > 0) {
      const byGroup: Record<string, number> = {};
      for (const r of allResults) {
        byGroup[r.group_folder] = (byGroup[r.group_folder] || 0) + 1;
      }
      for (const [group, count] of Object.entries(byGroup)) {
        console.error(`[appointment-optimizer]   ${group}: ${count}`);
      }
    }

    // JSON output to stdout
    console.log(JSON.stringify(allResults, null, 2));
  } finally {
    db.close();
  }
}

main();
