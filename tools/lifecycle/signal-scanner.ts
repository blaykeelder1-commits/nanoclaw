#!/usr/bin/env npx tsx
/**
 * Signal Scanner — scans for actionable business signals and outputs
 * recommended proactive actions sorted by priority.
 *
 * Usage:
 *   npx tsx tools/lifecycle/signal-scanner.ts --all-groups
 *   npx tsx tools/lifecycle/signal-scanner.ts --group <folder>
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';

interface Signal {
  type: string;
  priority: number;
  [key: string]: unknown;
}

interface Args {
  allGroups: boolean;
  group?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all-groups') {
      flags.allGroups = true;
    } else if (argv[i] === '--group' && i + 1 < argv.length) {
      flags.group = argv[++i];
    }
  }

  if (!flags.allGroups && !flags.group) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Must specify --all-groups or --group <folder>',
      usage: [
        'npx tsx tools/lifecycle/signal-scanner.ts --all-groups',
        'npx tsx tools/lifecycle/signal-scanner.ts --group <folder>',
      ],
    }));
    process.exit(1);
  }

  return {
    allGroups: !!flags.allGroups,
    group: flags.group as string | undefined,
  };
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}

function groupFilter(args: Args): { clause: string; params: unknown[] } {
  if (args.allGroups) return { clause: '', params: [] };
  return { clause: ' AND d.group_folder = ?', params: [args.group!] };
}

function detectLostDealRevisits(db: Database.Database, args: Args): Signal[] {
  const { clause, params } = groupFilter(args);
  const rows = db.prepare(`
    SELECT d.id AS deal_id, c.first_name, c.last_name, c.company, d.notes,
           julianday('now') - julianday(d.closed_at) AS days_since_lost
    FROM deals d
    JOIN contacts c ON d.contact_id = c.id
    WHERE d.stage = 'closed_lost'
      AND d.closed_at IS NOT NULL
      AND julianday('now') - julianday(d.closed_at) BETWEEN 60 AND 120
      AND NOT EXISTS (
        SELECT 1 FROM outreach_log o
        WHERE o.contact_id = c.id
          AND julianday('now') - julianday(o.sent_at) <= 30
      )${clause}
    ORDER BY days_since_lost ASC
  `).all(...params) as Array<{
    deal_id: string; first_name: string; last_name: string;
    company: string | null; notes: string | null; days_since_lost: number;
  }>;

  return rows.map((r) => {
    const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'there';
    const topic = r.notes ? r.notes.slice(0, 80) : 'your project';
    return {
      type: 'lost_deal_revisit',
      priority: 5,
      deal_id: r.deal_id,
      contact_name: name,
      company: r.company,
      original_note: r.notes,
      days_since_lost: Math.round(r.days_since_lost),
      suggested_message: `Hey ${name}, we chatted a few months back about ${topic}. Just checking if that's still on your radar — no pressure!`,
    };
  });
}

function detectStaleLeads(db: Database.Database, args: Args): Signal[] {
  const { clause, params } = groupFilter(args);
  const rows = db.prepare(`
    SELECT d.id AS deal_id, c.first_name, c.last_name, d.stage,
           julianday('now') - julianday(d.updated_at) AS days_stale
    FROM deals d
    JOIN contacts c ON d.contact_id = c.id
    WHERE d.stage IN ('qualified', 'appointment_booked')
      AND julianday('now') - julianday(d.updated_at) >= 5
      AND NOT EXISTS (
        SELECT 1 FROM deal_stage_log sl
        WHERE sl.deal_id = d.id
          AND julianday('now') - julianday(sl.changed_at) < 5
      )
      AND NOT EXISTS (
        SELECT 1 FROM outreach_log o
        WHERE o.contact_id = c.id
          AND julianday('now') - julianday(o.sent_at) <= 3
      )${clause}
    ORDER BY days_stale DESC
  `).all(...params) as Array<{
    deal_id: string; first_name: string; last_name: string;
    stage: string; days_stale: number;
  }>;

  return rows.map((r) => {
    const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'there';
    return {
      type: 'stale_lead',
      priority: 8,
      deal_id: r.deal_id,
      contact_name: name,
      stage: r.stage,
      days_stale: Math.round(r.days_stale),
      suggested_message: `Hey ${name}, wanted to follow up on our conversation. Still interested in getting set up?`,
    };
  });
}

function detectHotUncontacted(db: Database.Database): Signal[] {
  const rows = db.prepare(`
    SELECT c.id AS contact_id, c.first_name, c.last_name, c.company, c.lead_score
    FROM contacts c
    WHERE c.lead_score >= 70
      AND NOT EXISTS (
        SELECT 1 FROM outreach_log o WHERE o.contact_id = c.id
      )
    ORDER BY c.lead_score DESC
  `).all() as Array<{
    contact_id: string; first_name: string; last_name: string;
    company: string | null; lead_score: number;
  }>;

  return rows.map((r) => {
    const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Unknown';
    return {
      type: 'hot_lead_uncontacted',
      priority: 9,
      contact_id: r.contact_id,
      contact_name: name,
      company: r.company,
      lead_score: r.lead_score,
      suggested_message: 'Initial outreach — use the appropriate variant from A/B testing',
    };
  });
}

function detectComplaintSpike(db: Database.Database): Signal[] {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt,
           GROUP_CONCAT(DISTINCT category) AS categories
    FROM complaints
    WHERE resolution_status = 'open'
      AND julianday('now') - julianday(created_at) <= 7
  `).get() as { cnt: number; categories: string | null } | undefined;

  if (!row || row.cnt < 3) return [];

  return [{
    type: 'complaint_spike',
    priority: 7,
    count: row.cnt,
    categories: row.categories ? row.categories.split(',') : [],
    suggested_action: 'Review complaints and address systemic issue',
  }];
}

function detectSeasonalOpportunity(): Signal[] {
  const month = new Date().getMonth() + 1; // 1-12

  let season: string;
  let suggested_focus: string;

  if (month >= 3 && month <= 5) {
    season = 'spring';
    suggested_focus = 'Spring office refresh — great time to pitch coffee machines and coolers to offices doing spring cleaning';
  } else if (month >= 6 && month <= 8) {
    season = 'summer';
    suggested_focus = 'Summer heat — push ice machines and cold beverages. Warehouses and outdoor venues are hot leads';
  } else if (month >= 9 && month <= 10) {
    season = 'back-to-school';
    suggested_focus = 'Back to school — target schools, universities, student housing';
  } else {
    season = 'winter';
    suggested_focus = 'Cold weather — push hot coffee machines. Office holiday parties = good time for placement calls';
  }

  return [{
    type: 'seasonal',
    priority: 3,
    season,
    suggested_focus,
  }];
}

function detectPipelineDry(db: Database.Database, args: Args): Signal[] {
  const { clause, params } = groupFilter(args);
  const row = db.prepare(`
    SELECT COUNT(*) AS active_deals
    FROM deals d
    WHERE d.stage IN ('new', 'qualified')${clause}
  `).get(...params) as { active_deals: number } | undefined;

  if (!row || row.active_deals >= 5) return [];

  return [{
    type: 'pipeline_dry',
    priority: 10,
    active_deals: row.active_deals,
    suggested_action: 'Ramp up lead generation — run Google Maps search and push leads to Instantly',
  }];
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(name) as { cnt: number };
  return row.cnt > 0;
}

function main() {
  const args = parseArgs();
  const db = getDb();

  try {
    const signals: Signal[] = [];

    const hasDeals = tableExists(db, 'deals');
    const hasContacts = tableExists(db, 'contacts');
    const hasComplaints = tableExists(db, 'complaints');

    if (hasDeals && hasContacts) {
      signals.push(...detectLostDealRevisits(db, args));
      signals.push(...detectStaleLeads(db, args));
      signals.push(...detectPipelineDry(db, args));
    }

    if (hasContacts) {
      signals.push(...detectHotUncontacted(db));
    }

    if (hasComplaints) {
      signals.push(...detectComplaintSpike(db));
    }

    signals.push(...detectSeasonalOpportunity());

    // Sort by priority descending, cap at 10
    signals.sort((a, b) => b.priority - a.priority);
    const top = signals.slice(0, 10);

    // Summary to stderr
    const counts: Record<string, number> = {};
    for (const s of top) {
      counts[s.type] = (counts[s.type] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([t, c]) => `${t}: ${c}`);
    console.error(`[signal-scanner] ${top.length} signal(s) detected — ${parts.join(', ') || 'none'}`);

    // JSON output to stdout
    console.log(JSON.stringify(top, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
