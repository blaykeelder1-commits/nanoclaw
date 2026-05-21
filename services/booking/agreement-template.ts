// Sheridan Trailer Rentals — single smart Rental Agreement.
//
// One template that conditionally renders RV-specific or trailer-specific
// clauses based on the booking's equipment kind. SHA-256 of the canonical
// text rendering is stored on every signed row so the version a customer
// signed remains provable even if this file is edited later. Bump VERSION
// whenever clause wording changes — old signatures still verify against
// their own captured version + hash.

import crypto from 'crypto';
import type { AgreementContext, AgreementKind } from './types.js';

export const VERSION = '1.1.0' as const;

export function kindForEquipment(equipment: string): AgreementKind {
  if (equipment === 'rv') return 'sheridan-rv';
  if (equipment === 'carhauler') return 'sheridan-hauler';
  return 'sheridan-landscaping';
}

interface Clause { title: string; body: string; }

function clausesForKind(kind: AgreementKind, ctx: AgreementContext): Clause[] {
  const isRv = kind === 'sheridan-rv';
  const depositLine = isRv
    ? (ctx.hasDelivery ? '$250 refundable damage deposit (RV delivery)' : '$500 refundable damage deposit (RV pickup)')
    : '$50 refundable damage deposit';

  return [
    {
      title: 'Rental Period',
      body: isRv
        ? `Rental term is billed by night (minimum 2 calendar dates selected). Late returns are billed as additional nights at the standard nightly rate.`
        : `Rental term is billed by day. Late returns are billed as additional days at the standard daily rate.`,
    },
    {
      title: 'Payment & Deposit',
      body: `${depositLine}, held against final inspection and returned after the equipment is verified clean and undamaged.`,
    },
    {
      title: 'Prohibited Use',
      body: isRv
        ? `No off-road use. No transport of hazardous, flammable, or illegal cargo. No smoking inside the camper. Pets only with prior written approval.`
        : `Trailer GVWR is 5,000 lbs — do not exceed this rating. No transport of hazardous, flammable, or illegal cargo. Off-road towing voids damage coverage.`,
    },
    {
      title: 'Damage',
      body: `Renter is responsible for all damage occurring during the rental period — including tires, axles, suspension, exterior body, and interior (where applicable). Damage is assessed against the deposit; any balance is billed if it exceeds the deposit.`,
    },
    {
      title: 'Insurance',
      body: isRv
        ? `Renter must maintain active auto insurance on the tow vehicle used during the rental. Sheridan Trailer Rentals' insurance does not cover renter-caused damage.`
        : `Renter must maintain active auto insurance on the tow vehicle used to tow the trailer. Sheridan Trailer Rentals' insurance does not cover renter-caused damage.`,
    },
    {
      title: 'Pickup / Drop-off',
      body: isRv && ctx.hasDelivery
        ? `Delivery to ${ctx.deliveryAddress || 'the agreed delivery address'}. Pickup at end of rental window. Lock code emailed before the rental start date.`
        : `Pickup and return at 14235 Alice Road, Tomball, TX 77377. Lock code emailed before the rental start date.`,
    },
    {
      title: 'Cancellation',
      body: `Cancellations must be made at least 24 hours in advance of the rental start date for a full refund of the rental rate. The damage deposit is fully refundable until pickup.`,
    },
    {
      title: 'Governing Law',
      body: `This agreement is governed by the laws of the State of Texas.`,
    },
  ];
}

const ACCEPTANCE_NOTE = 'PAYMENT OF ANY INVOICE ISSUED BY SHERIDAN TRAILER RENTALS CONSTITUTES FULL ACCEPTANCE OF ALL TERMS AND CONDITIONS IN THIS AGREEMENT.';

/**
 * Canonical plain-text rendering. Used for the SHA-256 content hash. Stable
 * line endings and no localization so the hash is reproducible across runs.
 */
