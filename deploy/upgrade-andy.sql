-- Andy Business Agent Upgrade — Scheduled Tasks
-- Run on VPS: sqlite3 /home/nanoclaw/nanoclaw/store/messages.db < deploy/upgrade-andy.sql
--
-- TIMEZONE: All cron expressions are in America/Chicago (Central Time).
-- The systemd service sets TZ=America/Chicago so the scheduler interprets them correctly.

-- Schema migration: add model/budget columns for per-task overrides
-- (safe to re-run — ALTER TABLE fails silently if column exists in the app migration)

-- Stage 3: Automated Follow-up Tasks (weekdays 11 AM CT)

-- Snak Group follow-ups
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-followup-daily',
  'snak-group',
  '__scheduled__',
  'Run daily follow-up check. Use crm-query to find leads needing follow-up (follow-up --days 3 --limit 5). For each lead, check their pipeline stage to tailor the message. Check the contact''s channel_source — if WhatsApp, reply via send_message; if email, use send-email; if SMS, skip (note for manual follow-up). Keep follow-ups short, warm, and conversational. Max 3 total touches per lead. After sending each follow-up, log the outreach. Do NOT send a progress report — just do the work silently.',
  'cron',
  '0 11 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Sheridan Rentals follow-ups
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'sheridan-followup-daily',
  'sheridan-rentals',
  '__scheduled__',
  'Run daily follow-up check. Use crm-query to find leads needing follow-up (follow-up --days 3 --limit 5). For each lead, check their pipeline stage to tailor the message. Check the contact''s channel_source — if WhatsApp, reply via send_message; if email, use send-email; if SMS, skip (note for manual follow-up). Keep follow-ups short, warm, and conversational. Max 3 total touches per lead. After sending each follow-up, log the outreach. Do NOT send a progress report — just do the work silently.',
  'cron',
  '0 11 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 4: Enhanced Daily Briefings (weekdays 8 AM CT)

-- Snak Group daily briefing
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-daily-briefing',
  'snak-group',
  '__scheduled__',
  'Generate the daily business briefing and send it via WhatsApp to the main group (NOT email — email is disabled per global rules). Format as a single concise WhatsApp message using *single asterisks* for bold and bullet points. Skip any section with no data. Include:

1. *Overnight Leads* — CRM contacts created in the last 24h. Show name, company, source, and current deal stage.

2. *Follow-ups Due* — Run crm-query follow-up. Each with last-contact date and touch count.

3. *Pipeline Health* — Run pipeline health --group snak-group. Counts per stage + total deal value.

4. *Upcoming Appointments* — Google Calendar next 7 days.

5. *IDDI Alerts* — iddi expiring --days 7 + iddi redistribution. Summarize flags only.

6. *Open Complaints (>24h)* — Run: sqlite3 store/messages.db "SELECT customer_name, channel, category, ROUND(julianday(''now'')-julianday(created_at)) AS age_days, substr(message_snippet,1,80) FROM complaints WHERE resolution_status=''open'' AND business=''snak-group'' AND created_at < datetime(''now'',''-1 day'') ORDER BY age_days DESC". For each, show: customer/channel/age/brief. Flag any age_days > 7 with prefix "🚨 STUCK — needs Blayke today" and call mcp__nanoclaw__escalate (severity=urgent) per complaint.

7. *Open Issues* — Check playbook.md for flagged items.

8. *What Andy Learned* — One sentence on new patterns or notable conversations from yesterday.

Title the WhatsApp message: "📊 Snak Group Daily Briefing — [Today''s Date]". Send via mcp__nanoclaw__send_message to the main group JID.',
  'cron',
  '0 8 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Sheridan Rentals daily briefing
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'sheridan-daily-briefing',
  'sheridan-rentals',
  '__scheduled__',
  'Generate the daily Sheridan business briefing and send it via WhatsApp to the main group (NOT email). Format as a single concise WhatsApp message using *single asterisks* for bold and bullet points. Skip any section with no data. Include:

