#!/usr/bin/env npx tsx
/**
 * Andy-facing payment-link mint CLI.
 *
 * Wraps POST /api/agent-payment-link/:bookingId on the Sheridan booking service.
 * Use this AFTER the customer has uploaded their license AND signed the rental
 * agreement. The server enforces both prerequisites — calling early returns 412.
 *
 * Usage:
 *   npx tsx tools/booking/mint-payment-link.ts --booking SR-A1B2C3D4
 *
 * Flags:
 *   --booking <SR-XXXXXXXX>      required — the bookingId returned by create-booking
 *
 * Env:
 *   BOOKING_API_BASE      default https://chat.sheridantrailerrentals.us
 *   AGENT_API_TOKEN       required — must match the server's value
 *
 * Output (success):
 *   {"status":"success","paymentUrl":"https://square.link/u/...","orderId":"..."}
 * Output (prerequisites missing):
 *   {"status":"error","error":"license_missing" | "agreement_missing","httpStatus":412}
 */

interface Args { booking?: string; }

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--booking' && i + 1 < argv.length) args.booking = argv[++i];
  }
  return args;
}

function fail(msg: string, httpStatus = 0): never {
  console.log(JSON.stringify({ status: 'error', error: msg, httpStatus }));
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.booking || !/^SR-[A-F0-9]{8}$/.test(args.booking)) {
    fail('--booking SR-XXXXXXXX is required');
  }
  const base = process.env.BOOKING_API_BASE || 'https://chat.sheridantrailerrentals.us';
  const token = process.env.AGENT_API_TOKEN;
  if (!token) fail('AGENT_API_TOKEN env var is required');

  let res: Response;
  try {
    res = await fetch(`${base}/api/agent-payment-link/${encodeURIComponent(args.booking!)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': token! },
    });
  } catch (err: any) {
    fail(`Network error: ${err?.message || String(err)}`);
  }

  const text = await res!.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

  if (!res!.ok) {
    fail(parsed.error || `HTTP ${res!.status}`, res!.status);
  }
  console.log(JSON.stringify({ status: 'success', ...parsed }));
}

main().catch(err => fail(err?.message || String(err)));