export function renderText(kind: AgreementKind, ctx: AgreementContext): string {
  const lines: string[] = [];
  lines.push(`Sheridan Trailer Rentals — Rental Agreement (v${VERSION})`);
  lines.push('');
  lines.push(`Booking: ${ctx.bookingId}`);
  lines.push(`Equipment: ${ctx.equipmentLabel}`);
  lines.push(`Customer: ${ctx.customerName} <${ctx.customerEmail}>`);
  lines.push(`Dates: ${ctx.dates.join(', ')}`);
  lines.push(`Term: ${ctx.numDays} ${ctx.unit}${ctx.numDays === 1 ? '' : 's'}`);
  if (ctx.hasDelivery && ctx.deliveryAddress) lines.push(`Delivery address: ${ctx.deliveryAddress}`);
  lines.push(`Total: $${ctx.total.toFixed(2)}  (deposit $${ctx.deposit.toFixed(2)})`);
  lines.push('');
  clausesForKind(kind, ctx).forEach((c, i) => {
    lines.push(`${i + 1}. ${c.title}: ${c.body}`);
  });
  lines.push('');
  lines.push(ACCEPTANCE_NOTE);
  return lines.join('\n');
}

/**
 * Branded HTML rendering for the signing UI and the read-only `/api/agreements/:id` view.
 * Inline styles only — survives in plain-HTML email clients and print-to-PDF.
 */
export function renderHtml(kind: AgreementKind, ctx: AgreementContext): string {
  const clauses = clausesForKind(kind, ctx)
    .map((c, i) => `<p style="margin:10px 0;line-height:1.55;"><strong>${i + 1}. ${esc(c.title)}:</strong> ${esc(c.body)}</p>`)
    .join('');
  const datesPretty = ctx.dates.length > 1
    ? `${esc(ctx.dates[0])} → ${esc(ctx.dates[ctx.dates.length - 1])}`
    : esc(ctx.dates[0] ?? '');
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#0f172a;max-width:720px;margin:0 auto;">
    <div style="text-align:center;padding:22px 16px 8px;background:#0f172a;border-radius:10px 10px 0 0;color:#fff;">
      <div style="font-weight:900;font-size:20px;letter-spacing:.04em;color:#22d3ee;">SHERIDAN</div>
      <div style="font-size:12px;letter-spacing:.18em;color:#94a3b8;margin-top:2px;">TRAILER RENTALS</div>
    </div>
    <h1 style="text-align:center;color:#0e7490;font-size:24px;margin:16px 0 4px;">Rental Agreement</h1>
    <div style="height:2px;background:#0891b2;margin:0 auto 18px;max-width:480px;opacity:.4;"></div>
    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px 18px;margin-bottom:16px;font-size:14px;">
      <div><strong>Booking:</strong> ${esc(ctx.bookingId)}</div>
      <div><strong>Equipment:</strong> ${esc(ctx.equipmentLabel)}</div>
      <div><strong>Customer:</strong> ${esc(ctx.customerName)}</div>
      <div><strong>Dates:</strong> ${datesPretty} &nbsp;·&nbsp; <strong>Term:</strong> ${ctx.numDays} ${esc(ctx.unit)}${ctx.numDays === 1 ? '' : 's'}</div>
      ${ctx.hasDelivery && ctx.deliveryAddress ? `<div><strong>Delivery to:</strong> ${esc(ctx.deliveryAddress)}</div>` : ''}
      <div><strong>Total:</strong> $${ctx.total.toFixed(2)} (deposit $${ctx.deposit.toFixed(2)})</div>
    </div>
    ${clauses}
    <div style="background:#0891b2;color:#fff;padding:12px 16px;border-radius:8px;font-weight:700;margin:18px 0;text-align:center;line-height:1.45;">
      ${esc(ACCEPTANCE_NOTE)}
    </div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px;" />
    <p style="text-align:center;color:#64748b;font-size:12px;line-height:1.6;margin:0;">
      <strong style="color:#0f172a;">Sheridan Trailer Rentals</strong><br/>
      14235 Alice Road, Tomball, TX 77377<br/>
      (817) 587-1460<br/>
      sheridantrailerrentals.us
    </p>
  </div>`;
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
