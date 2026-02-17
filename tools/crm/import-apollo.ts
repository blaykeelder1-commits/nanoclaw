#!/usr/bin/env npx tsx
/**
 * Import Apollo.io CSV Export into NanoClaw CRM
 * Usage: npx tsx tools/crm/import-apollo.ts <csv-file> [--tags "tag1,tag2"] [--dry-run]
 *
 * Expects Apollo CSV format with columns:
 *   First Name, Last Name, Email, Company, Title, LinkedIn Url, Phone, etc.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface ApolloRow {
  'First Name': string;
  'Last Name': string;
  'Email': string;
  'Company': string;
  'Title': string;
  'LinkedIn Url': string;
  'Phone': string;
  [key: string]: string;
}

function parseCSV(content: string): ApolloRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header - handle quoted fields
  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const headers = parseRow(lines[0]);
  const rows: ApolloRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row as ApolloRow);
  }

  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const csvFile = args.find((a) => !a.startsWith('--'));
  const tags = args.includes('--tags') ? args[args.indexOf('--tags') + 1] : null;
  const dryRun = args.includes('--dry-run');

  if (!csvFile) {
    console.error('Usage: import-apollo <csv-file> [--tags "tag1,tag2"] [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(csvFile)) {
    console.error(JSON.stringify({ status: 'error', error: `File not found: ${csvFile}` }));
    process.exit(1);
  }

  const content = fs.readFileSync(csvFile, 'utf-8');
  const rows = parseCSV(content);

  if (dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      total_rows: rows.length,
      sample: rows.slice(0, 3).map((r) => ({
        email: r['Email'],
        name: `${r['First Name']} ${r['Last Name']}`,
        company: r['Company'],
      })),
    }));
    return;
  }

  // Open the NanoClaw database
  const dbPath = path.join(process.cwd(), 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: `Database not found at ${dbPath}. Run NanoClaw first.` }));
    process.exit(1);
  }

  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const tagList = tags ? JSON.stringify(tags.split(',').map((t) => t.trim())) : null;

  const stmt = db.prepare(
    `INSERT INTO contacts (id, email, first_name, last_name, company, title, linkedin_url, phone, source, tags, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'apollo', ?, NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       company = excluded.company,
       title = excluded.title,
       linkedin_url = COALESCE(excluded.linkedin_url, linkedin_url),
       phone = COALESCE(excluded.phone, phone),
       tags = excluded.tags,
       updated_at = excluded.updated_at`,
  );

  let imported = 0;
  let skipped = 0;

  const insertMany = db.transaction((contacts: ApolloRow[]) => {
    for (const row of contacts) {
      const email = row['Email']?.trim();
      if (!email || !email.includes('@')) {
        skipped++;
        continue;
      }

      const id = crypto.randomUUID();
      stmt.run(
        id,
        email.toLowerCase(),
        row['First Name']?.trim() || 'Unknown',
        row['Last Name']?.trim() || '',
        row['Company']?.trim() || null,
        row['Title']?.trim() || null,
        row['LinkedIn Url']?.trim() || null,
        row['Phone']?.trim() || null,
        tagList,
        now,
        now,
      );
      imported++;
    }
  });

  insertMany(rows);
  db.close();

  console.log(JSON.stringify({
    status: 'success',
    imported,
    skipped,
    total_rows: rows.length,
    tags: tagList,
  }));
}

main();
