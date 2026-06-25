#!/usr/bin/env npx tsx
/**
 * Google Analytics 4 Tool for NanoClaw
 *
 * Drives GA4 setup + reporting via the Admin API (key events) and Data API
 * (funnel reporting) using the shared service account — no browser UI, which
 * is required because the GA4 web SPA never reaches document_idle and hangs
 * Chrome automation.
 *
 * Usage:
 *   npx tsx tools/analytics/ga4.ts status                       # probe access, list data streams + key events
 *   npx tsx tools/analytics/ga4.ts mark-key-events [--events purchase,begin_checkout,step3_info]
 *   npx tsx tools/analytics/ga4.ts funnel [--days 28]           # per-device drop-off across the booking steps
 *
 * Environment variables (read from process.env, else from .env):
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON string of the service account key
 *   GA4_PROPERTY_ID            — numeric GA4 property id (default 535560959 = Sheridan)
 *
 * NOTE: the service account (nanoclaw@nanoclaw-sheets.iam.gserviceaccount.com) must be
 * added as a user on the GA4 property — Editor to create key events, Viewer to read reports.
 */
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const DEFAULT_PROPERTY = '535560959'; // Sheridan Trailer Rentals (G-HB9MXHDWFG)

// Ordered booking funnel as emitted by sheridan-site/form.html + server-side purchase.
const FUNNEL_STEPS = [
  'step1_equipment',
  'step2_dates',
  'step3_info',
  'step4_review',
  'begin_checkout',
  'purchase',
];

// Events worth marking as key events (Ads optimization signal).
const DEFAULT_KEY_EVENTS = ['purchase', 'begin_checkout', 'step3_info'];

// ── env ─────────────────────────────────────────────────────────────

function loadEnv(keys: string[]): void {
  let content: string;
  try {
    content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
  } catch {
    return;
  }
  const wanted = new Set(keys);
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!wanted.has(key) || process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
}