1. *Tomorrow''s Pickups & Returns* — All 3 Google Calendars (RV Camper, Car Hauler, Landscaping Trailer). Each with equipment/customer/time.

2. *This Week''s Bookings* — Next 7 days, grouped by equipment type.

3. *Overnight Inquiries* — CRM contacts created in last 24h. Show name, source, and topic.

4. *Pending Follow-ups* — crm-query follow-up. Each with last-contact date.

5. *Pipeline Health* — pipeline health --group sheridan-rentals. Counts per stage.

6. *Revenue Estimate* — This week''s confirmed bookings × typical rates (RV $150/night, Car Hauler $65/day, Landscaping $50/day).

7. *Open Complaints (>24h)* — Run: sqlite3 store/messages.db "SELECT customer_name, channel, category, ROUND(julianday(''now'')-julianday(created_at)) AS age_days, substr(message_snippet,1,80) FROM complaints WHERE resolution_status=''open'' AND business=''sheridan-rentals'' AND created_at < datetime(''now'',''-1 day'') ORDER BY age_days DESC". For each: customer/channel/age/brief. Flag age_days > 7 with prefix "🚨 STUCK — needs Blayke today" and call mcp__nanoclaw__escalate (severity=urgent).

Title: "🚐 Sheridan Daily Briefing — [Today''s Date]". Send via mcp__nanoclaw__send_message to the main group JID.',
  'cron',
  '0 8 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 5: Daily Vending Inventory Process (weekdays 9 AM CT)
-- Review HahaVending/Vendera → IDDI → update Google Sheets → check Sam's Club pricing

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-vending-daily',
  'snak-group',
  '__scheduled__',
  'Run the daily vending inventory review. Follow this exact process:

STEP 1 — PULL SALES DATA
Log into HahaVending and Vendera (credentials in CLAUDE.md). Pull yesterday''s sales data from both platforms. Merge into unified per-product totals.

STEP 2 — CHECK IDDI
Run IDDI inventory check. Look for products near expiration (expiring --days 7), redistribution opportunities, and any alerts.

STEP 3 — UPDATE GOOGLE SHEETS
Read current state of "snak group inventory tracker" (all 3 tabs: Warehouse Inventory, Sales Performance, Ordering List).
- Update Sales Performance tab with yesterday''s sales in the correct week column
- Update Warehouse Inventory tab: subtract sold units from Current Stock
- Update color codes based on stock levels and sales velocity

STEP 4 — RUN RECONCILIATION
Run: reconcile full --yo-offset 2
This cross-examines IDDI + Sheets and produces reorder list, blacklist warnings, and discrepancies.

STEP 5 — CHECK SAM''S CLUB PRICING
Use web search (NOT browser automation) to check Sam''s Club prices for items on the reorder list and current inventory items. If any price changes are found, update the pricing column in Google Sheets.

STEP 6 — REPORT (only if significant changes)
If there are reorder needs, blacklist warnings, expiring products, or pricing changes — send ONE consolidated WhatsApp message with the findings. If everything looks normal, work silently (no message needed).

Do NOT send multiple messages or progress updates. Work silently until done.',
  'cron',
  '0 9 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 5b: Weekly Blacklist Review (Fridays 4 PM CT)
-- End-of-week review: flag red items to owner, ask permission to blacklist, report items eligible for re-enlistment

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-blacklist-weekly',
  'snak-group',
  '__scheduled__',
  'Run the weekly blacklist review. This is the end-of-week inventory health check.

STEP 1 — READ CURRENT STATE
Read Google Sheets "snak group inventory tracker" — all 3 tabs (Warehouse Inventory, Sales Performance, Ordering List).
Read blacklist-state.json if it exists.

STEP 2 — RUN RECONCILIATION
Run: reconcile full --yo-offset 2
Review the output carefully, focusing on:
- blacklist_warnings (items approaching blacklist — 1-3 red weeks)
- blacklist_now (items hitting 4 red weeks)
- coming_off_blacklist (items whose 3-month blacklist period has expired)

STEP 3 — IDENTIFY RED ITEMS
Find ALL items in Sales Performance that are currently RED (slow sellers). For each, note how many consecutive red weeks they have.

