#!/usr/bin/env npx tsx
/**
 * Google Sheets Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/sheets/sheets.ts read --range "Sheet1!A1:D10"
 *   npx tsx tools/sheets/sheets.ts write --range "Sheet1!A1" --values '[["val1","val2"],["val3","val4"]]'
 *   npx tsx tools/sheets/sheets.ts append --range "Sheet1!A:D" --values '[["val1","val2","val3","val4"]]'
 *   npx tsx tools/sheets/sheets.ts info
 *
 * Environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — JSON string of the service account key
 *   GOOGLE_SPREADSHEET_ID      — The spreadsheet ID (from the URL)
 */

import { google, sheets_v4 } from 'googleapis';

type Action = 'read' | 'write' | 'append' | 'info';

interface Args {
  action: Action;
  range?: string;
  values?: string[][];
  valueInput?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;

  if (!['read', 'write', 'append', 'info'].includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: read, write, append, info`,
      usage: [
        'npx tsx tools/sheets/sheets.ts read --range "Sheet1!A1:D10"',
        'npx tsx tools/sheets/sheets.ts write --range "Sheet1!A1" --values \'[["a","b"]]\'',
        'npx tsx tools/sheets/sheets.ts append --range "Sheet1!A:D" --values \'[["a","b"]]\'',
        'npx tsx tools/sheets/sheets.ts info',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  let values: string[][] | undefined;
  if (flags.values) {
    try {
      values = JSON.parse(flags.values);
    } catch {
      console.error(JSON.stringify({
        status: 'error',
        error: 'Invalid --values JSON. Must be a 2D array: [["a","b"],["c","d"]]',
      }));
      process.exit(1);
    }
  }

  return {
    action,
    range: flags.range,
    values,
    valueInput: flags['value-input'] || 'USER_ENTERED',
  };
}

function getAuth(): { auth: InstanceType<typeof google.auth.JWT>; spreadsheetId: string } {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!keyJson) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable. Set it to the JSON string of your service account key.',
    }));
    process.exit(1);
  }
  if (!spreadsheetId) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SPREADSHEET_ID environment variable.',
    }));
    process.exit(1);
  }

  let key: { client_email: string; private_key: string; project_id?: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    console.error(JSON.stringify({
      status: 'error',
      error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.',
    }));
    process.exit(1);
  }

  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return { auth, spreadsheetId };
}

function getSheets(auth: InstanceType<typeof google.auth.JWT>): sheets_v4.Sheets {
  return google.sheets({ version: 'v4', auth });
}

async function readRange(sheets: sheets_v4.Sheets, spreadsheetId: string, range: string) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  console.log(JSON.stringify({
    status: 'success',
    action: 'read',
    range,
    values: res.data.values || [],
    rowCount: (res.data.values || []).length,
  }));
}

async function writeRange(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
  values: string[][],
  valueInput: string,
) {
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: valueInput as 'USER_ENTERED' | 'RAW',
    requestBody: { values },
  });
  console.log(JSON.stringify({
    status: 'success',
    action: 'write',
    range,
    updatedCells: res.data.updatedCells,
    updatedRows: res.data.updatedRows,
    updatedColumns: res.data.updatedColumns,
  }));
}

async function appendRange(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
  values: string[][],
  valueInput: string,
) {
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: valueInput as 'USER_ENTERED' | 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  console.log(JSON.stringify({
    status: 'success',
    action: 'append',
    range,
    updatedRange: res.data.updates?.updatedRange,
    updatedRows: res.data.updates?.updatedRows,
    updatedCells: res.data.updates?.updatedCells,
  }));
}

async function getInfo(sheets: sheets_v4.Sheets, spreadsheetId: string) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  });
  const sheetList = (res.data.sheets || []).map(s => ({
    title: s.properties?.title,
    sheetId: s.properties?.sheetId,
    rowCount: s.properties?.gridProperties?.rowCount,
    columnCount: s.properties?.gridProperties?.columnCount,
  }));
  console.log(JSON.stringify({
    status: 'success',
    action: 'info',
    title: res.data.properties?.title,
    sheets: sheetList,
  }));
}

async function main() {
  const args = parseArgs();
  const { auth, spreadsheetId } = getAuth();
  const sheets = getSheets(auth);

  try {
    switch (args.action) {
      case 'read':
        if (!args.range) {
          console.error(JSON.stringify({ status: 'error', error: 'read requires --range' }));
          process.exit(1);
        }
        await readRange(sheets, spreadsheetId, args.range);
        break;

      case 'write':
        if (!args.range || !args.values) {
          console.error(JSON.stringify({ status: 'error', error: 'write requires --range and --values' }));
          process.exit(1);
        }
        await writeRange(sheets, spreadsheetId, args.range, args.values, args.valueInput || 'USER_ENTERED');
        break;

      case 'append':
        if (!args.range || !args.values) {
          console.error(JSON.stringify({ status: 'error', error: 'append requires --range and --values' }));
          process.exit(1);
        }
        await appendRange(sheets, spreadsheetId, args.range, args.values, args.valueInput || 'USER_ENTERED');
        break;

      case 'info':
        await getInfo(sheets, spreadsheetId);
        break;
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
