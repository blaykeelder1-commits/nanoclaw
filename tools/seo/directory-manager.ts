#!/usr/bin/env npx tsx
/**
 * Business Directory Listing Manager for NanoClaw
 * Tracks NAP (Name, Address, Phone) consistency across directories.
 *
 * Usage:
 *   npx tsx tools/seo/directory-manager.ts init --business snak-group
 *   npx tsx tools/seo/directory-manager.ts check --business snak-group --directory yelp
 *   npx tsx tools/seo/directory-manager.ts report --business snak-group
 *   npx tsx tools/seo/directory-manager.ts update --business snak-group --directory yelp --status claimed --url "https://yelp.com/biz/snak-group"
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── NAP Reference Data ──────────────────────────────────────────────────────

const NAP_DATA: Record<string, { name: string; address: string; phone: string; website: string }> = {
  'snak-group': {
    name: 'Snak Group',
    address: 'Houston, TX',
    phone: '', // To be filled
    website: 'https://snakgroup.biz',
  },
  'sheridan-rentals': {
    name: 'Sheridan Trailer Rentals',
    address: 'Tomball, TX',
    phone: '', // To be filled
    website: 'https://sheridantrailerrentals.us',
  },
};

// ── Directory Definitions ───────────────────────────────────────────────────

const COMMON_DIRECTORIES: Record<string, { claimUrl: string; siteDomain: string }> = {
  'google-maps':  { claimUrl: 'https://business.google.com/',            siteDomain: 'google.com/maps' },
  'apple-maps':   { claimUrl: 'https://mapsconnect.apple.com/',          siteDomain: 'maps.apple.com' },
  'bing-places':  { claimUrl: 'https://www.bingplaces.com/',             siteDomain: 'bing.com/maps' },
  'yelp':         { claimUrl: 'https://biz.yelp.com/',                   siteDomain: 'yelp.com' },
  'bbb':          { claimUrl: 'https://www.bbb.org/get-accredited',      siteDomain: 'bbb.org' },
  'yellow-pages': { claimUrl: 'https://advertising.yp.com/',             siteDomain: 'yellowpages.com' },
  'angi':         { claimUrl: 'https://www.angi.com/for-business/',      siteDomain: 'angi.com' },
  'thumbtack':    { claimUrl: 'https://www.thumbtack.com/pro/',          siteDomain: 'thumbtack.com' },
  'facebook':     { claimUrl: 'https://www.facebook.com/pages/create/',  siteDomain: 'facebook.com' },
};

const BUSINESS_EXTRA_DIRECTORIES: Record<string, Record<string, { claimUrl: string; siteDomain: string }>> = {
  'snak-group': {
    'vendsoft':   { claimUrl: 'https://www.vendsoft.com/',          siteDomain: 'vendsoft.com' },
    'coffeetec':  { claimUrl: 'https://www.coffeetec.com/',         siteDomain: 'coffeetec.com' },
  },
  'sheridan-rentals': {
    'rvshare':    { claimUrl: 'https://rvshare.com/list-your-rv',       siteDomain: 'rvshare.com' },
    'outdoorsy':  { claimUrl: 'https://www.outdoorsy.com/list-your-rv', siteDomain: 'outdoorsy.com' },
    'rv-life':    { claimUrl: 'https://rvlife.com/',                    siteDomain: 'rvlife.com' },
  },
};

// ── Database ────────────────────────────────────────────────────────────────

function getDbPath(): string {
  const candidates = [
    path.join(process.cwd(), 'data', 'nanoclaw.db'),
    path.join(__dirname, '..', '..', 'data', 'nanoclaw.db'),
    '/workspace/project/data/nanoclaw.db',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Default: create in data/
  const defaultPath = path.join(process.cwd(), 'data', 'nanoclaw.db');
  return defaultPath;
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS directory_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business TEXT NOT NULL,
      directory TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unclaimed',
      url TEXT,
      claim_url TEXT,
      nap_match INTEGER,
      notes TEXT,
      last_checked TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(business, directory)
    );
  `);
  return db;
}

// ── Arg Parsing ─────────────────────────────────────────────────────────────

function parseFlag(args: string[], flag: string, defaultVal: string = ''): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ── Google Custom Search ────────────────────────────────────────────────────

async function googleSearch(query: string): Promise<{ url: string | null; snippet: string | null }> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!apiKey || !engineId) {
    return { url: null, snippet: null };
  }

  const params = new URLSearchParams({
    key: apiKey,
    cx: engineId,
    q: query,
    num: '3',
  });

  try {
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    if (!res.ok) {
      return { url: null, snippet: null };
    }
    const data = await res.json() as { items?: Array<{ link: string; snippet?: string }> };
    if (data.items && data.items.length > 0) {
      return { url: data.items[0].link, snippet: data.items[0].snippet || null };
    }
    return { url: null, snippet: null };
  } catch {
    return { url: null, snippet: null };
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function actionCheck(args: string[]): Promise<void> {
  const business = parseFlag(args, '--business');
  const directory = parseFlag(args, '--directory');

  if (!business || !directory) {
    console.log(JSON.stringify({ status: 'error', error: 'Required: --business and --directory' }));
    process.exit(1);
  }

  const nap = NAP_DATA[business];
  if (!nap) {
    console.log(JSON.stringify({ status: 'error', error: `Unknown business: ${business}. Valid: ${Object.keys(NAP_DATA).join(', ')}` }));
    process.exit(1);
  }

  // Determine the site domain for search
  const allDirs = { ...COMMON_DIRECTORIES, ...(BUSINESS_EXTRA_DIRECTORIES[business] || {}) };
  const dirInfo = allDirs[directory];
  if (!dirInfo) {
    console.log(JSON.stringify({ status: 'error', error: `Unknown directory: ${directory}. Valid: ${Object.keys(allDirs).join(', ')}` }));
    process.exit(1);
  }

  // Search for the business on the directory
  const searchQuery = `site:${dirInfo.siteDomain} ${nap.name} ${nap.address}`;
  const searchResult = await googleSearch(searchQuery);

  const found = searchResult.url !== null;
  let napMatch: boolean | null = null;

  // Basic NAP check: see if the snippet contains key elements
  if (found && searchResult.snippet) {
    const snippet = searchResult.snippet.toLowerCase();
    const nameMatch = snippet.includes(nap.name.toLowerCase());
    const addressMatch = nap.address ? snippet.includes(nap.address.toLowerCase().split(',')[0].toLowerCase()) : true;
    napMatch = nameMatch && addressMatch;
  }

  // Update the database record
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO directory_listings (business, directory, status, url, claim_url, nap_match, last_checked, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(business, directory) DO UPDATE SET
      url = COALESCE(excluded.url, url),
      nap_match = excluded.nap_match,
      last_checked = excluded.last_checked,
      updated_at = excluded.updated_at,
      status = CASE WHEN excluded.url IS NOT NULL AND status = 'not_found' THEN 'unclaimed' ELSE status END
  `).run(
    business,
    directory,
    found ? 'unclaimed' : 'not_found',
    searchResult.url,
    dirInfo.claimUrl,
    napMatch === null ? null : napMatch ? 1 : 0,
    now,
    now,
  );

  db.close();

  const details = !process.env.GOOGLE_SEARCH_API_KEY
    ? 'Google Search API credentials not set (GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_ENGINE_ID). Stored as unchecked.'
    : found
      ? `Found listing at ${searchResult.url}`
      : `No listing found on ${directory} for ${nap.name}`;

  console.log(JSON.stringify({
    status: 'success',
    directory,
    found,
    url: searchResult.url,
    nap_match: napMatch,
    details,
  }));
}

function actionReport(args: string[]): void {
  const business = parseFlag(args, '--business');

  if (!business) {
    console.log(JSON.stringify({ status: 'error', error: 'Required: --business' }));
    process.exit(1);
  }

  if (!NAP_DATA[business]) {
    console.log(JSON.stringify({ status: 'error', error: `Unknown business: ${business}. Valid: ${Object.keys(NAP_DATA).join(', ')}` }));
    process.exit(1);
  }

  const db = getDb();

  const listings = db.prepare(`
    SELECT directory, status, url, claim_url, nap_match, notes, last_checked, updated_at
    FROM directory_listings
    WHERE business = ?
    ORDER BY directory
  `).all(business) as Array<{
    directory: string;
    status: string;
    url: string | null;
    claim_url: string | null;
    nap_match: number | null;
    notes: string | null;
    last_checked: string | null;
    updated_at: string | null;
  }>;

  db.close();

  if (listings.length === 0) {
    console.log(JSON.stringify({
      status: 'success',
      business,
      message: 'No listings found. Run `init --business ' + business + '` first.',
      listings: [],
      summary: null,
    }));
    return;
  }

  // Compute summary
  const total = listings.length;
  const claimed = listings.filter(l => l.status === 'claimed' || l.status === 'verified').length;
  const verified = listings.filter(l => l.status === 'verified').length;
  const consistent = listings.filter(l => l.nap_match === 1).length;
  const checkedCount = listings.filter(l => l.nap_match !== null).length;
  const notFound = listings.filter(l => l.status === 'not_found').length;
  const needsUpdate = listings.filter(l => l.status === 'needs_update').length;

  const actionItems: string[] = [];
  for (const l of listings) {
    if (l.status === 'unclaimed') {
      actionItems.push(`Claim ${l.directory}: ${l.claim_url}`);
    } else if (l.status === 'not_found') {
      actionItems.push(`Create listing on ${l.directory}: ${l.claim_url}`);
    } else if (l.status === 'needs_update') {
      actionItems.push(`Update ${l.directory} listing${l.notes ? ': ' + l.notes : ''}`);
    } else if (l.nap_match === 0) {
      actionItems.push(`Fix NAP inconsistency on ${l.directory}: ${l.url}`);
    }
  }

  const report = listings.map(l => ({
    directory: l.directory,
    status: l.status,
    url: l.url,
    claim_url: l.claim_url,
    nap_match: l.nap_match === null ? null : l.nap_match === 1,
    last_checked: l.last_checked,
    notes: l.notes,
  }));

  console.log(JSON.stringify({
    status: 'success',
    business,
    nap_reference: NAP_DATA[business],
    listings: report,
    summary: {
      total,
      claimed,
      verified,
      not_found: notFound,
      needs_update: needsUpdate,
      pct_claimed: total > 0 ? Math.round((claimed / total) * 100) : 0,
      pct_consistent: checkedCount > 0 ? Math.round((consistent / checkedCount) * 100) : 0,
      action_items: actionItems,
    },
  }));
}

function actionUpdate(args: string[]): void {
  const business = parseFlag(args, '--business');
  const directory = parseFlag(args, '--directory');
  const status = parseFlag(args, '--status');
  const url = parseFlag(args, '--url');
  const notes = parseFlag(args, '--notes');

  if (!business || !directory) {
    console.log(JSON.stringify({ status: 'error', error: 'Required: --business and --directory' }));
    process.exit(1);
  }

  const validStatuses = ['claimed', 'verified', 'unclaimed', 'not_found', 'needs_update'];
  if (status && !validStatuses.includes(status)) {
    console.log(JSON.stringify({ status: 'error', error: `Invalid status: ${status}. Valid: ${validStatuses.join(', ')}` }));
    process.exit(1);
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Build dynamic update
  const sets: string[] = ['updated_at = ?'];
  const params: (string | null)[] = [now];

  if (status) {
    sets.push('status = ?');
    params.push(status);
  }
  if (url) {
    sets.push('url = ?');
    params.push(url);
  }
  if (notes) {
    sets.push('notes = ?');
    params.push(notes);
  }

  params.push(business, directory);

  const result = db.prepare(`
    UPDATE directory_listings
    SET ${sets.join(', ')}
    WHERE business = ? AND directory = ?
  `).run(...params);

  db.close();

  if (result.changes === 0) {
    console.log(JSON.stringify({
      status: 'error',
      error: `No listing found for ${business} / ${directory}. Run init first.`,
    }));
    return;
  }

  console.log(JSON.stringify({
    status: 'success',
    business,
    directory,
    updated: { status: status || undefined, url: url || undefined, notes: notes || undefined },
    message: `Listing updated for ${directory}`,
  }));
}

function actionInit(args: string[]): void {
  const business = parseFlag(args, '--business');

  if (!business) {
    console.log(JSON.stringify({ status: 'error', error: 'Required: --business' }));
    process.exit(1);
  }

  if (!NAP_DATA[business]) {
    console.log(JSON.stringify({ status: 'error', error: `Unknown business: ${business}. Valid: ${Object.keys(NAP_DATA).join(', ')}` }));
    process.exit(1);
  }

  const db = getDb();
  const now = new Date().toISOString();

  const allDirs = { ...COMMON_DIRECTORIES, ...(BUSINESS_EXTRA_DIRECTORIES[business] || {}) };

  const insert = db.prepare(`
    INSERT INTO directory_listings (business, directory, status, claim_url, created_at, updated_at)
    VALUES (?, ?, 'unclaimed', ?, ?, ?)
    ON CONFLICT(business, directory) DO UPDATE SET
      claim_url = excluded.claim_url,
      updated_at = excluded.updated_at
  `);

  const insertMany = db.transaction(() => {
    for (const [dir, info] of Object.entries(allDirs)) {
      insert.run(business, dir, info.claimUrl, now, now);
    }
  });

  insertMany();
  db.close();

  console.log(JSON.stringify({
    status: 'success',
    business,
    directories_initialized: Object.keys(allDirs),
    count: Object.keys(allDirs).length,
    message: `Initialized ${Object.keys(allDirs).length} directory listings for ${business}`,
  }));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action) {
    console.log(JSON.stringify({
      status: 'error',
      error: 'No action specified',
      usage: {
        init: 'Initialize directory listings: --business <name>',
        check: 'Check a directory listing: --business <name> --directory <dir>',
        report: 'Generate NAP consistency report: --business <name>',
        update: 'Update listing status: --business <name> --directory <dir> --status <status> [--url <url>] [--notes <text>]',
      },
    }));
    process.exit(1);
  }

  switch (action) {
    case 'init':
      actionInit(args);
      break;
    case 'check':
      await actionCheck(args);
      break;
    case 'report':
      actionReport(args);
      break;
    case 'update':
      actionUpdate(args);
      break;
    default:
      console.log(JSON.stringify({ status: 'error', error: `Unknown action: ${action}. Valid: init, check, report, update` }));
      process.exit(1);
  }
}

main();
