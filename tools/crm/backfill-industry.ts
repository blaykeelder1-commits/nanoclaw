#!/usr/bin/env npx tsx
/**
 * Industry Backfill Tool for NanoClaw
 *
 * Sets `industry` on CRM contacts where it's currently null, using a keyword
 * classifier on company name + Apollo-style tags. Lifts every contact's lead
 * score by 10–20 points (industry weights in scoring-config.json) without
 * making external API calls.
 *
 * Usage:
 *   npx tsx tools/crm/backfill-industry.ts run [--limit 500] [--dry-run]
 *   npx tsx tools/crm/backfill-industry.ts coverage
 *
 * Environment: none — uses local SQLite only.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';

interface Args {
  action: string;
  limit: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0];

  if (!['run', 'coverage'].includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: run, coverage`,
      usage: [
        'npx tsx tools/crm/backfill-industry.ts run [--limit 500] [--dry-run]',
        'npx tsx tools/crm/backfill-industry.ts coverage',
      ],
    }));
    process.exit(1);
  }

  let limit = 500;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--limit' && i + 1 < argv.length) {
      limit = parseInt(argv[++i], 10) || 500;
    }
  }

  return { action, limit, dryRun };
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found.' }));
    process.exit(1);
  }
  return new Database(dbPath);
}

/**
 * Keyword → industry mapping. Order matters — first match wins.
 * Verticals must align with the keys in tools/crm/scoring-config.json
 * industryKeywords so scoring picks them up.
 */
const COMPANY_KEYWORDS: Array<[RegExp, string]> = [
  // Healthcare
  [/\b(hospital|medical center|clinic|urgent care|er |emergency room|wellness)\b/i, 'healthcare'],
  [/\b(dental|dentist|orthodontic|periodontic)\b/i, 'healthcare'],
  // Logistics / shipping / trucking
  [/\b(trucking|freight|logistics|hauling|drayage|cartage|shipping)\b/i, 'logistics'],
  [/\b(warehouse|distribution center|fulfillment|3pl)\b/i, 'manufacturing'],
  // Manufacturing
  [/\b(manufacturing|factory|industrial|fabrication|machining|plant)\b/i, 'manufacturing'],
  // Education
  [/\b(university|college|school|academy|institute)\b/i, 'education'],
  // Hospitality
  [/\b(hotel|inn|suites|lodging|motel|resort)\b/i, 'hospitality'],
  // Fitness
  [/\b(gym|fitness|crossfit|yoga|pilates|spin studio|athletic club)\b/i, 'fitness'],
  // Food service / restaurants
  [/\b(restaurant|cafe|coffee|diner|grill|kitchen|eatery|bbq|bistro|tavern|pub)\b/i, 'food_service'],
  // Automotive
  [/\b(auto|automotive|car dealer|dealership|motors|tire|repair|body shop)\b/i, 'automotive'],
  // Office / coworking
  [/\b(coworking|cowork|wework|regus|spaces |workspace)\b/i, 'coworking'],
  [/\b(office|tower|plaza|complex|corporate|business center)\b/i, 'office'],
  // Retail
  [/\b(store|shop|market|grocer|supermarket|pharmacy)\b/i, 'retail'],
  // Religious / churches
  [/\b(church|chapel|cathedral|temple|synagogue|mosque)\b/i, 'religious'],
  // Finance / banks
  [/\b(bank|credit union|financial|insurance|wealth|capital)\b/i, 'finance'],
  // Real estate / residential
  [/\b(apartment|residences|villas|lofts|townhomes)\b/i, 'residential'],
  [/\b(realty|real estate|property management)\b/i, 'office'],
];

function classifyIndustry(company: string | null, addressOrTypes?: string | null): string | null {
  if (!company) return null;
  const haystack = `${company} ${addressOrTypes || ''}`;
  for (const [pattern, industry] of COMPANY_KEYWORDS) {
    if (pattern.test(haystack)) return industry;
  }
  return null;
}

function runCoverage(db: Database.Database): void {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
  const withIndustry = (db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE industry IS NOT NULL AND industry != ''").get() as { n: number }).n;
  const nullIndustry = total - withIndustry;
  const byIndustry = db.prepare(
    `SELECT industry, COUNT(*) AS n FROM contacts WHERE industry IS NOT NULL AND industry != '' GROUP BY industry ORDER BY n DESC`,
  ).all() as Array<{ industry: string; n: number }>;

  console.log(JSON.stringify({
    status: 'success',
    action: 'coverage',
    total,
    with_industry: withIndustry,
    null_industry: nullIndustry,
    coverage_pct: total > 0 ? Math.round((withIndustry / total) * 100) : 0,
    by_industry: byIndustry,
  }, null, 2));
}

function runBackfill(db: Database.Database, limit: number, dryRun: boolean): void {
  const candidates = db.prepare(
    `SELECT id, company, address, tags FROM contacts
     WHERE (industry IS NULL OR industry = '')
       AND company IS NOT NULL AND company != ''
     ORDER BY lead_score DESC
     LIMIT ?`,
  ).all(limit) as Array<{ id: string; company: string; address: string | null; tags: string | null }>;

  let classified = 0;
  let skipped = 0;
  const samples: Array<{ id: string; company: string; industry: string }> = [];

  const update = db.prepare(`UPDATE contacts SET industry = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();

  const tx = db.transaction((rows: typeof candidates) => {
    for (const row of rows) {
      const industry = classifyIndustry(row.company, `${row.address || ''} ${row.tags || ''}`);
      if (industry) {
        if (!dryRun) update.run(industry, now, row.id);
        classified++;
        if (samples.length < 10) samples.push({ id: row.id, company: row.company, industry });
      } else {
        skipped++;
      }
    }
  });

  tx(candidates);

  console.log(JSON.stringify({
    status: 'success',
    action: 'run',
    dry_run: dryRun,
    examined: candidates.length,
    classified,
    skipped_no_match: skipped,
    samples,
  }, null, 2));
}

function main(): void {
  const args = parseArgs();
  const db = getDb();
  try {
    if (args.action === 'coverage') runCoverage(db);
    else if (args.action === 'run') runBackfill(db, args.limit, args.dryRun);
  } finally {
    db.close();
  }
}

main();