STEP 4 — EMAIL THE OWNER
Send an email to the owner (check owner-info.md) with subject: "Weekly Inventory Review — [Today''s Date]"

Include these sections:

*Items Approaching Blacklist (Need Your Attention):*
List each red item with consecutive red weeks count. For items at 3 weeks, flag them as "BLACKLIST NEXT WEEK unless sales improve."
Ask: "Should I move these to the blacklist?"

*Items Ready to Blacklist (4+ Red Weeks):*
List items that hit 4 consecutive red weeks. Include average weekly units sold.
Ask: "Permission to blacklist these for 3 months? I''ll find replacement products from Sam''s Club."

*Items Eligible for Re-Enlistment (Blacklist Expired):*
List items whose 3-month blacklist period has ended.
Ask: "Want to give these another try? I''ll add them back to the active inventory."

*Inventory Health Summary:*
- Total active products
- Products in green/yellow/red status
- Estimated reorder cost for next week
- Any IDDI expiration alerts

Do NOT blacklist or re-enlist anything without owner approval. Just report and ask.',
  'cron',
  '0 16 * * 5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 5c: Daily Marketing Lead Scrape (weekdays 10 AM CT)

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-lead-scrape-daily',
  'snak-group',
  '__scheduled__',
  'Run daily lead generation scrape. Follow the lead-gen-strategy.md playbook.

STEP 1 — SCRAPE NEW LEADS
Use Google Maps API (google-maps.ts) to search for target businesses within 60mi of Tomball, TX:
- Office buildings and corporate campuses
- Hotels and hospitality venues
- Gyms and fitness centers
- Car dealerships and auto shops
- Manufacturing and warehouse facilities
- Schools and universities
- Hospitals and medical centers

STEP 2 — QUALIFY & ADD TO CRM
For each prospect found:
- Score using the criteria in lead-gen-strategy.md (minimum 5 points to qualify)
- Use website-scraper.ts to find contact email and phone
- Check CRM to avoid duplicates (query-contacts.ts)
- Add qualifying leads to CRM with source "google_maps"

STEP 3 — PUSH TO INSTANTLY
After adding new leads to CRM, push them to the active Instantly campaign:
- Run: instantly.ts campaigns — find the active campaign
- Run: instantly.ts add-leads --campaign-id "..." --source google_maps --limit 50
- Instantly handles the email warmup, drip sequence, and deliverability
- Do NOT send cold emails via SMTP (send-email.ts) — all cold outreach goes through Instantly

STEP 4 — SYNC REPLIES
Run: instantly.ts sync-replies
This pulls reply data from Instantly and updates CRM deal stages (replied leads → qualified).

Work silently. Do NOT send a progress report unless you found zero leads (in which case, note the search areas tried so we can expand next time).',
  'cron',
  '0 10 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 5d: Daily Instantly Reply Sync (weekdays 2 PM CT)
-- Pulls replies from Instantly, updates CRM deal stages, reports on campaign performance

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-instantly-sync',
  'snak-group',
  '__scheduled__',
  'Run Instantly.ai reply sync and campaign health check.

STEP 1 — SYNC REPLIES
Run: instantly.ts sync-replies
This pulls all replied leads from active Instantly campaigns and updates CRM deal stages.

STEP 2 — CHECK CAMPAIGN ANALYTICS
Run: instantly.ts campaign-analytics
Review open rates, reply rates, and bounce rates for each active campaign.

STEP 3 — FLAG ISSUES
If any campaign has:
- Reply rate below 1% after 100+ emails sent → flag in daily briefing
- Bounce rate above 5% → flag as possible list quality issue
- Open rate below 30% → flag as possible deliverability issue

STEP 4 — CHECK ACCOUNT HEALTH
Run: instantly.ts accounts
For each active account, check if warmup is enabled and functioning.

Only report to owner if there are actionable issues. Work silently if everything looks healthy.',
  'cron',
  '0 14 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 5e: Daily Facebook Page Posting — Sheridan Rentals (weekdays 9 AM CT)
