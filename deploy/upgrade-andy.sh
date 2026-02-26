#!/bin/bash
# Andy Business Agent Upgrade — Deployment Script
# Run on VPS: bash deploy/upgrade-andy.sh

set -e

cd /home/nanoclaw/nanoclaw

echo "=== Pulling latest code ==="
git pull origin main

echo "=== Building ==="
npm run build

echo "=== Rebuilding container ==="
./container/build.sh

echo "=== Checking IDDI credentials in .env ==="
# Verify IDDI credentials are present — they must be set manually, never committed to source
if ! grep -q "IDDI_BASE_URL" .env 2>/dev/null; then
  echo "WARNING: IDDI credentials not found in .env"
  echo "Add manually before running IDDI features:"
  echo "  IDDI_BASE_URL=https://vending-backend-nk0m.onrender.com"
  echo "  IDDI_EMAIL=<your-email>"
  echo "  IDDI_PASSWORD=<your-password>"
else
  echo "IDDI credentials found in .env"
fi

echo "=== Checking Gmail config in .env ==="
if ! grep -q "GMAIL_USER_EMAIL" .env 2>/dev/null; then
  echo "WARNING: GMAIL_USER_EMAIL not found in .env"
  echo "Add manually for Gmail API features:"
  echo "  GMAIL_USER_EMAIL=user@yourdomain.com"
  echo ""
  echo "Also ensure domain-wide delegation is configured:"
  echo "  1. Enable Gmail API in Google Cloud Console"
  echo "  2. Admin Console → Security → API Controls → Domain-wide delegation"
  echo "  3. Add service account client ID with scopes:"
  echo "     https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send"
else
  echo "Gmail config found in .env"
fi

echo "=== Backing up database ==="
cp store/messages.db "store/messages.db.bak.$(date +%s)"
echo "Database backed up"

echo "=== Running scheduled tasks SQL ==="
sqlite3 store/messages.db < deploy/upgrade-andy.sql
echo "Scheduled tasks created/updated"

echo "=== Restarting service ==="
systemctl restart nanoclaw

echo "=== Verifying service started ==="
sleep 3
systemctl is-active nanoclaw && echo "Service is running!" || echo "WARNING: Service failed to start"

echo ""
echo "=== Deployment complete ==="
echo "Verify with: journalctl -u nanoclaw -f"
echo ""
echo "Manual verification steps:"
echo "  1. Pipeline: sqlite3 store/messages.db \"SELECT * FROM deals LIMIT 5;\""
echo "  2. Tasks: sqlite3 store/messages.db \"SELECT id, group_folder, schedule_value, status FROM scheduled_tasks WHERE id LIKE '%followup%' OR id LIKE '%briefing%';\""
echo "  3. IDDI: Run inside container: npx tsx tools/iddi/iddi.ts analytics"
