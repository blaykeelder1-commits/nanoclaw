#!/usr/bin/env npx tsx
/**
 * Andy-facing booking creation CLI.
 *
 * Wraps POST /api/agent-checkout on the Sheridan booking service.
 * Used by the booking-close skill when a customer confirms dates + equipment
 * inside a chat conversation. Returns JSON with the bookingId, payment URL,
 * and the license-upload URL to send to the customer.
 *
 * Usage:
 *   npx tsx tools/booking/create-booking.ts \
 *     --equipment rv \
 *     --dates 2026-06-20,2026-06-21,2026-06-22 \
 *     --first-name Jane --last-name Doe \
 *     --phone "+18175551234" --email jane@example.com \
 *     --delivery-address "123 Main St, Brenham TX" \
 *     --payment-mode deposit
 *
 * Flags:
 *   --equipment <rv|carhauler|landscaping>   required
 *   --dates    <YYYY-MM-DD,YYYY-MM-DD,...>   required (sorted, comma-separated)
 *   --first-name / --last-name               required
 *   --phone <E.164 or US 10-digit>           required
 *   --email <email>                          required
 *   --delivery-address <addr>                required for RV (unless RIVER promo)
 *   --payment-mode <full|deposit>            optional, default full
 *   --add-ons <comma list>                   optional, e.g. "delivery,generator"
 *   --promo <code>                           optional (e.g. RIVER)
 *   --details <free text>                    optional notes for the owner
 *   --dry-run                                print the payload, do not POST
 *
 * Env:
 *   BOOKING_API_BASE      default https://chat.sheridantrailerrentals.us
 *   AGENT_API_TOKEN       required — must match the server's value
 *
 * Output: single-line JSON. On success:
 *   {"status":"success","bookingId":"SR-...","paymentUrl":"https://...","licenseUploadUrl":"https://...","pricing":{...}}
 * On error:
 *   {"status":"error","error":"<message>","httpStatus":<n>}
 */

interface Args {
  equipment?: string;
  dates?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  deliveryAddress?: string;
  paymentMode?: string;
  addOns?: string;
  promo?: string;
  details?: string;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): Args {
  const flagMap: Record<string, keyof Args> = {
    '--equipment': 'equipment',
    '--dates': 'dates',
    '--first-name': 'firstName',
    '--last-name': 'lastName',
    '--phone': 'phone',
    '--email': 'email',
    '--delivery-address': 'deliveryAddress',
    '--payment-mode': 'paymentMode',
    '--add-ons': 'addOns',
    '--promo': 'promo',
    '--details': 'details',
  };
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const key = flagMap[a];
    if (key && i + 1 < argv.length) {
      (args as any)[key] = argv[++i];
    }
  }
  return args;
}

function fail(msg: string, httpStatus = 0): never {
  console.log(JSON.stringify({ status: 'error', error: msg, httpStatus }));
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.equipment || !['rv', 'carhauler', 'landscaping'].includes(args.equipment)) {
    fail('--equipment must be one of: rv, carhauler, landscaping');
  }
  if (!args.dates) fail('--dates is required (comma-separated YYYY-MM-DD)');
  if (!args.firstName || !args.lastName) fail('--first-name and --last-name required');
  if (!args.phone) fail('--phone required');
  if (!args.email) fail('--email required');

  const dates = args.dates!.split(',').map(s => s.trim()).filter(Boolean);
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(`Invalid date "${d}" — must be YYYY-MM-DD`);
  }

  const addOns = args.addOns ? args.addOns.split(',').map(s => s.trim()).filter(Boolean) : [];
  const paymentMode = args.paymentMode === 'deposit' ? 'deposit' : 'full';

  const payload = {
    equipment: args.equipment,
    dates,
    customer: {
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
    },
    addOns,
    paymentMode,
    promoCode: args.promo,
    deliveryAddress: args.deliveryAddress,
    details: args.details,
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ status: 'dry-run', payload }, null, 2));
    return;
  }

  const base = process.env.BOOKING_API_BASE || 'https://chat.sheridantrailerrentals.us';
  const token = process.env.AGENT_API_TOKEN;
  if (!token) fail('AGENT_API_TOKEN env var is required');

  let res: Response;
  try {
    res = await fetch(`${base}/api/agent-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': token!,
      },
      body: JSON.stringify(payload),
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
