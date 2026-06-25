/**
 * Server-side conversion tracking + device detection.
 *
 * WHY: all conversion tracking used to live in form.html and only fired when the
 * customer RETURNED from Square to /form?booking=… and the poll succeeded. Mobile
 * users (70% of traffic) pay and close the tab → the client event never fired, so
 * GA4 under-counted real bookings ~3-5× and mobile read as $0. This fires the
 * conversion from the webhook on confirmed payment instead — counted regardless of
 * device, return behavior, or channel.
 */
import http from 'http';
import type { Booking } from './types.js';

/** Parse a coarse device category from the checkout User-Agent. Ground-truth, server-side. */
export function parseDevice(userAgent: string | undefined): 'mobile' | 'tablet' | 'desktop' {
  const ua = (userAgent || '').toLowerCase();
  if (!ua) return 'desktop';
  // Tablets first (iPad UA also contains "mobile"-ish tokens on some versions).
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini|windows phone/.test(ua)) return 'mobile';
  return 'desktop';
}

/**
 * Fire the GA4 purchase event via the Measurement Protocol. Because the GA4
 * property is linked to Google Ads, marking this `purchase` as an imported
 * conversion in Ads covers the Ads side too (no Ads API creds needed here).
 * Best-effort: never throws into the webhook path.
 */
export async function sendGa4Purchase(booking: Booking): Promise<{ ok: boolean; reason?: string }> {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) {
    return { ok: false, reason: 'GA4_MEASUREMENT_ID / GA4_API_SECRET not set' };
  }

  // Amount actually collected at checkout (deposit or full), mirrors the client event.
  const value = Number((booking.subtotal + booking.deposit - booking.balance).toFixed(2));
  // GA4 needs a client_id. Use the one captured from the _ga cookie so the
  // conversion joins the original session/source; fall back to a synthetic id
  // (still counts the conversion, just unattributed to a prior session).
  const clientId = booking.gaClientId || `${Math.floor(Math.random() * 1e10)}.${Math.floor(Date.now() / 1000)}`;

  const body = JSON.stringify({
    client_id: clientId,
    events: [
      {
        name: 'purchase',
        params: {
          transaction_id: booking.id,
          value,
          currency: 'USD',
          // session_id + a non-zero engagement time let GA4 stitch this server-side
          // purchase onto the SAME funnel session the browser opened, so the ordered
          // funnel finally credits mobile pay-and-close buyers. Omitted if unknown
          // (older bookings) — the conversion still counts, just session-unattributed.
          ...(booking.gaSessionId ? { session_id: booking.gaSessionId, engagement_time_msec: 1 } : {}),
          // Custom param so we can segment conversions by the TRUE device server-side.
          device_category: booking.device || 'unknown',
          items: [
            {
              item_id: booking.equipment,
              item_name: booking.equipmentLabel || booking.equipment,
              price: value,
              quantity: 1,
            },
          ],
        },
      },
    ],
  });

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(
    measurementId,
  )}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    // MP returns 204 on success; 2xx is fine.
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, reason: `GA4 MP HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, reason: `GA4 MP error: ${err?.message || err}` };
  }
}

/** Extract the GA4 client_id from a raw Cookie header (_ga=GA1.1.<cid>.<ts> → "<cid>.<ts>"). */
export function gaClientIdFromCookie(cookieHeader: string | undefined): string {
  if (!cookieHeader) return '';
  const m = cookieHeader.match(/(?:^|;\s*)_ga=GA\d\.\d\.([\d]+\.[\d]+)/);
  return m ? m[1] : '';
}

/** Best-effort client IP (for completeness / future use). */
export function clientIp(req: http.IncomingMessage): string {
  const xff = (req.headers['x-forwarded-for'] as string) || '';
  return xff.split(',')[0].trim() || req.socket.remoteAddress || '';
}
