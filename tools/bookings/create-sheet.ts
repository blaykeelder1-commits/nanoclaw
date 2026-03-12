#!/usr/bin/env npx tsx
/**
 * Create a new Google Spreadsheet for Sheridan Bookings Dashboard
 *
 * Usage:
 *   npx tsx tools/bookings/create-sheet.ts --share-with blayke.elder1@gmail.com
 *
 * Environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON string of the service account key
 */

import { google } from 'googleapis';

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

function parseArgs(): { shareWith: string } {
  const argv = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  const shareWith = flags['share-with'];
  if (!shareWith) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing required --share-with flag',
      usage: 'npx tsx tools/bookings/create-sheet.ts --share-with user@example.com',
    }));
    process.exit(1);
  }

  return { shareWith };
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

  return {
    auth: new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ],
    }),
    clientEmail: key.client_email,
  };
}

async function main() {
  const { shareWith } = parseArgs();
  const { auth, clientEmail } = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Create spreadsheet with two sheets
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: 'Sheridan Rentals \u2014 Booking Dashboard',
      },
      sheets: [
        {
          properties: {
            title: 'Bookings',
            sheetId: 0,
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
        {
          properties: {
            title: 'This Week',
            sheetId: 1,
          },
        },
      ],
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId!;

  // Write headers to Bookings sheet
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Bookings!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADERS] },
  });

  // Bold header row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
              },
            },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
      ],
    },
  });

  // Share with the specified email (requires Drive API enabled)
  let shared = false;
  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: shareWith,
      },
      sendNotificationEmail: true,
    });
    shared = true;
  } catch (err) {
    // Drive API might not be enabled — sheet is still created, just needs manual sharing
    console.error(JSON.stringify({
      warning: `Could not auto-share (Drive API may not be enabled). Manually share the sheet with: ${shareWith}`,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  console.log(JSON.stringify({
    status: 'success',
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    sharedWith: shared ? shareWith : 'MANUAL_SHARE_NEEDED',
    serviceAccount: clientEmail,
    hint: `Add this to your .env: SHERIDAN_BOOKINGS_SHEET_ID=${spreadsheetId}`,
  }));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