function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.error(JSON.stringify({ status: 'error', error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY.' }));
    process.exit(1);
  }
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(keyJson);
  } catch {
    console.error(JSON.stringify({ status: 'error', error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.' }));
    process.exit(1);
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/analytics.edit',     // create key events
      'https://www.googleapis.com/auth/analytics.readonly', // run reports
    ],
  });
}

function property(): string {
  return process.env.GA4_PROPERTY_ID || DEFAULT_PROPERTY;
}

function fail(action: string, err: any): never {
  const apiErr = err?.response?.data?.error || err?.errors?.[0] || {};
  const code = err?.code || apiErr?.code;
  const message = apiErr?.message || err?.message || String(err);
  let hint = '';
  if (code === 403 && /permission|caller does not have/i.test(message)) {
    hint =
      'The service account is not granted access to this GA4 property. ' +
      'ROADBLOCK (owner click): GA4 Admin > Property Access Management > add ' +
      'nanoclaw@nanoclaw-sheets.iam.gserviceaccount.com as Editor.';
  } else if (code === 403 && /SERVICE_DISABLED|has not been used|disabled/i.test(message)) {
    hint =
      'The GA4 API is not enabled in project nanoclaw-sheets. ' +
      'ROADBLOCK (owner click): enable Google Analytics Admin API + Data API in the Cloud console.';
  }
  console.error(JSON.stringify({ status: 'error', action, code, error: message, hint }, null, 2));
  process.exit(1);
}

// ── actions ─────────────────────────────────────────────────────────

async function status(auth: any) {
  const admin = google.analyticsadmin({ version: 'v1beta', auth });
  const parent = `properties/${property()}`;

  const prop = await admin.properties.get({ name: parent }).catch((e) => fail('status', e));
  const streams = await admin.properties.dataStreams.list({ parent }).catch((e) => fail('status', e));
  const keyEvents = await admin.properties.keyEvents.list({ parent }).catch((e) => fail('status', e));

  console.log(JSON.stringify({
    status: 'success',
    property: { name: prop.data.name, displayName: prop.data.displayName, timeZone: prop.data.timeZone, currencyCode: prop.data.currencyCode },
    dataStreams: (streams.data.dataStreams || []).map((s) => ({
      displayName: s.displayName,
      measurementId: s.webStreamData?.measurementId,
      defaultUri: s.webStreamData?.defaultUri,
    })),
    keyEvents: (keyEvents.data.keyEvents || []).map((k) => k.eventName),
  }, null, 2));
}

async function markKeyEvents(auth: any, events: string[]) {
  const admin = google.analyticsadmin({ version: 'v1beta', auth });
  const parent = `properties/${property()}`;

  const existing = await admin.properties.keyEvents.list({ parent }).catch((e) => fail('mark-key-events', e));
  const have = new Set((existing.data.keyEvents || []).map((k) => k.eventName));

  const results: Array<{ event: string; result: string }> = [];
  for (const eventName of events) {
    if (have.has(eventName)) {
      results.push({ event: eventName, result: 'already-key-event' });
      continue;
    }
    try {
      await admin.properties.keyEvents.create({
        parent,
        requestBody: { eventName, countingMethod: 'ONCE_PER_EVENT' },
      });
      results.push({ event: eventName, result: 'created' });
    } catch (e: any) {
      const msg = e?.response?.data?.error?.message || e?.message || String(e);
      if (/already exists/i.test(msg)) results.push({ event: eventName, result: 'already-key-event' });
      else results.push({ event: eventName, result: `error: ${msg}` });
    }
  }
  console.log(JSON.stringify({ status: 'success', action: 'mark-key-events', results }, null, 2));
}

// True ordered funnel via the Data API v1alpha runFunnelReport (not exposed by
// googleapis in this version, so we call REST directly with the SA token).
// Entry step is step2_dates: step1_equipment is the landing step and never fires
// goToStep(1), so the real top-of-funnel is "reached the calendar".
const FUNNEL_DEF = [
  { name: '1. Dates (calendar)', event: 'step2_dates' },
  { name: '2. Your info', event: 'step3_info' },
  { name: '3. Review', event: 'step4_review' },
  { name: '4. Checkout', event: 'begin_checkout' },
  { name: '5. Purchase', event: 'purchase' },
];

async function funnel(auth: any, days: number) {
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
  if (!token) throw new Error('Failed to obtain access token.');

  const body = {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    funnelBreakdown: { breakdownDimension: { name: 'deviceCategory' }, limit: 5 },
    funnel: {
      isOpenFunnel: false,
      steps: FUNNEL_DEF.map((s) => ({
        name: s.name,
        filterExpression: { funnelEventFilter: { eventName: s.event } },
      })),
    },
  };

  const url = `https://analyticsdata.googleapis.com/v1alpha/properties/${property()}:runFunnelReport`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await resp.json();
  if (!resp.ok) fail('funnel', { code: resp.status, response: { data: json } });

  // funnelTable rows: dimensionValues = [funnelStepName, deviceCategory];
  // metricValues = [activeUsers, completionRate, abandonments, abandonmentRate].
  // The API prepends its own ordinal ("1. ") to each step name, so key by that ordinal.
  const table = json.funnelTable;
  const byDevice: Record<string, Record<number, { users: number; completionRate: number }>> = {};
  for (const row of table?.rows || []) {
    const stepName = row.dimensionValues?.[0]?.value || '';
    const ord = parseInt(stepName.match(/^(\d+)\./)?.[1] || '0', 10);
    const device = row.dimensionValues?.[1]?.value || 'all';
    const users = parseInt(row.metricValues?.[0]?.value || '0', 10);
    const completionRate = parseFloat(row.metricValues?.[1]?.value || '0');
    (byDevice[device] ||= {})[ord] = { users, completionRate };
  }

  const report: Record<string, any> = {};
  for (const [device, steps] of Object.entries(byDevice)) {
    const top = steps[1]?.users || 0;
    report[device] = FUNNEL_DEF.map((s, i) => {
      const cell = steps[i + 1] || { users: 0, completionRate: 0 };
      return {
        step: s.name,
        users: cell.users,
        pctOfEntry: top ? Math.round((cell.users / top) * 100) : 0,
        // completionRate = fraction of THIS step's users who advance to the next step
        toNextStep: i < FUNNEL_DEF.length - 1 ? `${Math.round(cell.completionRate * 100)}%` : '—',
        abandonHere: i < FUNNEL_DEF.length - 1 ? `${Math.round((1 - cell.completionRate) * 100)}%` : '—',
      };
    });
  }

  console.log(JSON.stringify({
    status: 'success',
    action: 'funnel',
    window: `${days} days`,
    property: property(),
    note: 'Ordered funnel (runFunnelReport). users = active users completing each step in order. ' +
      'Entry = step2_dates (reached calendar); step1_equipment intentionally excluded (landing step, not yet instrumented).',
    funnelByDevice: report,
  }, null, 2));
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  loadEnv(['GOOGLE_SERVICE_ACCOUNT_KEY', 'GA4_PROPERTY_ID']);
  const argv = process.argv.slice(2);
  const action = argv[0];
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) flags[argv[i].slice(2)] = argv[++i];
  }

  const auth = getAuth();

  switch (action) {
    case 'status':
      await status(auth);
      break;
    case 'mark-key-events':
      await markKeyEvents(auth, flags.events ? flags.events.split(',').map((s) => s.trim()) : DEFAULT_KEY_EVENTS);
      break;
    case 'funnel':
      await funnel(auth, flags.days ? parseInt(flags.days, 10) : 28);
      break;
    default:
      console.error(JSON.stringify({
        status: 'error',
        error: `Unknown action "${action}". Use: status | mark-key-events | funnel`,
      }));
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ status: 'error', error: err?.message || String(err) }));
  process.exit(1);
});
