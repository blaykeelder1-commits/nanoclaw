#!/bin/bash
# NanoClaw Offsite Backup Script
# Backs up SQLite databases and critical config to a remote location.
#
# Usage:
#   deploy/backup-offsite.sh                     # Backup to default location
#   deploy/backup-offsite.sh s3://bucket/path    # Backup to S3
#   deploy/backup-offsite.sh /mnt/backup/        # Backup to mounted drive
#
# Schedule via cron (daily at 2 AM):
#   0 2 * * * /path/to/nanoclaw/deploy/backup-offsite.sh s3://your-bucket/nanoclaw >> /var/log/nanoclaw-backup.log 2>&1
#
# Retention: keeps last 30 daily backups, last 12 weekly, last 6 monthly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default backup destination — override with first argument or BACKUP_DEST env var
BACKUP_DEST="${1:-${BACKUP_DEST:-$PROJECT_DIR/deploy/offsite-backups}}"

TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
DAY_OF_WEEK=$(date '+%u')  # 1=Monday, 7=Sunday
DAY_OF_MONTH=$(date '+%d')
MAX_DAILY=30
MAX_WEEKLY=12
MAX_MONTHLY=6

log() { echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
err() { echo "[backup] ERROR: $*" >&2; }

# ── Detect backup method ──
use_s3=false
if [[ "$BACKUP_DEST" == s3://* ]]; then
  use_s3=true
  if ! command -v aws &>/dev/null; then
    err "AWS CLI not installed — cannot backup to S3"
    exit 1
  fi
fi

# ── Create local temp directory for staging ──
STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT

BACKUP_NAME="nanoclaw-$TIMESTAMP"
BACKUP_DIR="$STAGING_DIR/$BACKUP_NAME"
mkdir -p "$BACKUP_DIR"

log "Starting backup: $BACKUP_NAME"
log "Destination: $BACKUP_DEST"

# ── Backup SQLite databases using .backup command (safe, consistent snapshot) ──
MESSAGES_DB="$PROJECT_DIR/store/messages.db"
DATA_DB="$PROJECT_DIR/data/data.db"

if [ -f "$MESSAGES_DB" ]; then
  log "Backing up messages.db..."
  sqlite3 "$MESSAGES_DB" ".backup '$BACKUP_DIR/messages.db'"
  log "  messages.db: $(du -h "$BACKUP_DIR/messages.db" | cut -f1)"
fi

if [ -f "$DATA_DB" ]; then
  log "Backing up data.db..."
  sqlite3 "$DATA_DB" ".backup '$BACKUP_DIR/data.db'"
  log "  data.db: $(du -h "$BACKUP_DIR/data.db" | cut -f1)"
fi

# ── Backup group CLAUDE.md files and workspace configs ──
log "Backing up group configs..."
for group_dir in "$PROJECT_DIR/groups"/*/; do
  group_name=$(basename "$group_dir")
  mkdir -p "$BACKUP_DIR/groups/$group_name"
  # Copy markdown files (CLAUDE.md, lessons, playbook, etc.) — not media or conversations
  find "$group_dir" -maxdepth 1 -name '*.md' -exec cp {} "$BACKUP_DIR/groups/$group_name/" \;
  # Copy JSON files (sessions index, etc.)
  find "$group_dir" -maxdepth 1 -name '*.json' -exec cp {} "$BACKUP_DIR/groups/$group_name/" \;
done

# ── Backup WhatsApp auth state (needed to restore without re-scanning QR) ──
AUTH_DIR="$PROJECT_DIR/store/auth"
if [ -d "$AUTH_DIR" ]; then
  log "Backing up WhatsApp auth state..."
  cp -r "$AUTH_DIR" "$BACKUP_DIR/auth"
fi

# ── Compress ──
log "Compressing..."
ARCHIVE="$STAGING_DIR/$BACKUP_NAME.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGING_DIR" "$BACKUP_NAME"
ARCHIVE_SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "Archive size: $ARCHIVE_SIZE"

# ── Upload / Copy ──
# Tag: daily (always), weekly (Sunday), monthly (1st of month)
TAGS="daily"
if [ "$DAY_OF_WEEK" = "7" ]; then TAGS="$TAGS,weekly"; fi
if [ "$DAY_OF_MONTH" = "01" ]; then TAGS="$TAGS,monthly"; fi

if $use_s3; then
  log "Uploading to S3..."
  aws s3 cp "$ARCHIVE" "$BACKUP_DEST/daily/$BACKUP_NAME.tar.gz" --quiet
  if [[ "$TAGS" == *"weekly"* ]]; then
    aws s3 cp "$ARCHIVE" "$BACKUP_DEST/weekly/$BACKUP_NAME.tar.gz" --quiet
  fi
  if [[ "$TAGS" == *"monthly"* ]]; then
    aws s3 cp "$ARCHIVE" "$BACKUP_DEST/monthly/$BACKUP_NAME.tar.gz" --quiet
  fi

  # ── Prune old backups ──
  log "Pruning old S3 backups..."
  # List daily backups, sort, keep last N
  aws s3 ls "$BACKUP_DEST/daily/" --recursive 2>/dev/null \
    | sort -k1,2 \
    | head -n -"$MAX_DAILY" \
    | awk '{print $4}' \
    | while read -r key; do
        aws s3 rm "s3://$(echo "$BACKUP_DEST" | sed 's|s3://||')/$key" --quiet 2>/dev/null || true
      done

  aws s3 ls "$BACKUP_DEST/weekly/" --recursive 2>/dev/null \
    | sort -k1,2 \
    | head -n -"$MAX_WEEKLY" \
    | awk '{print $4}' \
    | while read -r key; do
        aws s3 rm "s3://$(echo "$BACKUP_DEST" | sed 's|s3://||')/$key" --quiet 2>/dev/null || true
      done

  aws s3 ls "$BACKUP_DEST/monthly/" --recursive 2>/dev/null \
    | sort -k1,2 \
    | head -n -"$MAX_MONTHLY" \
    | awk '{print $4}' \
    | while read -r key; do
        aws s3 rm "s3://$(echo "$BACKUP_DEST" | sed 's|s3://||')/$key" --quiet 2>/dev/null || true
      done
else
  # Local/mounted filesystem backup
  mkdir -p "$BACKUP_DEST/daily"
  cp "$ARCHIVE" "$BACKUP_DEST/daily/"
  if [[ "$TAGS" == *"weekly"* ]]; then
    mkdir -p "$BACKUP_DEST/weekly"
    cp "$ARCHIVE" "$BACKUP_DEST/weekly/"
  fi
  if [[ "$TAGS" == *"monthly"* ]]; then
    mkdir -p "$BACKUP_DEST/monthly"
    cp "$ARCHIVE" "$BACKUP_DEST/monthly/"
  fi

  # ── Prune old local backups ──
  log "Pruning old local backups..."
  ls -t "$BACKUP_DEST/daily/"*.tar.gz 2>/dev/null | tail -n +"$((MAX_DAILY + 1))" | xargs rm -f 2>/dev/null || true
  ls -t "$BACKUP_DEST/weekly/"*.tar.gz 2>/dev/null | tail -n +"$((MAX_WEEKLY + 1))" | xargs rm -f 2>/dev/null || true
  ls -t "$BACKUP_DEST/monthly/"*.tar.gz 2>/dev/null | tail -n +"$((MAX_MONTHLY + 1))" | xargs rm -f 2>/dev/null || true
fi

log "Backup complete: $BACKUP_NAME ($ARCHIVE_SIZE) [$TAGS]"
