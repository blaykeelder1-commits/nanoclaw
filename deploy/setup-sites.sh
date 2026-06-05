#!/bin/bash
# setup-sites.sh — clone/refresh the website checkouts that Andy can edit + deploy.
#
# Idempotent: clones each whitelisted repo into $SITES_DIR on first run, and
# hard-resets it to origin/<prodBranch> on subsequent runs. Safe to re-run anytime.
#
# Requires GITHUB_TOKEN (read from the environment, or from the nanoclaw .env).
# Run on the VPS as the nanoclaw service user:
#   bash deploy/setup-sites.sh
#
# Sites are read from tools/web/sites.json so this never drifts from the deploy tool.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITES_DIR="${SITES_DIR:-$HOME/sites}"
SITES_JSON="$REPO_ROOT/tools/web/sites.json"

echo "==================================="
echo "  NanoClaw — site checkouts"
echo "  SITES_DIR: $SITES_DIR"
echo "==================================="

# --- GITHUB_TOKEN: env wins, else pull from the nanoclaw .env ---
if [[ -z "${GITHUB_TOKEN:-}" && -f "$REPO_ROOT/.env" ]]; then
  GITHUB_TOKEN="$(grep -E '^GITHUB_TOKEN=' "$REPO_ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'' )"
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "ERROR: GITHUB_TOKEN is not set (env or .env). Add it before running." >&2
  exit 1
fi

# --- wrangler available for deploys (global, so 'npx wrangler' is instant) ---
if ! command -v wrangler >/dev/null 2>&1; then
  echo "[*] Installing wrangler globally..."
  npm install -g wrangler >/dev/null 2>&1 || echo "    (wrangler global install failed — 'npx --yes wrangler' will still work)"
fi

mkdir -p "$SITES_DIR"

# --- iterate sites from sites.json (owner/repo/prodBranch) ---
node -e '
  const s = require("'"$SITES_JSON"'");
  for (const k of Object.keys(s)) {
    const v = s[k];
    console.log([k, v.owner, v.repo, v.prodBranch].join("\t"));
  }
' | while IFS=$'\t' read -r key owner repo branch; do
  dir="$SITES_DIR/$repo"
  remote="https://x-access-token:${GITHUB_TOKEN}@github.com/${owner}/${repo}.git"
  echo
  echo "[$key] $owner/$repo (branch: $branch)"
  if [[ -d "$dir/.git" ]]; then
    echo "  refreshing existing checkout..."
    git -C "$dir" remote set-url origin "$remote"
    git -C "$dir" fetch origin "$branch"
    git -C "$dir" checkout "$branch"
    git -C "$dir" reset --hard "origin/$branch"
    git -C "$dir" clean -fd
  else
    echo "  cloning..."
    git clone --branch "$branch" "$remote" "$dir"
  fi
  echo "  ✓ $dir"
done

echo
echo "Done. Verify a deploy with:"
echo "  npx tsx tools/web/ship-site.ts list"
