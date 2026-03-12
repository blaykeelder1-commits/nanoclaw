#!/usr/bin/env npx tsx
/**
 * Sync bookings from SQLite to Google Sheets
 *
 * Usage:
 *   npx tsx tools/bookings/sync-to-sheet.ts --spreadsheet-id <SHEET_ID>
 *
 * Environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON string of the service account key
 */

import { google } from 'googleapis';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../services/booking/data/bookings.db');

const HEADERS = [
  'Booking ID',
  'Equipment',
  'Customer',
  'Phone',
  'Email',
  'Pickup',
  'Return',
  'Days',
  'Total',
  'Deposit Paid',
  'Balance Due',
  'Status',
  'Created',
];

function parseArgs(): { spreadsheetId: string } {
  const argv = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  const spreadsheetId = flags['spreadsheet-id'];
  if (!spreadsheetId) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing required --spreadsheet-id flag',
      usage: 'npx tsx tools/bookings/sync-to-sheet.ts --spreadsheet-id <SHEET_ID>',
    }));
    process.exit(1);
  }

  return { spreadsheetId };
}

function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable.',
    }));
    process.exit(1);
  }

  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    console.error(JSON.stringify({
      status: 'error',
      error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.',
    }));
    process.exit(1);
  }

  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function getPickupAndReturn(datesJson: string): { pickup: string; returnDate: string } {
  try {
    const dates: string[] = JSON.parse(datesJson);
    if (!Array.isArray(dates) || dates.length === 0) return { pickup: '', returnDate: '' };
    const sorted = [...dates].sort();
    return {
      pickup: formatDate(sorted[0]),
      returnDate: formatDate(sorted[sorted.length - 1]),
    };
  } catch {
    return { pickup: '', returnDate: '' };
  }
}

function getPickupSortKey(datesJson: string): string {
  try {
    const dates: string[] = JSON.parse(datesJson);
    if (!Array.isArray(dates) || dates.length === 0) return '9999-99-99';
    return [...dates].sort()[0];
  } catch {
    return '9999-99-99';
  }
}

interface Booking {
  id: string;
  equipment: string;
  equipment_label: string;
  dates: string;
  num_days: number;
  customer_first: string;
  customer_last: string;
  customer_email: string;
  customer_phone: string;
  subtotal: number;
  deposit: number;
  balance: number;
  add_ons: string;
  details: string;
  status: string;
  created_at: string;
}

async function main() {
  const { spreadsheetId } = parseArgs();
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read bookings from SQLite
  const db = new Database(DB_PATH, { readonly: true });
  const bookings = db.prepare('SELECT * FROM bookings').all() as Booking[];
  db.close();

  // Sort by pickup date (soonest first)
  bookings.sort((a, b) => {
    const ka = getPickupSortKey(a.dates);
    const kb = getPickupSortKey(b.dates);
    return ka.localeCompare(kb);
  });

  // Build rows
  const rows: string[][] = [HEADERS];
  for (const b of bookings) {
    const { pickup, returnDate } = getPickupAndReturn(b.dates);
    const customer = `${b.customer_first || ''} ${b.customer_last || ''}`.trim();
    rows.push([
      b.id,
      b.equipment_label || b.equipment,
      customer,
      b.customer_phone || '',
      b.customer_email || '',
      pickup,
      returnDate,
      String(b.num_days || ''),
      b.subtotal != null ? `$${Number(b.subtotal).toFixed(2)}` : '',
      b.deposit != null ? `$${Number(b.deposit).toFixed(2)}` : '',
      b.balance != null ? `$${Number(b.balance).toFixed(2)}` : '',
      b.status || '',
      b.created_at ? formatDate(b.created_at) : '',
    ]);
  }

  // Clear existing data and write fresh
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Bookings!A:Z',
    });
  } catch {
    // Sheet might not exist yet or be empty — that's fine
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Bookings!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  // Bold + freeze header row
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    });
    const bookingsSheet = meta.data.sheets?.find(
      s => s.properties?.title === 'Bookings'
    );
    if (bookingsSheet?.properties?.sheetId != null) {
      const sheetId = bookingsSheet.properties.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                  },
                },
                fields: 'userEnteredFormat.textFormat.bold',
              },
            },
            {
              updateSheetProperties: {
                properties: {
                  sheetId,
                  gridProperties: { frozenRowCount: 1 },
                },
                fields: 'gridProperties.frozenRowCount',
              },
            },
          ],
        },
      });
    }
  } catch {
    // Non-critical — formatting is nice-to-have
  }

  console.log(JSON.stringify({
    status: 'success',
    rowsSynced: bookings.length,
    spreadsheetId,
  }));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