-- Organic content to build page credibility and followers before Marketplace access

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'sheridan-fb-post-daily',
  'sheridan-rentals',
  '__scheduled__',
  'Post today''s Facebook content to the Sheridan Rentals page. Follow this exact process:

STEP 1 — READ BRAND GUIDELINES
Read brand-voice.md for tone, key phrases, differentiators, and hashtag rules.

STEP 2 — CHECK CONTENT CALENDAR
Read content-calendar.md. Check today''s day-of-week theme:
- Monday: Fleet Spotlight — showcase one piece of equipment with pricing
- Tuesday: Local Flavor / Tips — camping spots near Houston, hauling tips, Tomball events
- Wednesday: Customer Use Case — real scenarios (project car pickup, family RV trip, moving day)
- Thursday: Seasonal / Promotional — tie into current season, availability alerts
- Friday: Engagement / Fun — polls, questions, weekend plans

Review the Log section to avoid repeating recent topics (never repeat within 2 weeks).

STEP 3 — CRAFT THE POST
Write a post following today''s theme. Rules:
- Under 300 characters
- 2-3 hashtags (mix branded + local/seasonal from brand-voice.md)
- Include booking link (sheridantrailerrentals.us/form/) on fleet spotlight and promo posts
- Casual Texas friendly tone — like talking to a neighbor
- No corporate speak, no fluff

STEP 4 — POST TO FACEBOOK
Use post-facebook.ts to publish:
  npx tsx tools/social/post-facebook.ts --message "your post content"
Add --link for booking link posts. Add --image if you have a relevant image URL.

STEP 5 — UPDATE CONTENT CALENDAR
Add a row to the Log table in content-calendar.md with today''s date, day theme, topic summary, and status (posted).

Work silently. Do NOT send a progress report.',
  'cron',
  '0 9 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 6: Per-task model/budget overrides
-- Upgrade daily briefings to Sonnet — they need complex multi-tool reasoning
UPDATE scheduled_tasks SET model = 'claude-sonnet-4-6', budget_usd = 0.50
  WHERE id IN ('snak-daily-briefing', 'sheridan-daily-briefing');

-- Vending inventory tasks need Sonnet + higher budget for browser automation
UPDATE scheduled_tasks SET model = 'claude-sonnet-4-6', budget_usd = 0.50
  WHERE id LIKE '%vending%' OR id LIKE '%inventory%' OR id LIKE '%blacklist%';

-- Lead scraping and Instantly sync need Sonnet for multi-step reasoning
UPDATE scheduled_tasks SET model = 'claude-sonnet-4-6', budget_usd = 0.50
  WHERE id IN ('snak-lead-scrape-daily', 'snak-instantly-sync');

-- Stage 7: CLI execution mode (Max subscription)
-- Add columns if they don't exist (safe to re-run)
ALTER TABLE scheduled_tasks ADD COLUMN execution_mode TEXT DEFAULT 'cli';
ALTER TABLE scheduled_tasks ADD COLUMN fallback_to_container INTEGER DEFAULT 1;

-- All scheduled tasks default to CLI (free with Max sub), with container fallback
UPDATE scheduled_tasks SET execution_mode = 'cli', fallback_to_container = 1;

-- Stage 8: Fix any tasks stuck at 3 AM — move to business hours CT
-- This catches any tasks created through the app that may have UTC-based cron times
UPDATE scheduled_tasks SET schedule_value = '0 9 * * 1-5'
  WHERE schedule_value LIKE '0 3 %' OR schedule_value LIKE '0 8 %' AND schedule_value LIKE '% * *';
-- Fix any other pre-dawn tasks (midnight to 6 AM)
UPDATE scheduled_tasks SET schedule_value = REPLACE(schedule_value, '0 0 ', '0 8 ')
  WHERE schedule_value LIKE '0 0 %';
UPDATE scheduled_tasks SET schedule_value = REPLACE(schedule_value, '0 1 ', '0 9 ')
  WHERE schedule_value LIKE '0 1 %';
