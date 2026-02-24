#!/bin/bash
# Full Business Agent Upgrade — deploy script
# Run on VPS: bash /home/nanoclaw/nanoclaw/deploy/upgrade-agent.sh
set -euo pipefail

NANOCLAW_DIR="/home/nanoclaw/nanoclaw"
DB_PATH="$NANOCLAW_DIR/store/messages.db"

echo "=== NanoClaw Agent Upgrade ==="

# 1. Add IDDI credentials to .env if not present
echo "--- Checking .env for IDDI credentials ---"
if ! grep -q "IDDI_BASE_URL" "$NANOCLAW_DIR/.env" 2>/dev/null; then
  echo "Adding IDDI credentials to .env..."
  cat >> "$NANOCLAW_DIR/.env" << 'ENVEOF'

# IDDI vending platform
IDDI_BASE_URL=https://vending-backend-nk0m.onrender.com
IDDI_EMAIL=blayke.elder1@gmail.com
IDDI_PASSWORD=Thrive17!
ENVEOF
  echo "IDDI credentials added."
else
  echo "IDDI credentials already present."
fi

# 2. Insert follow-up scheduled tasks
echo "--- Adding follow-up scheduled tasks ---"
sqlite3 "$DB_PATH" << 'SQLEOF'
-- Snak Group daily follow-up (11 AM CT, weekdays)
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'followup-snak',
  'snak-group',
  'scheduled',
  'Run daily follow-up check. Use the crm-query skill to find leads needing follow-up (query-contacts.ts follow-up --days 3). For each lead: check their pipeline stage (pipeline.ts get --contact-id <id>), check their channel_source, and send a tailored follow-up via the same channel they came from. WhatsApp leads get a WhatsApp message. Email leads get an email. SMS/Quo leads get a note for manual follow-up. Maximum 3 touches per lead. Log outreach after sending. Report a summary of actions taken.',
  'cron',
  '0 11 * * 1-5',
  'isolated',
  datetime('now'),
  'active',
  datetime('now')
);

-- Sheridan Rentals daily follow-up (11 AM CT, weekdays)
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'followup-sheridan',
  'sheridan-rentals',
  'scheduled',
  'Run daily follow-up check. Use the crm-query skill to find leads needing follow-up (query-contacts.ts follow-up --days 3). For each lead: check their pipeline stage (pipeline.ts get --contact-id <id>), check their channel_source, and send a tailored follow-up via the same channel they came from. WhatsApp leads get a WhatsApp message. Email leads get an email. SMS/Quo leads get a note for manual follow-up. Maximum 3 touches per lead. Log outreach after sending. Report a summary of actions taken.',
  'cron',
  '0 11 * * 1-5',
  'isolated',
  datetime('now'),
  'active',
  datetime('now')
);
SQLEOF
echo "Follow-up tasks added."

# 3. Update daily digest prompts
echo "--- Updating daily digest prompts ---"
sqlite3 "$DB_PATH" << 'SQLEOF'
-- Update Snak Group digest to enhanced version + 8 AM CT
UPDATE scheduled_tasks
SET prompt = 'Compile your daily briefing and email the owner (check owner-info.md). Subject: "Snak Group Daily Update — [today''s date]". Include these sections:

1. **Overnight Leads** — Search CRM for contacts created in the last 24h. Include deal stage for each.
2. **Follow-ups Due** — Run query-contacts.ts follow-up --days 3. List contacts needing attention.
3. **Pipeline Health** — Run pipeline.ts health --group snak-group. Show counts per stage and win rate.
4. **Upcoming Appointments** — Check Google Calendar for the next 7 days.
5. **IDDI Alerts** — Run iddi.ts expiring --days 7 for expiring products. Run iddi.ts redistribution for optimization flags.
6. **Open Issues** — Check playbook.md for any flagged items or unresolved questions.
7. **What Andy Learned** — Summarize any new patterns, objections, or questions from yesterday.

Keep the email scannable — use bullet points and bold headers. If there are no items for a section, say "None" and move on.',
    schedule_value = '0 8 * * 1-5'
WHERE group_folder = 'snak-group' AND prompt LIKE '%daily%' AND prompt LIKE '%digest%' OR (group_folder = 'snak-group' AND prompt LIKE '%tomorrow%appointments%');

-- Update Sheridan Rentals digest to enhanced version + 8 AM CT
UPDATE scheduled_tasks
SET prompt = 'Compile your daily briefing and email the owner (check owner-info.md). Subject: "Sheridan Rentals Daily Update — [today''s date]". Include these sections:

1. **Tomorrow''s Pickups & Returns** — Check all 3 equipment calendars (RV Camper, Car Hauler, Landscaping Trailer) for tomorrow.
2. **This Week''s Bookings** — Summarize bookings for the next 7 days by equipment type.
3. **Overnight Inquiries** — Search CRM for contacts created in the last 24h.
4. **Pending Follow-ups** — Run query-contacts.ts follow-up --days 3. List contacts needing attention.
5. **Pipeline Health** — Run pipeline.ts health --group sheridan-rentals. Show inquiry-to-booking conversion.
6. **Revenue Estimate** — Sum up confirmed bookings x typical rates for the next 7 days.

Keep the email scannable — use bullet points and bold headers. If there are no items for a section, say "None" and move on.',
    schedule_value = '0 8 * * 1-5'
WHERE group_folder = 'sheridan-rentals' AND (prompt LIKE '%daily%' OR prompt LIKE '%digest%' OR prompt LIKE '%tomorrow%pickups%');
SQLEOF
echo "Digest prompts updated."

# 4. Verify registered groups
echo "--- Verifying registered groups ---"
sqlite3 "$DB_PATH" "SELECT jid, name, folder FROM registered_groups;"

# 5. Verify scheduled tasks
echo "--- Current scheduled tasks ---"
sqlite3 "$DB_PATH" "SELECT id, group_folder, schedule_value, status, substr(prompt, 1, 60) as prompt_preview FROM scheduled_tasks WHERE status = 'active';"

# 6. Build and deploy
echo "--- Building ---"
cd "$NANOCLAW_DIR"
npm run build

echo "--- Rebuilding container ---"
./container/build.sh

echo "--- Restarting service ---"
systemctl restart nanoclaw

echo "=== Upgrade complete ==="
echo "Monitor with: journalctl -u nanoclaw -f"
