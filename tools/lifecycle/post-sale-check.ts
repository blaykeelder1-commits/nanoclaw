#!/usr/bin/env npx tsx
/**
 * Post-Sale Lifecycle Check
 * Scans closed_won deals and identifies lifecycle actions needed.
 *
 * Usage:
 *   npx tsx tools/lifecycle/post-sale-check.ts --all-groups
 *   npx tsx tools/lifecycle/post-sale-check.ts --group <folder>
 *   npx tsx tools/lifecycle/post-sale-check.ts --all-groups --days 120
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';

interface Deal {
  id: string;
  contact_id: string;
  group_folder: string;
  stage: string;
  value_cents: number | null;
  closed_at: string;
}

interface Contact {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  phone: string;
  channel_source: string;
  business: string;
}

interface Action {
  type: 'check_in' | 'review_ask' | 'upsell' | 'referral_ask';
  deal_id: string;
  contact_id: string;
  contact_name: string;
  company: string;
  group_folder: string;
  channel: string;
  days_since_close: number;
  message_template: string;
}

const PRIORITY: Record<Action['type'], number> = {
  check_in: 0,
  review_ask: 1,
  upsell: 2,
  referral_ask: 3,
};

function parseFlag(args: string[], flag: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function daysBetween(dateStr: string, now: Date): number {
  const d = new Date(dateStr);
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function contactName(c: Contact): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there';
}

function main() {
  const args = process.argv.slice(2);
  const allGroups = hasFlag(args, '--all-groups');
  const group = parseFlag(args, '--group');
  const daysOverride = parseFlag(args, '--days');
  const maxLookback = daysOverride ? parseInt(daysOverride, 10) : 120;

  if (!allGroups && !group) {
    console.error('Usage: post-sale-check.ts --all-groups | --group <folder> [--days <N>]');
    process.exit(1);
  }

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const now = new Date();

  // Fetch closed_won deals within lookback window
  const cutoff = new Date(now.getTime() - maxLookback * 24 * 60 * 60 * 1000).toISOString();

  let deals: Deal[];
  if (group) {
    deals = db.prepare(
      `SELECT * FROM deals WHERE stage = 'closed_won' AND closed_at >= ? AND group_folder = ? ORDER BY closed_at DESC`,
    ).all(cutoff, group) as Deal[];
  } else {
    deals = db.prepare(
      `SELECT * FROM deals WHERE stage = 'closed_won' AND closed_at >= ? ORDER BY closed_at DESC`,
    ).all(cutoff) as Deal[];
  }

  const actions: Action[] = [];

  // Prepare reusable statements
  const getContact = db.prepare('SELECT * FROM contacts WHERE id = ?');
  const recentOutreach = db.prepare(
    'SELECT COUNT(*) as cnt FROM outreach_log WHERE contact_id = ? AND sent_at >= ?',
  );
  const hasSubjectOutreach = db.prepare(
    `SELECT COUNT(*) as cnt FROM outreach_log WHERE contact_id = ? AND LOWER(subject) LIKE ?`,
  );

  for (const deal of deals) {
    const contact = getContact.get(deal.contact_id) as Contact | undefined;
    if (!contact) continue;

    const daysSinceClose = daysBetween(deal.closed_at, now);
    const name = contactName(contact);

    const base = {
      deal_id: deal.id,
      contact_id: deal.contact_id,
      contact_name: name,
      company: contact.company || '',
      group_folder: deal.group_folder,
      channel: contact.channel_source || '',
      days_since_close: daysSinceClose,
    };

    // 1. Review ask: 14-21 days
    if (daysSinceClose >= 14 && daysSinceClose <= 21) {
      const hasReview = (hasSubjectOutreach.get(deal.contact_id, '%review%') as { cnt: number }).cnt;
      if (hasReview === 0) {
        actions.push({
          ...base,
          type: 'review_ask',
          message_template: `Hey ${name}, if you've had a good experience, we'd really appreciate a quick Google review — it helps other businesses find us! [Google review link]`,
        });
      }
    }

    // 2. 30-day check-in: 25-35 days
    if (daysSinceClose >= 25 && daysSinceClose <= 35) {
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const recent = (recentOutreach.get(deal.contact_id, fourteenDaysAgo) as { cnt: number }).cnt;
      if (recent === 0) {
        actions.push({
          ...base,
          type: 'check_in',
          message_template: `Hey ${name}, just wanted to check in — how's everything working out? Anything we can help with?`,
        });
      }
    }

    // 3. Referral ask: 60+ days
    if (daysSinceClose >= 60) {
      const hasReferral = (hasSubjectOutreach.get(deal.contact_id, '%referral%') as { cnt: number }).cnt;
      if (hasReferral === 0) {
        const twentyOneDaysAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString();
        const recent = (recentOutreach.get(deal.contact_id, twentyOneDaysAgo) as { cnt: number }).cnt;
        if (recent === 0) {
          actions.push({
            ...base,
            type: 'referral_ask',
            message_template: `Hey ${name}, know anyone else who might benefit from what we do? Happy to set them up — and we'll make sure you're taken care of for the intro.`,
          });
        }
      }
    }

    // 4. 90-day upsell: 80-100 days
    if (daysSinceClose >= 80 && daysSinceClose <= 100) {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recent = (recentOutreach.get(deal.contact_id, thirtyDaysAgo) as { cnt: number }).cnt;
      if (recent === 0) {
        actions.push({
          ...base,
          type: 'upsell',
          message_template: `Hey ${name}, a few of our locations with similar traffic have added [coffee/second machine]. Want me to look into that for you?`,
        });
      }
    }
  }

  // Sort by priority
  actions.sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type]);

  // Output
  console.log(JSON.stringify(actions, null, 2));

  // Summary to stderr
  const counts: Record<string, number> = {};
  for (const a of actions) {
    counts[a.type] = (counts[a.type] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([t, c]) => `${t}: ${c}`);
  console.error(`Post-sale check complete. ${actions.length} action(s) found.${parts.length ? ' ' + parts.join(', ') : ''}`);

  db.close();
}

main();