UPDATE scheduled_tasks SET schedule_value = REPLACE(schedule_value, '0 2 ', '0 9 ')
  WHERE schedule_value LIKE '0 2 %';
UPDATE scheduled_tasks SET schedule_value = REPLACE(schedule_value, '0 3 ', '0 9 ')
  WHERE schedule_value LIKE '0 3 %';
UPDATE scheduled_tasks SET schedule_value = REPLACE(schedule_value, '0 4 ', '0 10 ')
  WHERE schedule_value LIKE '0 4 %';
UPDATE scheduled_tasks SET schedule_value = REPLACE(schedule_value, '0 5 ', '0 10 ')
  WHERE schedule_value LIKE '0 5 %';

-- Stage 9: Stuck-complaint nag (weekdays 8 AM CT)
-- Pings WhatsApp main group for any complaint open >7 days. Belt-and-suspenders
-- alongside daily briefing — keeps stuck cases from disappearing into the table.

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'complaint-nag-daily',
  'main',
  '__scheduled__',
  'Surface stuck customer complaints for Blayke. Run:

sqlite3 /workspace/project/store/messages.db "SELECT id, customer_name, channel, category, business, ROUND(julianday(''now'')-julianday(created_at)) AS age_days, substr(message_snippet,1,120) AS snippet FROM complaints WHERE resolution_status=''open'' AND created_at < datetime(''now'',''-7 days'') ORDER BY age_days DESC LIMIT 20;"

For each row returned, call mcp__nanoclaw__escalate with:
- severity: "urgent" if age_days < 30, "critical" if age_days >= 30
- summary: "🚨 Complaint #<id> stuck <age_days>d — <customer_name> on <channel> (<business>)"
- recommendation: a one-line suggested next action (e.g. "Call customer; offer partial refund" / "Close as no-action — too old"). Be conservative; default to "Brief Blayke and ask for direction".
- options: ["call_customer", "refund_partial", "refund_full", "close_no_action", "other"]
- customer_channel: <channel>

If zero complaints are stuck >7 days, work silently — do NOT send a "nothing to report" ping.

Do NOT attempt to resolve or contact the customer yourself — those are owner decisions per Decision Authority.',
  'cron',
  '0 8 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 10: Mahindra one-shot brief (runs once on next eligible 9 AM CT)
-- Andy reads each open Mahindra complaint and sends Blayke a separate WhatsApp
-- brief per complaint so Blayke can decide live. After firing once, the task
-- pauses itself (status=paused) — re-enable manually if Mahindra is reopened.

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'mahindra-one-shot-brief',
  'main',
  '__scheduled__',
  'One-shot brief on open Mahindra complaints. Run:

sqlite3 /workspace/project/store/messages.db "SELECT id, customer_name, customer_jid, channel, category, business, created_at, ROUND(julianday(''now'')-julianday(created_at)) AS age_days, message_snippet FROM complaints WHERE resolution_status=''open'' AND (LOWER(customer_name) LIKE ''%mahindra%'' OR LOWER(message_snippet) LIKE ''%mahindra%'' OR LOWER(notes) LIKE ''%mahindra%'') ORDER BY created_at ASC;"

For each row, send a SEPARATE WhatsApp message to the main group via mcp__nanoclaw__send_message. Format each as:

📋 *Mahindra Complaint #<id>* (<age_days>d old)
*Customer:* <customer_name>
*Channel:* <channel>
*Category:* <category>
*Business:* <business>
*Snippet:* "<message_snippet>"
*Andy''s read:* <one-sentence assessment of severity + likely cause>
*Suggested options:* <2-3 numbered options, e.g. 1) Refund $X, 2) Replacement, 3) No-action close>

Wait for Blayke to reply per complaint with his decision (free text). Do NOT make any decisions yourself — this is owner-only territory per Decision Authority.

After sending all briefs, send one final WhatsApp message to the main group: "📋 Mahindra brief complete — <N> complaints surfaced. Reply per complaint with direction."',
  'once',
  'manual',
  'group',
  datetime('now', '+1 minute'),
  'active',
  datetime('now')
);
