#!/usr/bin/env npx tsx
/**
 * check-access.ts — Is the Google Business Profile API approved for this project yet?
 *
 * After enabling the GBP APIs, Google ships the project with a 0/min quota until a
 * separate access-request form is approved. This probes the Account Management API
 * with the service account and reports a plain verdict so a scheduled reminder can
 * tell Blayke whether GBP is ready to wire.
 *
 * Usage:  npx tsx tools/gbp/check-access.ts
 * Env:    GOOGLE_SERVICE_ACCOUNT_KEY
 *
 * Verdicts:
 *   APPROVED      — accounts listed; ready to wire (fill GBP_ACCOUNT_ID + location ids)
 *   PENDING       — quota still 0 (RESOURCE_EXHAUSTED); access form not approved yet
 *   API_DISABLED  — an API got turned off again (regression)
 *   NO_ACCESS     — API works but SA isn't a manager on any profile
 *   UNKNOWN       — unexpected response (printed for inspection)
 */

import { google } from 'googleapis';

type Verdict = 'APPROVED' | 'PENDING' | 'API_DISABLED' | 'NO_ACCESS' | 'UNKNOWN';

function out(verdict: Verdict, summary: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ status: 'success', verdict, summary, ...extra }));
}

async function main(): Promise<void> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.log(JSON.stringify({ status: 'error', verdict: 'UNKNOWN', summary: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY.' }));
    process.exit(0);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(keyJson),
    scopes: ['https://www.googleapis.com/auth/business.manage'],
  });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;

  const res = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bodyText = await res.text();
  let body: any = null;
  try { body = JSON.parse(bodyText); } catch { /* non-JSON */ }

  if (res.status === 200) {
    const accounts = (body?.accounts || []) as Array<{ name?: string; accountName?: string }>;
    if (accounts.length === 0) {
      return out('NO_ACCESS', 'API is approved, but the service account is not a Manager on any Business Profile yet. Add nanoclaw@nanoclaw-sheets.iam.gserviceaccount.com as a Manager.');
    }
    return out('APPROVED', `Approved and ready to wire — ${accounts.length} account(s) visible to the service account.`, {
      accounts: accounts.map((a) => ({ name: a.name, accountName: a.accountName })),
    });
  }

  const reason = body?.error?.status || '';
  const message = body?.error?.message || bodyText.slice(0, 300);

  if (res.status === 429 || reason === 'RESOURCE_EXHAUSTED') {
    return out('PENDING', 'Not approved yet — GBP API quota is still 0 (access-request form pending Google approval).', { httpStatus: res.status });
  }
  if (reason === 'PERMISSION_DENIED' && /SERVICE_DISABLED|has not been used in project|is disabled/i.test(message)) {
    return out('API_DISABLED', 'A Business Profile API is disabled again — re-enable it in Cloud Console.', { httpStatus: res.status });
  }
  if (res.status === 403) {
    return out('NO_ACCESS', `Access denied (403): ${message}`, { httpStatus: res.status });
  }
  return out('UNKNOWN', `Unexpected response (HTTP ${res.status}): ${message}`, { httpStatus: res.status });
}

main().catch((err: unknown) => {
  console.log(JSON.stringify({ status: 'error', verdict: 'UNKNOWN', summary: err instanceof Error ? err.message : String(err) }));
  process.exit(0);
});
