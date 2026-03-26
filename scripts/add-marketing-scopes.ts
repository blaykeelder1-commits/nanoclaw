#!/usr/bin/env npx tsx
/**
 * One-time migration: Add gbp, ads, seo, tiktok secret scopes to snak-group and sheridan-rentals.
 *
 * Run from the NanoClaw project root:
 *   npx tsx scripts/add-marketing-scopes.ts
 *
 * This updates the container_config in the registered_groups table to include
 * the new secret scopes needed for GBP, Google Ads, SEO tools, and TikTok.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'store', 'data.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(JSON.stringify({ status: 'error', error: `Database not found at ${DB_PATH}` }));
  process.exit(1);
}

const db = new Database(DB_PATH);

const NEW_SCOPES = ['gbp', 'ads', 'seo', 'tiktok'];
const TARGET_GROUPS = ['snak-group', 'sheridan-rentals'];

interface GroupRow {
  jid: string;
  name: string;
  container_config: string | null;
}

const rows = db.prepare(
  `SELECT jid, name, container_config FROM registered_groups WHERE name IN (${TARGET_GROUPS.map(() => '?').join(',')})`
).all(...TARGET_GROUPS) as GroupRow[];

if (rows.length === 0) {
  console.log(JSON.stringify({ status: 'info', message: 'No matching groups found. They may not be registered yet on this instance.' }));
  process.exit(0);
}

const results: Array<{ group: string; before: string[]; after: string[] }> = [];

for (const row of rows) {
  const config = row.container_config ? JSON.parse(row.container_config) : {};
  const existing: string[] = config.extraSecretScopes || [];
  const merged = [...new Set([...existing, ...NEW_SCOPES])];

  config.extraSecretScopes = merged;

  // Add GBP location ID override per group (maps GBP_LOCATION_ID → GBP_LOCATION_ID_SNAK etc.)
  const overrides: Record<string, string> = config.secretOverrides || {};
  if (row.name === 'snak-group') {
    overrides['GBP_LOCATION_ID'] = 'GBP_LOCATION_ID_SNAK';
  } else if (row.name === 'sheridan-rentals') {
    overrides['GBP_LOCATION_ID'] = 'GBP_LOCATION_ID_SHERIDAN';
  }
  config.secretOverrides = overrides;

  db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?')
    .run(JSON.stringify(config), row.jid);

  results.push({
    group: row.name,
    before: existing,
    after: merged,
  });
}

db.close();

console.log(JSON.stringify({
  status: 'success',
  message: `Updated ${results.length} group(s) with new secret scopes`,
  results,
}, null, 2));
