-- Balance Payment Reminder Task for Sheridan Rentals
-- Run on VPS: sqlite3 /home/nanoclaw/nanoclaw/store/messages.db < deploy/seed-balance-reminder.sql
--
-- Runs daily at 10 AM CT. Checks for deposit-only bookings with unpaid balance
-- approaching their rental date. Sends email reminders at 7 days, 2 days, and day-of.

INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'sheridan-balance-reminder',
  'sheridan-rentals',
  '__scheduled__',
  'Run the balance payment reminder system for deposit-only bookings.

Execute: npx tsx services/booking/balance-reminder.ts

This script automatically:
1. Finds all deposit-only bookings (status=paid, balance>0) with rental dates approaching
2. Sends reminder emails at 7 days out, 2 days out, and day-of pickup
3. Creates Square payment links for the remaining balance
4. Alerts the owner on day-of if balance is still unpaid
5. Tracks reminder count to avoid spamming

Report the results back. If any bookings have unpaid balances due today, flag them as urgent.',
  'cron',
  '0 10 * * *',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- Google Sheet sync — runs every 6 hours so the dashboard stays current
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'sheridan-sheet-sync',
  'sheridan-rentals',
  '__scheduled__',
  'Sync all Sheridan Rentals bookings to the Google Sheets dashboard.

Execute: npx tsx tools/bookings/sync-to-sheet.ts --spreadsheet-id "$SHERIDAN_SPREADSHEET_ID"

This updates the Bookings tab with current data: status, deposit paid, balance due, dates, customer info.
Report how many bookings were synced.',
  'cron',
  '0 */6 * * *',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- Also add a followup task if it doesn't exist
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'sheridan-post-rental-followup',
  'sheridan-rentals',
  '__scheduled__',
  'Run post-rental followup emails for completed rentals.

Execute: npx tsx services/booking/followup.ts

This sends review request emails to customers 1-2 days after their rental ends.',
  'cron',
  '0 11 * * *',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);
