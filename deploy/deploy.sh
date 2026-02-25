#!/bin/bash
# NanoClaw Safe Deploy Script with Rollback
# Usage: deploy/deploy.sh [--skip-tests]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

BACKUP_DIR="$PROJECT_DIR/deploy/backups"
MAX_BACKUPS=5
SKIP_TESTS="${1:-}"

log() { echo "[deploy] $(date '+%H:%M:%S') $*"; }
err() { echo "[deploy] ERROR: $*" >&2; }

# --- Step 1: Capture current state for rollback ---
OLD_SHA=$(git rev-parse HEAD)
OLD_SHA_SHORT=$(git rev-parse --short HEAD)
TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
BACKUP_NAME="$TIMESTAMP-$OLD_SHA_SHORT"

log "Current commit: $OLD_SHA_SHORT"
log "Creating backup: $BACKUP_NAME"

mkdir -p "$BACKUP_DIR/$BACKUP_NAME"
echo "$OLD_SHA" > "$BACKUP_DIR/$BACKUP_NAME/sha"
cp package.json "$BACKUP_DIR/$BACKUP_NAME/package.json"
cp package-lock.json "$BACKUP_DIR/$BACKUP_NAME/package-lock.json" 2>/dev/null || true

rollback() {
  err "Deploy failed — rolling back to $OLD_SHA_SHORT"
  git checkout "$OLD_SHA" -- .
  if [ -f "$BACKUP_DIR/$BACKUP_NAME/package-lock.json" ]; then
    npm ci --ignore-scripts 2>/dev/null || true
  fi
  npm run build 2>/dev/null || true
  ./container/build.sh 2>/dev/null || true
  systemctl restart nanoclaw 2>/dev/null || true
  err "Rollback complete. Service restarted on $OLD_SHA_SHORT"
  exit 1
}

# --- Step 2: Pull latest code ---
log "Pulling latest changes..."
git fetch origin main
REMOTE_SHA=$(git rev-parse origin/main)

if [ "$OLD_SHA" = "$REMOTE_SHA" ]; then
  log "Already up to date ($OLD_SHA_SHORT). Nothing to deploy."
  rmdir "$BACKUP_DIR/$BACKUP_NAME" 2>/dev/null || true
  exit 0
fi

git merge origin/main --ff-only || {
  err "Cannot fast-forward merge. Manual intervention required."
  exit 1
}

NEW_SHA_SHORT=$(git rev-parse --short HEAD)
log "Updated: $OLD_SHA_SHORT → $NEW_SHA_SHORT"

# --- Step 3: Install deps if lockfile changed ---
if ! git diff "$OLD_SHA" HEAD --quiet -- package-lock.json 2>/dev/null; then
  log "package-lock.json changed — running npm ci"
  npm ci || rollback
else
  log "Dependencies unchanged, skipping npm ci"
fi

# --- Step 4: Build ---
log "Building TypeScript..."
npm run build || rollback

# --- Step 5: Tests ---
if [ "$SKIP_TESTS" != "--skip-tests" ]; then
  log "Running tests..."
  npm test || rollback
else
  log "Skipping tests (--skip-tests flag)"
fi

# --- Step 6: Rebuild container ---
log "Rebuilding agent container..."
./container/build.sh || rollback

# --- Step 7: Restart service ---
log "Restarting nanoclaw service..."
systemctl restart nanoclaw

# --- Step 8: Verify startup ---
log "Waiting for service to start (30s timeout)..."
CONNECTED=false
for i in $(seq 1 30); do
  if journalctl -u nanoclaw --since "30 seconds ago" --no-pager 2>/dev/null | grep -q "Connected to WhatsApp"; then
    CONNECTED=true
    break
  fi
  sleep 1
done

if [ "$CONNECTED" = true ]; then
  log "✓ Service started and connected to WhatsApp"
else
  err "Service did not connect within 30s — check logs"
  err "Run: journalctl -u nanoclaw -f"
  # Don't auto-rollback here — the service might still be connecting
  # Manual check is safer than assuming failure
  exit 1
fi

# --- Step 9: Clean old backups ---
BACKUP_COUNT=$(ls -d "$BACKUP_DIR"/*/  2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
  EXCESS=$((BACKUP_COUNT - MAX_BACKUPS))
  ls -d "$BACKUP_DIR"/*/ | head -n "$EXCESS" | while read -r dir; do
    log "Removing old backup: $(basename "$dir")"
    rm -rf "$dir"
  done
fi

log "Deploy complete: $OLD_SHA_SHORT → $NEW_SHA_SHORT"
