#!/usr/bin/env npx tsx
/**
 * Clean up redundant/overlapping scheduled tasks for efficiency.
 * Run from project root: npx tsx scripts/cleanup-tasks.ts
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(process.cwd(), 'store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.error('Database not found at ' + dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

// === DELETE REDUNDANT TASKS ===

const toDelete = [
  // 1. Triple follow-up overlap: group-level tasks handle this
  'follow-up-check',        // main daily 10am — duplicated by snak-followup-daily + sheridan-followup-daily
  'follow-up-optimizer',    // main daily 3pm — duplicated by group-level follow-ups

  // 2. Double weekly vending: 487917c4 at 7pm is the real one
  'snak-inventory-weekly',  // main Fri 6pm — duplicated by 487917c4 at Fri 7pm

  // 3. Double revenue report
  'weekly-revenue-report',  // main Mon 1pm — merged into weekly-revenue-dashboard at Mon 9am

  // 4. Review solicitation covered by post-sale-lifecycle
  'review-solicitation',    // main daily 11am — post-sale-lifecycle already covers reviews + upsells + referrals

  // 5. Daily digest from main — replaced by group-level briefings
  'daily-digest-8am',       // main daily — snak-daily-briefing + sheridan-daily-briefing are more comprehensive

  // 6. Weekly SEO browser checks — monthly tool-based audits are better
  'snak-seo-weekly',        // Sunday — monthly snak-seo-monthly is comprehensive
  'sheridan-seo-weekly',    // Sunday — monthly sheridan-seo-monthly is comprehensive

  // 7. System health tasks — low value, consume CLI time
  'health-daily-check',     // main daily 9am — just reads a JSON file
  'health-weekly-deps',     // main Mon 10am — npm outdated is dev work, not business ops
];

for (const id of toDelete) {
  const result = db.prepare("UPDATE scheduled_tasks SET status = 'deleted' WHERE id = ? AND status = 'active'").run(id);
  if (result.changes > 0) {
    console.log('Deleted: ' + id);
  } else {
    console.log('Skipped (not found/already deleted): ' + id);
  }
}

// === STAGGER MONDAY MORNING TASKS ===
// Currently 6+ tasks fire at 9-10am Monday, creating a queue

const mondayStagger: Array<[string, string]> = [
  // Mon 7am: Sheridan marketplace renewal (already set)
  // Mon 7am: Lead scrape weekly (already set)
  ['weekly-revenue-dashboard', '0 8 * * 1'],    // Move from 9am to 8am
  ['snak-google-ads-weekly', '0 9 * * 1'],       // Keep at 9am
  ['sheridan-google-ads-weekly', '0 9 * * 1'],    // Keep at 9am
  ['weekly-performance-analysis', '0 10 * * 1'],  // Move from 12pm to 10am
  ['revenue-intelligence', '0 11 * * 1'],         // Move from 1pm to 11am
  ['sams-club-weekly-prices', '0 12 * * 1'],      // Move from 10am to 12pm (less urgent)
];

for (const [id, cron] of mondayStagger) {
  const result = db.prepare('UPDATE scheduled_tasks SET schedule_value = ? WHERE id = ? AND status = ?')
    .run(cron, id, 'active');
  if (result.changes > 0) {
    console.log('Rescheduled: ' + id + ' → ' + cron);
  }
}

// === REDUCE SNAK LEAD SCRAPING FROM DAILY TO 3x/WEEK ===
db.prepare("UPDATE scheduled_tasks SET schedule_value = '0 10 * * 1,3,5' WHERE id = 'snak-lead-scrape-daily' AND status = 'active'").run();
console.log('Reduced: snak-lead-scrape-daily → Mon/Wed/Fri only');

// === MOVE PROACTIVE SIGNALS TO GROUP LEVEL ===
// Currently runs under main — should run per-group for proper context
const signalPrompt = db.prepare("SELECT prompt FROM scheduled_tasks WHERE id = 'proactive-signals'").get() as { prompt: string } | undefined;
if (signalPrompt) {
  // Delete the main-level one
  db.prepare("UPDATE scheduled_tasks SET status = 'deleted' WHERE id = 'proactive-signals'").run();
  console.log('Deleted main-level proactive-signals (replaced by group-level)');

  // The group-level follow-up tasks already cover stale leads
  // Signal scanner is more about upsells and revisits — add to weekly
}

// === ADD DAILY FACEBOOK POSTING TASKS ===
// These check pending-posts.md for approved content and actually publish it

function findGroupJid(groupFolder: string): string {
  const row = db.prepare('SELECT jid FROM registered_groups WHERE folder = ? OR name LIKE ? LIMIT 1')
    .get(groupFolder, '%' + groupFolder + '%') as { jid: string } | undefined;
  return row?.jid || 'unknown';
}

const snakPostingTask = {
  id: 'snak-fb-post-daily',
  group_folder: 'snak-group',
  chat_jid: findGroupJid('snak-group'),
  prompt: `Check pending-posts.md for today's approved Facebook post. If today has an approved post:

1. Download the photo from Google Drive if a Drive file ID is present
2. Post to Facebook with the message, photo, and place-id from houston-places.md
3. Post to Instagram with the Instagram caption version and same photo
4. If a TikTok version exists and there's video content, post to TikTok (stagger 30-60 min)
5. If a GBP post is scheduled for today, post via gbp.ts
6. Record all post IDs back in pending-posts.md and content-calendar.md log

If no approved post for today, skip silently. Do NOT generate new posts — only post what's already approved in pending-posts.md.`,
  schedule_value: '0 9 * * 1-5',
};

const sheridanPostingTask = {
  id: 'sheridan-fb-post-daily',
  group_folder: 'sheridan-rentals',
  chat_jid: findGroupJid('sheridan-rentals'),
  prompt: `Check pending-posts.md for today's approved Facebook post. If today has an approved post:

1. Download the photo from Google Drive if a Drive file ID is present
2. Post to Facebook with the message, photo, and place-id from houston-places.md (Tomball default)
3. Post to Instagram with the Instagram caption version and same photo
4. If a GBP post is scheduled for today, post via gbp.ts
5. Record all post IDs back in pending-posts.md and content-calendar.md log

If no approved post for today, skip silently.`,
  schedule_value: '0 9 * * 1-5',
};

for (const task of [snakPostingTask, sheridanPostingTask]) {
  const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(task.id);
  if (existing) {
    db.prepare('UPDATE scheduled_tasks SET prompt = ?, schedule_value = ?, status = ? WHERE id = ?')
      .run(task.prompt, task.schedule_value, 'active', task.id);
    console.log('Updated: ' + task.id);
  } else {
    db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode)
      VALUES (?, ?, ?, ?, 'cron', ?, 'full', datetime('now', '+1 hour'), 'active', datetime('now'), 'cli')`)
      .run(task.id, task.group_folder, task.chat_jid, task.prompt, task.schedule_value);
    console.log('Created: ' + task.id);
  }
}

// === SUMMARY ===
const finalCounts = db.prepare("SELECT status, COUNT(*) as count FROM scheduled_tasks GROUP BY status").all();
console.log('\nFinal task counts:', JSON.stringify(finalCounts));

db.close();
console.log('Cleanup complete.');
