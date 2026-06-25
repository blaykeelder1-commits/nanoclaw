/**
 * Sheridan Rentals Booking API Server
 *
 * Lightweight HTTP server (no Express). Listens on BOOKING_PORT (3201 in prod;
 * Caddy routes all /api/booking traffic here). Port 3200 is the web-chat channel.
 * Endpoints:
 *   POST /api/availability      — Check booked date ranges from Google Calendar
 *   POST /api/checkout          — Validate, price, create Square payment link, store booking
 *   POST /api/square-webhook    — Payment confirmation → calendar event + email
 *   POST /api/upload            — License photo upload (multipart)
 *   POST /api/upload-inspection — Car hauler inspection photo upload (multipart)
 *   GET  /api/inspection/:id    — List inspection photos for a booking
 *   POST /api/cancel            — Cancel a booking (+optional refund)
 *   GET  /api/booking/:id       — Confirmation page data
 *   GET  /health                — Health check
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';
import { EQUIPMENT, calculatePrice } from './pricing.js';
import { quoteDelivery, STANDARD_DELIVERY_FEE } from './geocode.js';
import { getBookedSlots, datesAreAvailable, createBookingEvent, deleteCalendarEvent } from './calendar.js';
import { createPaymentLink, checkOrderPayment, refundPayment } from './square.js';
import {
  initDb, generateBookingId, createBooking, getBooking,
  getBookingByOrderId, updateBookingStatus, setCalendarEventId,
  hasOverlappingBooking, cancelBooking, getActiveBookings, getBookingsByEmail,
  expireStalePendingBookings, getBookedDatesFromDb, clearBalance, setLicensePhoto,
  markOwnerNotified, getUnnotifiedPaidBookings, markLicenseSmsSent,
  generateAgreementId, generateAgreementToken, generateSignToken,
  createPreBookingAgreement, createBookingAgreement,
  getAgreement, getAgreementByToken, getAgreementForBooking,
  linkAgreementToBooking, getBookingBySignToken, setBookingPaymentLink,
  setBookingSignToken, setBookingPricingSnapshot, claimConversionSend,
} from './db.js';
import { parseDevice, gaClientIdFromCookie, sendGa4Purchase } from './analytics.js';
import {
  renderHtml as renderAgreementHtml,
  renderText as renderAgreementText,
  sha256Hex,
  kindForEquipment,
  VERSION as AGREEMENT_VERSION,
} from './agreement-template.js';
import {
  sendOwnerNotification, sendCustomerConfirmation,
  sendPaymentReceivedNotification, sendCancellationConfirmation,
  sendLicenseReceivedNotification,
} from './email.js';
import { sendQuoSMS } from './quo.js';
import type {
  AgentCheckoutRequest, AgreementContext, AvailabilityRequest,
  Booking, CheckoutRequest, EquipmentKey,
} from './types.js';

// ── Owner-Notification Coordinator ──────────────────────────────────

/**
 * IDs currently being sent an owner notification. Prevents the watchdog from
 * racing the webhook (or itself) when a send is slow (Gmail throttling, etc.).
 * Process-local; lost on restart, but the DB stamp is the canonical truth.
 */
const inFlightOwnerNotify = new Set<string>();

/**
 * Backup alert over ntfy.sh — an independent channel so a PAID booking is never
 * invisible when the owner-notification email fails. Same topic the NanoClaw
 * health monitor uses, so it lands in Blayke's existing alerts feed.
 */
function pushAlert(message: string): void {
  const topic = process.env.NANOCLAW_ALERT_TOPIC || 'nanoclaw-alerts';
  fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body: message,
    headers: { Title: 'Sheridan Booking Alert', Priority: '5' },
  }).catch((err) => console.error(`[pushAlert] ntfy failed: ${err?.message || err}`));
}

/**
 * Send the owner notification for a booking exactly once at a time.
 * Stamps owner_notified_at on success. On send failure, leaves the row
 * unstamped so the watchdog can retry on the next tick. On stamp failure
 * (DB error), surfaces the error explicitly without re-marking — the email
 * has already gone out, so the watchdog should NOT retry.
 */
async function notifyOwnerOnce(booking: Booking, source: 'webhook' | 'watchdog'): Promise<void> {
  if (inFlightOwnerNotify.has(booking.id)) return;
  inFlightOwnerNotify.add(booking.id);
  try {
    await sendOwnerNotification(booking);
    try {
      markOwnerNotified(booking.id);
      console.log(`[${source}] Owner notified for ${booking.id}`);
    } catch (e: any) {
      // Email succeeded; DB stamp failed. Logging here is critical — otherwise
      // the watchdog will resend every minute creating duplicate emails.
      console.error(`[${source}] CRITICAL: markOwnerNotified failed for ${booking.id} after successful send: ${e.message}. Manually run UPDATE bookings SET owner_notified_at=datetime('now') WHERE id='${booking.id}' to silence watchdog.`);
      pushAlert(`⚠️ Booking ${booking.id}: owner email SENT but DB stamp failed — watchdog may resend. ${e.message}`);
    }
  } catch (err: any) {
    const amountPaid = (booking.subtotal + booking.deposit - booking.balance).toFixed(2);
    console.error(`[${source}] CRITICAL: Owner notification email failed for ${booking.id}: ${err.message}. Customer: ${booking.customer.firstName} ${booking.customer.lastName} ${booking.customer.phone} ${booking.customer.email}. Paid $${amountPaid} for ${booking.equipmentLabel} on ${booking.dates.join(',')}. Watchdog will retry every 60s.`);
    // Email is down — page over an independent channel so a PAID booking isn't invisible.
    pushAlert(`🚨 PAID booking ${booking.id} — owner email FAILED. ${booking.customer.firstName} ${booking.customer.lastName} ${booking.customer.phone}, $${amountPaid} ${booking.equipmentLabel} ${booking.dates.join(',')}. Check booking dashboard.`);
  } finally {
    inFlightOwnerNotify.delete(booking.id);
  }
}

// ── Config ──────────────────────────────────────────────────────────

let PORT = 3200;
let ALLOWED_ORIGINS: string[] = ['https://sheridantrailerrentals.us'];

/**
 * Today's date (YYYY-MM-DD) in the business timezone (America/Chicago).
 * MUST NOT use new Date().getDate() etc. — the VPS runs UTC, so process-local
 * date components roll over at ~7pm Central and wrongly reject same-day bookings
 * as "past." sv-SE locale yields ISO YYYY-MM-DD. See calendar.ts toChicagoDate().
 */
function chicagoToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Chicago' });
}

// ── Load env ────────────────────────────────────────────────────────

const envKeys = [
  'SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID', 'SQUARE_ENVIRONMENT',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'BOOKING_PORT', 'BOOKING_ALLOWED_ORIGIN', 'BOOKING_CONFIRMATION_URL',
  'OWNER_EMAIL',
  'QUO_API_KEY', 'QUO_SHERIDAN_PHONE_ID', 'QUO_SHERIDAN_NUMBER',
  'BOOKING_PUBLIC_BASE_URL',
  'AGENT_API_TOKEN',
  'GOOGLE_MAPS_API_KEY',
  // Server-side conversion tracking (GA4 Measurement Protocol).
  'GA4_MEASUREMENT_ID',
  'GA4_API_SECRET',
];

function loadEnv(): void {
  const env = readEnvFile(envKeys);
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

// ── Request Helpers ─────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxSize = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('Payload too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function cors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Rate Limiting ───────────────────────────────────────────────────

const rateMap = new Map<string, { count: number; ts: number }>();
const checkoutRateMap = new Map<string, { count: number; ts: number }>();
const RATE_WINDOW = 60_000;
const RATE_MAX = 20;
const CHECKOUT_RATE_MAX = 5;

function bumpRate(bucket: Map<string, { count: number; ts: number }>, ip: string, max: number): boolean {
  const now = Date.now();
  const entry = bucket.get(ip);
  if (!entry || now - entry.ts > RATE_WINDOW) {
    bucket.set(ip, { count: 1, ts: now });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

function isRateLimited(ip: string): boolean {
  return bumpRate(rateMap, ip, RATE_MAX);
}

function isCheckoutRateLimited(ip: string): boolean {
  return bumpRate(checkoutRateMap, ip, CHECKOUT_RATE_MAX);
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW * 2;
  for (const [ip, entry] of rateMap) if (entry.ts < cutoff) rateMap.delete(ip);
  for (const [ip, entry] of checkoutRateMap) if (entry.ts < cutoff) checkoutRateMap.delete(ip);
}, 300_000);

// ── Handlers ────────────────────────────────────────────────────────

// Live delivery-fee quote for the booking form. Returns the distance-tiered
// drop-off fee for an address, or out-of-range / unknown. Read-only, no side effects.
async function handleDeliveryQuote(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: { address?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const address = (body.address || '').trim();
  if (!address) {
    json(res, 400, { error: 'address required' });
    return;
  }
  const quote = await quoteDelivery(address);
  json(res, 200, {
    status: quote.status,
    miles: quote.miles ?? null,
    fee: quote.fee,
    inRange: quote.status !== 'out_of_range',
  });
}

async function handleAvailability(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: AvailabilityRequest;
  try {
    body = JSON.parse(await readBody(req)) as AvailabilityRequest;
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'Invalid equipment type' });
    return;
  }
  if (!body.startDate || !body.endDate) {
    json(res, 400, { error: 'startDate and endDate required (YYYY-MM-DD)' });
    return;
  }

  // Expire stale pending bookings before checking availability
  expireStalePendingBookings(30);

  let busySlots: any[] = [];
  try {
    busySlots = await getBookedSlots(body.equipment, body.startDate, body.endDate);
  } catch (err: any) {
    console.error('[availability] Calendar check failed:', err.message);
  }

  // Merge DB bookings (pending/paid/confirmed) so calendar matches checkout
  try {
    const dbSlots = getBookedDatesFromDb(body.equipment, body.startDate, body.endDate);
    busySlots = busySlots.concat(dbSlots);
  } catch (err: any) {
    console.error('[availability] DB check failed:', err.message);
  }

  json(res, 200, {
    equipment: body.equipment,
    startDate: body.startDate,
    endDate: body.endDate,
    busySlots,
  });
}

async function handleCheckout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: CheckoutRequest;
  try {
    body = JSON.parse(await readBody(req)) as CheckoutRequest;
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  // Validate
  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'Invalid equipment type' });
    return;
  }
  if (!body.dates || body.dates.length === 0) {
    json(res, 400, { error: 'No dates selected' });
    return;
  }
  // Validate date format and reject past dates.
  // "today" is computed in America/Chicago — relying on the process TZ rejected
  // genuine same-day bookings after ~7pm Central because the VPS runs UTC.
  const today = chicagoToday();
  for (const d of body.dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      json(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (d < today) {
      json(res, 400, { error: 'Cannot book dates in the past.' });
      return;
    }
  }
  // Honeypot: the form's hidden "website" field must be empty. Bots fill it.
  if (typeof (body as any).website === 'string' && (body as any).website.trim() !== '') {
    json(res, 200, { bookingId: 'hp', paymentUrl: '', pricing: null });
    return;
  }
  if (!body.customer?.firstName || !body.customer?.lastName) {
    json(res, 400, { error: 'Customer name required' });
    return;
  }
  const email = (body.customer?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    json(res, 400, { error: 'Valid email required' });
    return;
  }
  body.customer.email = email;
  if (!body.customer?.phone) {
    json(res, 400, { error: 'Phone number required' });
    return;
  }

  const dates = [...body.dates].sort();
  const equipmentKey = body.equipment as EquipmentKey;

  // RV bills nights = (drop-off - drop-on); requires 2+ dates so there is at least 1 night.
  // Car hauler / landscaping bill days = (drop-off - drop-on) but allow same-day rentals
  // (single date = 1 day). See plan: dates.length - 1, floor 1 for non-RV.
  if (equipmentKey === 'rv' && dates.length < 2) {
    json(res, 400, { error: 'RV rentals need a pickup date and a drop-off date — please pick at least 2 days.' });
    return;
  }
  const numDays = equipmentKey === 'rv'
    ? dates.length - 1
    : Math.max(1, dates.length - 1);

  // Double-booking prevention: check DB first (fast), then calendar (authoritative)
  if (hasOverlappingBooking(equipmentKey, dates)) {
    json(res, 409, { error: 'Those dates are already booked. Please choose different dates.' });
    return;
  }

  let available = true;
  try {
    available = await datesAreAvailable(equipmentKey, dates);
  } catch (err: any) {
    // Calendar API failure — log but don't block the booking
    console.error('[checkout] Calendar availability check failed:', err.message);
    // Continue with booking — Square payment will still work, calendar event created on webhook
  }
  if (!available) {
    json(res, 409, { error: 'Equipment is not available for the selected dates.' });
    return;
  }

  const rawMode = body.paymentMode;
  const paymentMode: 'full' | 'deposit' | undefined = rawMode === 'deposit' ? 'deposit' : 'full';
  const promoCode = body.promoCode;

  // Only the RV camper has an address — the delivery destination. Delivery is
  // mandatory (no self-service pickup), so the address is required and must not
  // be bypassable. Car hauler / utility are picked up at the Tomball lot.
  const deliveryAddress = (body.deliveryAddress || '').trim();
  let deliveryFee: number | undefined;
  if (equipmentKey === 'rv') {
    if (!(body.addOns || []).includes('delivery')) {
      json(res, 400, { error: 'Delivery is required for RV rentals.' });
      return;
    }
    if (!deliveryAddress) {
      json(res, 400, { error: 'Delivery address is required for RV rentals.' });
      return;
    }
    if (deliveryAddress.length > 500) {
      json(res, 400, { error: 'Delivery address is too long (max 500 characters).' });
      return;
    }
    // Resolve the distance-tiered drop-off fee. Out-of-area (>150mi) is rejected;
    // an unresolvable address degrades to the standard fee so a geocoding outage
    // never blocks a booking.
    const quote = await quoteDelivery(deliveryAddress);
    if (quote.status === 'out_of_range') {
      json(res, 400, { error: `That address is about ${quote.miles} miles away — outside our 150-mile delivery area. Please call (817) 587-1460.` });
      return;
    }
    deliveryFee = quote.fee ?? STANDARD_DELIVERY_FEE;
  }

  // Calculate pricing (pass dates for same-week detection on RV; deliveryFee is
  // the resolved distance tier for RV deliveries).
  const pricing = calculatePrice(equipmentKey, numDays, body.addOns || [], { dates, paymentMode, promoCode, deliveryFee });

  // Car hauler / utility are picked up at the lot during business hours
  // (8 AM–8 PM). The chosen pickup time is also the drop-off due time.
  const PICKUP_SLOTS = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00'];
  const pickupTime = (body.timeSlot || '').trim();
  if (equipmentKey !== 'rv' && !PICKUP_SLOTS.includes(pickupTime)) {
    json(res, 400, { error: 'Please choose a pickup time between 8:00 AM and 8:00 PM.' });
    return;
  }

  // License photo is OPTIONAL at checkout — it's now collected after payment via
  // the /license/:bookingId page (surfaced on the confirmation screen + email).
  // Removing this pre-payment gate is the single biggest conversion lever: most
  // people don't have their license photo ready before they've committed. If the
  // form still happens to stage one, validate the reference and keep it below.
  if (body.licenseFileId && body.sessionId
      && (!isSafePathSegment(body.licenseFileId) || !isSafePathSegment(body.sessionId))) {
    json(res, 400, { error: 'Invalid license reference.' });
    return;
  }

  // Signed rental agreement is OPTIONAL at checkout — collected after payment via
  // the /sign/:bookingId/:signToken page. Only link a pre-signed agreement if the
  // form already supplied a valid token (legacy path); otherwise skip.
  const agreementToken = (body as any).agreementToken as string | undefined;
  const pendingAgreement = (agreementToken && typeof agreementToken === 'string')
    ? getAgreementByToken(agreementToken)
    : null;

  // Generate booking ID and create Square payment link
  const bookingId = generateBookingId();

  let paymentResult;
  try {
    paymentResult = await createPaymentLink(pricing, body.customer, bookingId);
  } catch (err: any) {
    console.error('[checkout] Square error:', err.message);
    json(res, 502, { error: 'Failed to create payment link. Please try again.' });
    return;
  }

  // Capture attribution + device for ground-truth analytics. Device is parsed
  // from the User-Agent server-side, so EVERY booking (incl. abandoned/pending)
  // carries a real mobile/desktop tag — the metric that reveals the true device
  // funnel independent of GA's client-side undercount.
  const device = parseDevice(req.headers['user-agent']);
  const gaClientId = body.gaClientId || gaClientIdFromCookie(req.headers.cookie);
  const gaSessionId = body.gaSessionId || '';
  const gclid = body.gclid || body.attribution?.gclid || '';

  // Store booking in DB
  const booking = createBooking({
    id: bookingId,
    equipment: equipmentKey,
    equipmentLabel: pricing.equipment.label,
    dates,
    numDays,
    customer: body.customer,
    subtotal: pricing.subtotal,
    deposit: pricing.deposit,
    balance: pricing.balance,
    addOns: pricing.addOns,
    details: body.details || '',
    squareOrderId: paymentResult.orderId,
    squarePaymentLinkId: paymentResult.paymentLinkId,
    paymentUrl: paymentResult.paymentUrl,
    deliveryAddress,
    pickupTime,
    device,
    gaClientId,
    gaSessionId,
    gclid,
  });

  // Bind the pre-signed agreement to the new booking only if one was supplied.
  // This consumes the one-time token and stamps bookings.agreement_id.
  if (pendingAgreement) {
    linkAgreementToBooking(pendingAgreement.id, booking.id);
  }

  // Mint a one-time sign token so the post-payment confirmation screen (and the
  // confirmation email) can link the customer to /sign/:id/:token to e-sign the
  // rental agreement. Harmless if a pre-signed agreement was already linked above
  // — the sign page is idempotent and short-circuits once agreement_id is set.
  const signToken = generateSignToken();
  setBookingSignToken(booking.id, signToken);

  // Associate uploaded license photo with the booking (move session-scoped upload → booking-scoped)
  if (body.licenseFileId && body.sessionId
      && isSafePathSegment(body.licenseFileId) && isSafePathSegment(body.sessionId)) {
    const srcDir = path.join(UPLOAD_DIR, body.sessionId);
    const destDir = path.join(UPLOAD_DIR, bookingId);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const srcFile = path.join(srcDir, body.licenseFileId);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(destDir, body.licenseFileId));
        fs.unlinkSync(srcFile);
        try { fs.rmdirSync(srcDir); } catch { /* non-empty is fine */ }
      }
      setLicensePhoto(bookingId, body.licenseFileId);
      console.log(`[checkout] License photo linked: ${bookingId}/${body.licenseFileId}`);
    } catch (err: any) {
      console.error(`[checkout] License photo link error: ${err.message}`);
      // Non-fatal — booking is paid, owner can request a re-upload
    }
  }

  // Owner notification is sent from the Square webhook after payment is confirmed.
  // This avoids alerting on abandoned carts and bot submissions.

  json(res, 200, {
    bookingId: booking.id,
    paymentUrl: paymentResult.paymentUrl,
    pricing: {
      subtotal: pricing.subtotal,
      deposit: pricing.deposit,
      balance: pricing.balance,
      chargeNow: pricing.chargeNow,
      paymentMode: pricing.paymentMode,
      lineItems: pricing.lineItems,
    },
  });
}

// ── Agent-Initiated Checkout (in-chat booking via Andy) ─────────────
//
// New sequence (since v1.0.0 rental agreements were added):
//   1. Andy POSTs equipment + dates + customer here.
//   2. Server creates the booking row in 'pending' status WITHOUT a Square
//      payment link, mints a sign_token, and returns:
//        - licenseUploadUrl  (existing /license/:bookingId page)
//        - signUrl           (new /sign/:bookingId/:signToken page)
//   3. Andy sends both URLs to the customer.
//   4. Customer uploads license -> bookings.license_photo populated.
//   5. Customer signs agreement -> bookings.agreement_id populated.
//   6. Andy polls GET /api/booking/:id; when both are populated, calls
//      POST /api/agent-payment-link/:bookingId to mint the Square link.
//
// Auth: shared-secret header `X-Agent-Token` matching process.env.AGENT_API_TOKEN.

async function handleAgentCheckout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: AgentCheckoutRequest;
  try {
    body = JSON.parse(await readBody(req)) as AgentCheckoutRequest;
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'Invalid equipment type' });
    return;
  }
  if (!body.dates || body.dates.length === 0) {
    json(res, 400, { error: 'No dates selected' });
    return;
  }
  const today = chicagoToday();
  for (const d of body.dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      json(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (d < today) {
      json(res, 400, { error: 'Cannot book dates in the past.' });
      return;
    }
  }
  if (!body.customer?.firstName || !body.customer?.lastName) {
    json(res, 400, { error: 'Customer firstName and lastName required' });
    return;
  }
  const email = (body.customer?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    json(res, 400, { error: 'Valid customer email required' });
    return;
  }
  body.customer.email = email;
  if (!body.customer?.phone) {
    json(res, 400, { error: 'Customer phone required (for license-upload SMS)' });
    return;
  }

  const dates = [...body.dates].sort();
  const equipmentKey = body.equipment as EquipmentKey;

  if (equipmentKey === 'rv' && dates.length < 2) {
    json(res, 400, { error: 'RV rentals need at least 2 dates (pickup + drop-off).' });
    return;
  }
  const numDays = equipmentKey === 'rv'
    ? dates.length - 1
    : Math.max(1, dates.length - 1);

  if (hasOverlappingBooking(equipmentKey, dates)) {
    json(res, 409, { error: 'Those dates overlap with an existing booking.' });
    return;
  }
  let available = true;
  try {
    available = await datesAreAvailable(equipmentKey, dates);
  } catch (err: any) {
    console.error('[agent-checkout] Calendar availability check failed:', err.message);
  }
  if (!available) {
    json(res, 409, { error: 'Equipment is not available for the selected dates.' });
    return;
  }

  const rawMode = body.paymentMode;
  const paymentMode: 'full' | 'deposit' | undefined = rawMode === 'deposit' ? 'deposit' : 'full';
  const promoCode = body.promoCode;
  const pricing = calculatePrice(equipmentKey, numDays, body.addOns || [], { dates, paymentMode, promoCode });

  const deliveryAddress = (body.deliveryAddress || '').trim();
  if (equipmentKey === 'rv') {
    if (!pricing.addOns.includes('delivery')) {
      json(res, 400, { error: 'RV bookings require delivery.' });
      return;
    }
    if (!deliveryAddress) {
      json(res, 400, { error: 'Delivery address required for RV.' });
      return;
    }
  }

  const bookingId = generateBookingId();
  const signToken = generateSignToken();

  // Create the booking row up-front so the customer can upload a license and
  // sign the agreement against it. Square link is minted later via
  // /api/agent-payment-link/:bookingId once both prerequisites are met.
  const booking = createBooking({
    id: bookingId,
    equipment: equipmentKey,
    equipmentLabel: pricing.equipment.label,
    dates,
    numDays,
    customer: body.customer,
    subtotal: pricing.subtotal,
    deposit: pricing.deposit,
    balance: pricing.balance,
    addOns: pricing.addOns,
    details: body.details || '',
    squareOrderId: '',
    squarePaymentLinkId: '',
    paymentUrl: '',
    deliveryAddress,
    agentInitiated: true,
  });

  // Persist pricing snapshot + sign_token for the later mint step.
  setBookingSignToken(booking.id, signToken);
  setBookingPricingSnapshot(
    booking.id,
    JSON.stringify({
      lineItems: pricing.lineItems,
      chargeNow: pricing.chargeNow,
      paymentMode: pricing.paymentMode,
    }),
  );

  const publicBase = process.env.BOOKING_PUBLIC_BASE_URL || 'https://chat.sheridantrailerrentals.us';
  const licenseUploadUrl = `${publicBase}/license/${booking.id}`;
  const signUrl = `${publicBase}/sign/${booking.id}/${signToken}`;

  console.log(`[agent-checkout] Created ${booking.id} for ${body.customer.firstName} ${body.customer.lastName} — awaiting license + signature`);

  json(res, 200, {
    bookingId: booking.id,
    licenseUploadUrl,
    signUrl,
    status: booking.status,
    pricing: {
      subtotal: pricing.subtotal,
      deposit: pricing.deposit,
      balance: pricing.balance,
      chargeNow: pricing.chargeNow,
      paymentMode: pricing.paymentMode,
      lineItems: pricing.lineItems,
    },
  });
}

async function handleSquareWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);

  // Respond immediately per Square best practice
  json(res, 200, { ok: true });

  try {
    const payload = JSON.parse(body);
    console.log(`[webhook] Received event: ${payload.type}`);

    // Square sends payment.created and payment.updated — not payment.completed
    if (!['payment.created', 'payment.updated'].includes(payload.type)) return;

    const payment = payload.data?.object?.payment;
    if (!payment) return;

    // Only process completed payments
    if (payment.status !== 'COMPLETED') {
      console.log(`[webhook] Payment status is ${payment.status}, skipping`);
      return;
    }

    const orderId = payment.order_id;
    if (!orderId) return;

    console.log(`[webhook] Payment completed for order ${orderId}`);

    // Find the booking — check order_id first, then check order metadata for balance payments
    let booking = getBookingByOrderId(orderId);
    if (!booking) {
      // Balance payments have a different order_id. Check if the order metadata has a booking_id.
      const metadata = payment.order?.metadata || payment.metadata || {};
      const metaBookingId = metadata.booking_id;
      if (metaBookingId) {
        booking = getBooking(metaBookingId);
        if (booking) {
          console.log(`[webhook] Found booking ${metaBookingId} via order metadata (balance payment)`);
        }
      }
    }
    if (!booking) {
      console.warn(`[webhook] No booking found for order ${orderId}`);
      return;
    }

    // Handle balance payment — booking already in 'paid' status, now fully paid
    // Only if this is a DIFFERENT order (balance payment link), not a duplicate webhook for the original deposit
    if (booking.status === 'paid' && booking.balance > 0 && orderId !== booking.squareOrderId) {
      console.log(`[webhook] Balance payment received for booking ${booking.id} (balance order: ${orderId})`);
      updateBookingStatus(booking.id, 'confirmed');
      clearBalance(booking.id);

      const updatedBooking = getBooking(booking.id)!;
      sendCustomerConfirmation(updatedBooking).catch(err =>
        console.error(`[webhook] Balance confirmation email failed: ${err.message}`),
      );
      sendPaymentReceivedNotification(updatedBooking).catch(err =>
        console.error(`[webhook] Balance owner notification failed: ${err.message}`),
      );
      return;
    }

    if (booking.status === 'cancelled') {
      // Payment arrived after pending booking was expired — resurrect it
      console.log(`[webhook] Booking ${booking.id} was expired but payment received — reactivating`);
      // Fall through to normal confirmation flow below
    } else if (booking.status === 'paid' && orderId === booking.squareOrderId) {
      // Duplicate webhook for a deposit that was already processed — ignore
      console.log(`[webhook] Booking ${booking.id} deposit already processed, ignoring duplicate`);
      return;
    } else if (booking.status !== 'pending') {
      console.log(`[webhook] Booking ${booking.id} already processed (status: ${booking.status})`);
      return;
    }

    // Determine status: deposit-only bookings go to 'paid' (balance still owed),
    // full-payment bookings go straight to 'confirmed'
    const isDepositOnly = booking.balance > 0;
    updateBookingStatus(booking.id, isDepositOnly ? 'paid' : 'confirmed');

    // Create calendar event
    try {
      const eventId = await createBookingEvent(
        booking.equipment,
        booking.dates,
        booking.customer,
        {
          subtotal: booking.subtotal,
          deposit: booking.deposit,
          balance: booking.balance,
          addOns: booking.addOns,
          numDays: booking.numDays,
        },
      );
      setCalendarEventId(booking.id, eventId);
      console.log(`[webhook] Calendar event created: ${eventId}`);
    } catch (err: any) {
      console.error(`[webhook] Calendar error: ${err.message}`);
      // Don't fail the booking — it's paid, calendar can be added manually
    }

    // Refresh booking with updated fields
    const updatedBooking = getBooking(booking.id)!;

    // Send emails (non-blocking). Owner gets the full-detail notification only
    // after payment is confirmed — prevents spam/abandoned-cart alerts.
    sendCustomerConfirmation(updatedBooking).catch(err =>
      console.error(`[webhook] CRITICAL: Customer confirmation email failed after retries: ${err.message}. Booking ${updatedBooking.id} — manual follow-up required.`),
    );
    notifyOwnerOnce(updatedBooking, 'webhook');

    // Server-side conversion: fire GA4 (and Ads via the linked import) on REAL
    // payment, once per booking — counted regardless of whether the customer
    // returned to the form. claimConversionSend atomically guards double-fire;
    // GA4 also dedups by transaction_id as a backstop.
    if (claimConversionSend(updatedBooking.id)) {
      sendGa4Purchase(updatedBooking)
        .then((r) =>
          r.ok
            ? console.log(`[webhook] Conversion → GA4 for ${updatedBooking.id} (device=${updatedBooking.device || 'unknown'})`)
            : console.warn(`[webhook] Conversion NOT sent for ${updatedBooking.id}: ${r.reason}`),
        )
        .catch((e: any) => console.error(`[webhook] Conversion send threw: ${e?.message || e}`));
    }

    // License + signature are now collected AFTER payment for EVERY booking (web
    // and agent), so text the customer the link(s) for whatever is still missing.
    // Send once per booking (idempotent on the license_sms_sent_at stamp).
    if ((!updatedBooking.licenseFileId || !updatedBooking.agreementId) && !updatedBooking.licenseSmsSentAt) {
      const publicBase = process.env.BOOKING_PUBLIC_BASE_URL || 'https://chat.sheridantrailerrentals.us';
      const uploadUrl = `${publicBase}/license/${updatedBooking.id}`;
      const signUrl = updatedBooking.signToken ? `${publicBase}/sign/${updatedBooking.id}/${updatedBooking.signToken}` : '';
      let smsBody = `Sheridan Rentals — payment received for ${updatedBooking.equipmentLabel} on ${updatedBooking.dates[0]}.`;
      if (!updatedBooking.licenseFileId) smsBody += ` Upload your driver's license to lock in pickup: ${uploadUrl}`;
      if (!updatedBooking.agreementId && signUrl) smsBody += ` Then e-sign your rental agreement: ${signUrl}`;
      sendQuoSMS(updatedBooking.customer.phone, smsBody).then(result => {
        if (result.ok) {
          markLicenseSmsSent(updatedBooking.id);
          console.log(`[webhook] License-upload SMS sent for ${updatedBooking.id} -> ${updatedBooking.customer.phone}`);
        } else {
          console.error(`[webhook] License SMS failed for ${updatedBooking.id} (status ${result.status}): ${result.error}`);
        }
      }).catch(err =>
        console.error(`[webhook] License SMS threw for ${updatedBooking.id}: ${err.message}`),
      );
    }

  } catch (err: any) {
    console.error(`[webhook] Parse error: ${err.message}`);
  }
}

// ── File Uploads (License + Inspection Photos) ──────────────────────

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB — iPhone HEIC + portrait photos can exceed 10MB
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Reject anything that could traverse out of UPLOAD_DIR. Accepts only alphanumerics, dot, underscore, hyphen. */
function isSafePathSegment(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && SAFE_SEGMENT.test(s) && s !== '.' && s !== '..';
}

interface ParsedUpload {
  fields: Record<string, string>;
  file?: { name: string; data: Buffer; contentType: string };
}

function parseMultipartFormData(req: http.IncomingMessage, maxSize = MAX_UPLOAD_BYTES): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"?)([^";]+)/);
    if (!boundaryMatch) { reject(new Error('No multipart boundary')); return; }
    const boundary = boundaryMatch[1];

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxSize) {
        aborted = true;
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const buf = Buffer.concat(chunks);
      // Split on boundary using binary-preserving encoding
      const parts = buf.toString('binary').split('--' + boundary);
      const fields: Record<string, string> = {};
      let file: ParsedUpload['file'];

      for (const part of parts) {
        if (part === '--\r\n' || part === '--' || !part.includes('Content-Disposition')) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.substring(0, headerEnd);
        let bodyStr = part.substring(headerEnd + 4);
        if (bodyStr.endsWith('\r\n')) bodyStr = bodyStr.slice(0, -2);

        const nameMatch = headers.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const fieldName = nameMatch[1];

        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (filenameMatch) {
          const ctMatch = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
          file = {
            name: filenameMatch[1],
            data: Buffer.from(bodyStr, 'binary'),
            contentType: ctMatch ? ctMatch[1].trim().toLowerCase() : 'application/octet-stream',
          };
        } else {
          fields[fieldName] = bodyStr;
        }
      }
      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}

function safeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) ? ext : '.jpg';
}

async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let parsed: ParsedUpload;
  try {
    parsed = await parseMultipartFormData(req);
  } catch (err: any) {
    const status = err.message === 'Payload too large' ? 413 : 400;
    json(res, status, { error: err.message });
    return;
  }

  const { fields, file } = parsed;
  if (!file) { json(res, 400, { error: 'No file uploaded' }); return; }
  // Some mobile browsers strip Content-Type or send application/octet-stream for HEIC.
  // Accept if either the MIME or the file extension is a known image format.
  const uploadedExt = path.extname(file.name).toLowerCase();
  const typeOk = ALLOWED_IMAGE_TYPES.has(file.contentType);
  const extOk = ALLOWED_EXTENSIONS.has(uploadedExt);
  if (!typeOk && !extOk) {
    json(res, 400, { error: 'Unsupported image type. Use JPEG, PNG, WebP, or HEIC.' });
    return;
  }

  // Session ID: use supplied value if safe, else generate one
  const suppliedSession = fields.sessionId;
  const sessionId = isSafePathSegment(suppliedSession)
    ? suppliedSession
    : `sess-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const fileId = `lic-${Date.now()}-${Math.random().toString(36).substring(2, 8)}${safeExtension(file.name)}`;

  try {
    const dir = path.join(UPLOAD_DIR, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileId), file.data);
    console.log(`[upload] License photo saved: ${sessionId}/${fileId} (${file.data.length} bytes)`);
    json(res, 200, { fileId, sessionId });
  } catch (err: any) {
    console.error(`[upload] Write error: ${err.message}`);
    json(res, 500, { error: 'Upload failed' });
  }
}

async function handleUploadLicenseByBooking(req: http.IncomingMessage, res: http.ServerResponse, bookingId: string): Promise<void> {
  if (!isSafePathSegment(bookingId)) { json(res, 400, { error: 'Invalid bookingId' }); return; }
  const booking = getBooking(bookingId);
  if (!booking) { json(res, 404, { error: 'Booking not found' }); return; }
  if (booking.status === 'cancelled') { json(res, 410, { error: 'This booking was cancelled.' }); return; }

  let parsed: ParsedUpload;
  try {
    parsed = await parseMultipartFormData(req);
  } catch (err: any) {
    const status = err.message === 'Payload too large' ? 413 : 400;
    json(res, status, { error: err.message });
    return;
  }
  const { file } = parsed;
  if (!file) { json(res, 400, { error: 'No file uploaded' }); return; }

  const uploadedExt = path.extname(file.name).toLowerCase();
  const typeOk = ALLOWED_IMAGE_TYPES.has(file.contentType);
  const extOk = ALLOWED_EXTENSIONS.has(uploadedExt);
  if (!typeOk && !extOk) {
    json(res, 400, { error: 'Unsupported image type. Use JPEG, PNG, WebP, or HEIC.' });
    return;
  }

  const fileId = `lic-${Date.now()}-${Math.random().toString(36).substring(2, 8)}${safeExtension(file.name)}`;
  try {
    const dir = path.join(UPLOAD_DIR, bookingId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileId), file.data);
    setLicensePhoto(bookingId, fileId);
    console.log(`[upload-license] Saved ${bookingId}/${fileId} (${file.data.length} bytes)`);
    json(res, 200, { ok: true, bookingId, fileId });

    // Notify the owner the moment the photo lands, with a token-protected view
    // link (the photo doesn't exist yet at payment-time owner-notify). Non-blocking.
    if (booking.signToken) {
      const publicBase = process.env.BOOKING_PUBLIC_BASE_URL || 'https://chat.sheridantrailerrentals.us';
      const viewUrl = `${publicBase}/api/license/${bookingId}?t=${booking.signToken}`;
      sendLicenseReceivedNotification(booking, viewUrl).catch(err =>
        console.error(`[upload-license] Owner notify email failed for ${bookingId}: ${err.message}`),
      );
    }
  } catch (err: any) {
    console.error(`[upload-license] Write error: ${err.message}`);
    json(res, 500, { error: 'Upload failed' });
  }
}

function handleLicensePage(res: http.ServerResponse, bookingId: string): void {
  if (!isSafePathSegment(bookingId)) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h1>Invalid booking ID</h1>');
    return;
  }
  const booking = getBooking(bookingId);
  if (!booking) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>Booking not found</h1>');
    return;
  }
  const alreadyUploaded = !!booking.licenseFileId;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload License — Sheridan Rentals</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111;background:#fafafa}
h1{font-size:22px;margin-bottom:6px}
.muted{color:#666;font-size:14px;margin-bottom:24px}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:20px}
.row{display:flex;justify-content:space-between;font-size:14px;margin:4px 0;color:#333}
.row strong{color:#111}
input[type=file]{display:block;margin:18px 0;font-size:15px;width:100%}
button{background:#0a7;color:#fff;border:0;border-radius:6px;padding:14px 18px;font-size:16px;font-weight:600;width:100%;cursor:pointer}
button:disabled{background:#aaa;cursor:wait}
#status{margin-top:18px;font-size:15px}
.ok{color:#0a7}
.err{color:#c33}
</style>
</head>
<body>
<h1>Upload your driver's license</h1>
<p class="muted">${alreadyUploaded ? 'We already have your license on file — you can re-upload if you need to replace it.' : 'Last step. Take a photo of your driver\'s license (front side) and submit.'}</p>
<div class="card">
<div class="row"><span>Booking</span><strong>${booking.id}</strong></div>
<div class="row"><span>Equipment</span><strong>${booking.equipmentLabel}</strong></div>
<div class="row"><span>Dates</span><strong>${booking.dates.join(', ')}</strong></div>
<form id="lf" enctype="multipart/form-data">
<input type="file" name="file" accept="image/*" capture="environment" required>
<button type="submit" id="btn">Upload license</button>
</form>
<div id="status"></div>
</div>
<script>
var f=document.getElementById('lf');var inp=f.querySelector('input[type=file]');var b=document.getElementById('btn');var s=document.getElementById('status');
// Re-encode the picked image to a JPEG <= 1600px on the longer side BEFORE upload.
// 10-25MB iPhone HEIC / portrait photos are the #1 mobile failure: they stall or
// time out on cellular. Canvas re-encode shrinks them to ~200KB and also removes
// HEIC content-type ambiguity. Falls back to the original file if decode fails.
function resizeImage(file){return new Promise(function(resolve){try{var url=URL.createObjectURL(file);var img=new Image();img.onload=function(){try{var MAX=1600;var w=img.naturalWidth,h=img.naturalHeight;if(!w||!h){URL.revokeObjectURL(url);resolve(file);return;}var scale=Math.min(1,MAX/Math.max(w,h));var tw=Math.round(w*scale),th=Math.round(h*scale);var c=document.createElement('canvas');c.width=tw;c.height=th;c.getContext('2d').drawImage(img,0,0,tw,th);c.toBlob(function(blob){URL.revokeObjectURL(url);if(!blob){resolve(file);return;}resolve(new File([blob],'license.jpg',{type:'image/jpeg'}));},'image/jpeg',0.85);}catch(e){URL.revokeObjectURL(url);resolve(file);}};img.onerror=function(){URL.revokeObjectURL(url);resolve(file);};img.src=url;}catch(e){resolve(file);}});}
f.addEventListener('submit',function(e){e.preventDefault();var file=inp&&inp.files&&inp.files[0];if(!file){s.className='err';s.textContent='Please choose a photo first.';return;}b.disabled=true;b.textContent='Optimizing photo...';s.className='';s.textContent='';
resizeImage(file).then(function(processed){b.textContent='Uploading...';var fd=new FormData();fd.append('file',processed);return fetch('/api/upload-license/${booking.id}',{method:'POST',body:fd});}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j};});}).then(function(res){if(res.ok){s.className='ok';s.textContent='✓ License received. You\\'re all set. We\\'ll be in touch about pickup.';b.textContent='Done';}else{s.className='err';s.textContent='Error: '+(res.j.error||res.status);b.disabled=false;b.textContent='Upload license';}}).catch(function(err){s.className='err';s.textContent='Upload failed: '+err.message;b.disabled=false;b.textContent='Upload license';});});
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};

/**
 * Owner-only view of a customer's uploaded license photo. Access is gated on
 * the booking's sign_token (passed as ?t=) — unguessable and per-booking, so no
 * new secret or schema column is needed. Streams the raw image bytes.
 */
function handleGetLicense(res: http.ServerResponse, bookingId: string, token: string): void {
  if (!isSafePathSegment(bookingId)) { json(res, 400, { error: 'Invalid bookingId' }); return; }
  const booking = getBooking(bookingId);
  if (!booking) { json(res, 404, { error: 'Not found' }); return; }
  // Constant-ish token check. Missing sign_token => never viewable via this route.
  if (!booking.signToken || token !== booking.signToken) { json(res, 404, { error: 'Not found' }); return; }
  if (!booking.licenseFileId || !isSafePathSegment(booking.licenseFileId)) {
    json(res, 404, { error: 'No license on file yet' });
    return;
  }
  const filePath = path.join(UPLOAD_DIR, bookingId, booking.licenseFileId);
  if (!fs.existsSync(filePath)) { json(res, 404, { error: 'No license on file yet' }); return; }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(booking.licenseFileId).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'private, no-store',
    });
    res.end(data);
  } catch (err: any) {
    console.error(`[license-view] Read error for ${bookingId}: ${err.message}`);
    json(res, 500, { error: 'Could not read license' });
  }
}

async function handleUploadInspection(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let parsed: ParsedUpload;
  try {
    parsed = await parseMultipartFormData(req);
  } catch (err: any) {
    const status = err.message === 'Payload too large' ? 413 : 400;
    json(res, status, { error: err.message });
    return;
  }

  const { fields, file } = parsed;
  if (!file) { json(res, 400, { error: 'No file uploaded' }); return; }
  if (!ALLOWED_IMAGE_TYPES.has(file.contentType)) {
    json(res, 400, { error: 'Unsupported image type' });
    return;
  }

  const bookingId = fields.bookingId;
  const type = fields.type;   // 'before' | 'after'
  const angle = fields.angle; // 'front' | 'back' | 'left' | 'right'

  if (!bookingId || !type || !angle) {
    json(res, 400, { error: 'bookingId, type, and angle are required' });
    return;
  }
  if (!isSafePathSegment(bookingId)) { json(res, 400, { error: 'Invalid bookingId' }); return; }
  if (!['before', 'after'].includes(type) || !['front', 'back', 'left', 'right'].includes(angle)) {
    json(res, 400, { error: 'Invalid type or angle' });
    return;
  }

  const booking = getBooking(bookingId);
  if (!booking) { json(res, 404, { error: 'Booking not found' }); return; }
  if (booking.equipment !== 'carhauler') {
    json(res, 400, { error: 'Inspection photos are only available for Car Hauler rentals' });
    return;
  }

  const fileId = `insp-${type}-${angle}-${Date.now()}${safeExtension(file.name)}`;
  try {
    const dir = path.join(UPLOAD_DIR, bookingId, 'inspection');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileId), file.data);
    console.log(`[inspection] Photo saved: ${bookingId}/inspection/${fileId} (${file.data.length} bytes)`);
    json(res, 200, { fileId, bookingId, type, angle });
  } catch (err: any) {
    console.error(`[inspection] Write error: ${err.message}`);
    json(res, 500, { error: 'Upload failed' });
  }
}

function handleGetInspection(res: http.ServerResponse, bookingId: string, typeFilter: string): void {
  if (!isSafePathSegment(bookingId)) { json(res, 400, { error: 'Invalid bookingId' }); return; }

  const dir = path.join(UPLOAD_DIR, bookingId, 'inspection');
  const photos: Array<{ fileId: string; type: string; angle: string }> = [];

  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const match = f.match(/^insp-(before|after)-(front|back|left|right)-/);
        if (!match) continue;
        const fType = match[1];
        const fAngle = match[2];
        if (!typeFilter || fType === typeFilter) {
          photos.push({ fileId: f, type: fType, angle: fAngle });
        }
      }
    }
  } catch (err: any) {
    console.error(`[inspection] Read error: ${err.message}`);
  }

  json(res, 200, { bookingId, photos });
}

async function handleCancel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const { bookingId, refund } = body as { bookingId: string; refund?: boolean };

  if (!bookingId) {
    json(res, 400, { error: 'bookingId required' });
    return;
  }

  const booking = getBooking(bookingId);
  if (!booking) {
    json(res, 404, { error: 'Booking not found' });
    return;
  }

  if (booking.status === 'cancelled') {
    json(res, 409, { error: 'Booking already cancelled' });
    return;
  }

  let refundResult = null;

  // Process refund if booking was paid/confirmed and refund requested
  if (refund !== false && (booking.status === 'confirmed' || booking.status === 'paid') && booking.squareOrderId) {
    try {
      refundResult = await refundPayment(booking.squareOrderId);
    } catch (err: any) {
      console.error(`[cancel] Refund error: ${err.message}`);
      // Don't fail the cancellation — still cancel the booking
    }
  }

  // Cancel the booking in DB
  cancelBooking(booking.id, refundResult?.refundId);

  // Delete calendar event if it exists
  if (booking.calendarEventId) {
    try {
      await deleteCalendarEvent(booking.equipment as EquipmentKey, booking.calendarEventId);
      console.log(`[cancel] Calendar event deleted: ${booking.calendarEventId}`);
    } catch (err: any) {
      console.error(`[cancel] Calendar delete error: ${err.message}`);
    }
  }

  // Send cancellation email (non-blocking)
  sendCancellationConfirmation(booking, refundResult?.amountCents || 0).catch(err =>
    console.error(`[cancel] Email error: ${err.message}`),
  );

  json(res, 200, {
    cancelled: true,
    bookingId: booking.id,
    refund: refundResult ? {
      refundId: refundResult.refundId,
      status: refundResult.status,
      amount: (refundResult.amountCents / 100).toFixed(2),
    } : null,
  });
}

function handleGetBooking(res: http.ServerResponse, bookingId: string): void {
  const booking = getBooking(bookingId);
  if (!booking) {
    json(res, 404, { error: 'Booking not found' });
    return;
  }

  // Build formatted date range
  const sorted = [...booking.dates].sort();
  const dateRange = sorted.length === 1
    ? formatDatePretty(sorted[0])
    : `${formatDatePretty(sorted[0])} — ${formatDatePretty(sorted[sorted.length - 1])}`;

  // Get unit from equipment config
  const equipConfig = EQUIPMENT[booking.equipment];
  const unit = equipConfig?.unit || 'day';

  const isDepositOnly = booking.balance > 0;
  const readyToPay = booking.agentInitiated
    && !!booking.licenseFileId
    && !!booking.agreementId
    && !booking.paymentUrl;
  // Post-payment collection links — surfaced on the confirmation screen so the
  // customer uploads their license + signs the agreement after they've paid.
  const publicBase = process.env.BOOKING_PUBLIC_BASE_URL || 'https://chat.sheridantrailerrentals.us';
  const licenseUploadUrl = `${publicBase}/license/${booking.id}`;
  const signUrl = booking.signToken ? `${publicBase}/sign/${booking.id}/${booking.signToken}` : '';
  json(res, 200, {
    id: booking.id,
    equipment: booking.equipmentLabel,
    equipmentLabel: booking.equipmentLabel,
    dates: booking.dates,
    dateRange,
    numDays: booking.numDays,
    unit,
    subtotal: booking.subtotal,
    total: booking.subtotal + booking.deposit,
    deposit: booking.deposit,
    amountPaid: isDepositOnly ? booking.deposit : booking.subtotal + booking.deposit,
    balance: booking.balance,
    status: booking.status,
    addOns: booking.addOns,
    deliveryAddress: booking.deliveryAddress || '',
    pickupTime: booking.pickupTime || '',
    customer: {
      firstName: booking.customer.firstName,
      lastName: booking.customer.lastName,
    },
    // Surfaced for Andy's poller. The agent waits for both flags to be true
    // before calling POST /api/agent-payment-link/:id.
    agentInitiated: booking.agentInitiated,
    licenseUploaded: !!booking.licenseFileId,
    agreementSigned: !!booking.agreementId,
    licenseUploadUrl,
    signUrl,
    agreementId: booking.agreementId || '',
    paymentUrl: booking.paymentUrl,
    readyToPay,
    createdAt: booking.createdAt,
  });
}

function formatDatePretty(dateStr: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${months[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}, ${parts[0]}`;
  }
  return dateStr;
}

// ── Rental Agreement Endpoints ──────────────────────────────────────

interface SignAgreementBody {
  fullName?: string;
  signatureDataUrl?: string;
  iAgree?: boolean;
}

interface PreBookingSignBody extends SignAgreementBody {
  equipment?: EquipmentKey;
  dates?: string[];
  customer?: { firstName?: string; lastName?: string; email?: string };
  addOns?: string[];
  deliveryAddress?: string;
}

function validateSignaturePayload(b: SignAgreementBody): string | null {
  if (!b.iAgree) return 'must_agree';
  const name = (b.fullName ?? '').trim();
  if (name.length < 2 || name.length > 120) return 'invalid_name';
  const sig = (b.signatureDataUrl ?? '').trim();
  if (!sig.startsWith('data:image/') || sig.length < 200) return 'missing_signature';
  if (sig.length > 250_000) return 'signature_too_large';
  return null;
}

function clientIpOf(req: http.IncomingMessage): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.socket.remoteAddress || '';
}

function buildAgreementContextFromBooking(booking: Booking): AgreementContext {
  const equipConfig = EQUIPMENT[booking.equipment];
  const hasDelivery = booking.addOns.includes('delivery');
  return {
    bookingId: booking.id,
    equipmentLabel: booking.equipmentLabel,
    customerName: `${booking.customer.firstName} ${booking.customer.lastName}`.trim(),
    customerEmail: booking.customer.email,
    dates: booking.dates,
    numDays: booking.numDays,
    unit: equipConfig?.unit || 'day',
    deposit: booking.deposit,
    total: booking.subtotal + booking.deposit,
    deliveryAddress: booking.deliveryAddress,
    hasDelivery,
  };
}

/**
 * POST /api/agreements/preview — returns the agreement HTML for the
 * pre-checkout sign step in form.html. No signing happens here; this is a
 * read-only render so the customer can read what they're about to sign.
 */
async function handleAgreementPreview(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: PreBookingSignBody;
  try { body = JSON.parse(await readBody(req)) as PreBookingSignBody; }
  catch { json(res, 400, { error: 'Invalid JSON' }); return; }

  if (!body.equipment || !EQUIPMENT[body.equipment]) { json(res, 400, { error: 'invalid_equipment' }); return; }
  if (!Array.isArray(body.dates) || body.dates.length === 0) { json(res, 400, { error: 'no_dates' }); return; }

  const equipmentKey = body.equipment as EquipmentKey;
  const dates = [...body.dates].sort();
  const numDays = equipmentKey === 'rv' ? dates.length - 1 : Math.max(1, dates.length - 1);
  const pricing = calculatePrice(equipmentKey, numDays, body.addOns || [], { dates, paymentMode: 'full' });

  const ctx: AgreementContext = {
    bookingId: 'pending',
    equipmentLabel: pricing.equipment.label,
    customerName: `${body.customer?.firstName ?? ''} ${body.customer?.lastName ?? ''}`.trim() || 'Customer',
    customerEmail: (body.customer?.email ?? '').trim(),
    dates,
    numDays,
    unit: pricing.equipment.unit,
    deposit: pricing.deposit,
    total: pricing.subtotal + pricing.deposit,
    deliveryAddress: (body.deliveryAddress ?? '').trim(),
    hasDelivery: (body.addOns || []).includes('delivery'),
  };
  const kind = kindForEquipment(equipmentKey);
  const html = renderAgreementHtml(kind, ctx);
  json(res, 200, { html, version: AGREEMENT_VERSION });
}

/**
 * POST /api/agreements/pre-booking — web form flow.
 *
 * Customer signs the agreement BEFORE the booking row exists (Step 4 in form.html).
 * We insert with booking_id='' and a one-time agreement_token. /api/checkout
 * later consumes the token and links it to the freshly-created booking.
 *
 * Pricing is recomputed server-side so a tampered client can't shrink the total
 * shown on the signed copy.
 */
async function handleSignAgreementPreBooking(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: PreBookingSignBody;
  try { body = JSON.parse(await readBody(req)) as PreBookingSignBody; }
  catch { json(res, 400, { error: 'Invalid JSON' }); return; }

  const err = validateSignaturePayload(body);
  if (err) { json(res, 400, { error: err }); return; }

  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'invalid_equipment' });
    return;
  }
  if (!Array.isArray(body.dates) || body.dates.length === 0) {
    json(res, 400, { error: 'no_dates' });
    return;
  }
  for (const d of body.dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { json(res, 400, { error: 'invalid_date_format' }); return; }
  }
  const customerEmail = (body.customer?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail)) {
    json(res, 400, { error: 'invalid_email' });
    return;
  }

  const equipmentKey = body.equipment as EquipmentKey;
  const dates = [...body.dates].sort();
  const numDays = equipmentKey === 'rv' ? dates.length - 1 : Math.max(1, dates.length - 1);
  const pricing = calculatePrice(equipmentKey, numDays, body.addOns || [], { dates, paymentMode: 'full' });

  const ctx: AgreementContext = {
    bookingId: 'pending', // placeholder visible in the signed text
    equipmentLabel: pricing.equipment.label,
    customerName: `${body.customer?.firstName ?? ''} ${body.customer?.lastName ?? ''}`.trim() || (body.fullName?.trim() ?? ''),
    customerEmail,
    dates,
    numDays,
    unit: pricing.equipment.unit,
    deposit: pricing.deposit,
    total: pricing.subtotal + pricing.deposit,
    deliveryAddress: (body.deliveryAddress ?? '').trim(),
    hasDelivery: (body.addOns || []).includes('delivery'),
  };
  const kind = kindForEquipment(equipmentKey);
  const contentHash = sha256Hex(renderAgreementText(kind, ctx));

  const agreementId = generateAgreementId();
  const agreementToken = generateAgreementToken();
  createPreBookingAgreement({
    id: agreementId,
    agreementToken,
    kind,
    version: AGREEMENT_VERSION,
    contentHash,
    signerName: body.fullName!.trim(),
    signerEmail: customerEmail,
    signaturePng: body.signatureDataUrl!,
    signerIp: clientIpOf(req),
    signerUa: req.headers['user-agent']?.toString() || '',
  });

  json(res, 200, { agreementId, agreementToken, contentHash, version: AGREEMENT_VERSION });
}

/**
 * POST /api/agreements/by-sign-token/:signToken — Andy's flow.
 *
 * Andy created the booking via /api/agent-checkout and texted the customer a
 * /sign/:bookingId/:signToken URL. The customer hits this endpoint via the
 * standalone sign page, the agreement is bound directly to the booking, and
 * bookings.agreement_id is stamped so Andy's poller sees ready_to_pay.
 */
async function handleSignAgreementByToken(req: http.IncomingMessage, res: http.ServerResponse, signToken: string): Promise<void> {
  let body: SignAgreementBody;
  try { body = JSON.parse(await readBody(req)) as SignAgreementBody; }
  catch { json(res, 400, { error: 'Invalid JSON' }); return; }

  const err = validateSignaturePayload(body);
  if (err) { json(res, 400, { error: err }); return; }

  const booking = getBookingBySignToken(signToken);
  if (!booking) { json(res, 404, { error: 'sign_link_invalid' }); return; }
  if (booking.status === 'cancelled') { json(res, 409, { error: 'booking_cancelled' }); return; }

  // Idempotent — if the booking is already signed, return its existing id.
  if (booking.agreementId) {
    json(res, 200, { agreementId: booking.agreementId, alreadySigned: true });
    return;
  }

  const ctx = buildAgreementContextFromBooking(booking);
  const kind = kindForEquipment(booking.equipment);
  const contentHash = sha256Hex(renderAgreementText(kind, ctx));

  const agreementId = generateAgreementId();
  createBookingAgreement({
    id: agreementId,
    bookingId: booking.id,
    kind,
    version: AGREEMENT_VERSION,
    contentHash,
    signerName: body.fullName!.trim(),
    signerEmail: booking.customer.email,
    signaturePng: body.signatureDataUrl!,
    signerIp: clientIpOf(req),
    signerUa: req.headers['user-agent']?.toString() || '',
  });

  json(res, 200, { agreementId, contentHash, version: AGREEMENT_VERSION });
}

/**
 * GET /sign/:bookingId/:signToken — mobile-friendly signing page (Andy's flow).
 * Page POSTs to /api/agreements/by-sign-token/:signToken.
 */
function handleSignPage(res: http.ServerResponse, bookingId: string, signToken: string): void {
  const booking = getBooking(bookingId);
  if (!booking || booking.signToken !== signToken || !booking.signToken) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Sign link not found</h1><p>This link is invalid or expired. Please reply to your text and we will resend.</p>');
    return;
  }
  const ctx = buildAgreementContextFromBooking(booking);
  const kind = kindForEquipment(booking.equipment);
  const alreadySigned = !!booking.agreementId;

  const agreementHtml = renderAgreementHtml(kind, ctx);
  const page = renderSignPage({
    bookingId: booking.id,
    signToken,
    customerName: `${booking.customer.firstName} ${booking.customer.lastName}`.trim(),
    agreementHtml,
    alreadySigned,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}

/**
 * GET /api/agreements/:id — read-only signed copy.
 * Public by unguessable id (16 hex chars = 64 bits of entropy).
 */
function handleGetAgreement(res: http.ServerResponse, agreementId: string): void {
  const agreement = getAgreement(agreementId);
  if (!agreement) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Agreement not found</h1>');
    return;
  }
  // Web-form rows that were never finalized (booking_id still empty) shouldn't be exposed.
  if (!agreement.bookingId) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Agreement not found</h1>');
    return;
  }
  const booking = getBooking(agreement.bookingId);
  if (!booking) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Agreement not found</h1>');
    return;
  }
  const ctx = buildAgreementContextFromBooking(booking);
  const kind = kindForEquipment(booking.equipment);
  const agreementHtml = renderAgreementHtml(kind, ctx);
  const page = renderSignedView({
    agreementId: agreement.id,
    bookingId: booking.id,
    agreementHtml,
    signerName: agreement.signerName,
    signaturePng: agreement.signaturePng,
    signedAt: agreement.signedAt,
    contentHash: agreement.contentHash,
    version: agreement.version,
    kind: agreement.kind,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}

/**
 * POST /api/agent-payment-link/:bookingId — Andy's mint step.
 * Server enforces both prerequisites: license_photo on disk + agreement_id set.
 * Returns 412 if either is missing.
 */
async function handleAgentPaymentLink(req: http.IncomingMessage, res: http.ServerResponse, bookingId: string): Promise<void> {
  const supplied = req.headers['x-agent-token'];
  const expected = process.env.AGENT_API_TOKEN;
  if (!expected || typeof supplied !== 'string' || supplied !== expected) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const booking = getBooking(bookingId);
  if (!booking) { json(res, 404, { error: 'booking_not_found' }); return; }
  if (booking.status === 'cancelled') { json(res, 409, { error: 'booking_cancelled' }); return; }
  if (!booking.agentInitiated) { json(res, 400, { error: 'not_agent_initiated' }); return; }

  // Idempotent: if Square link already exists, return it.
  if (booking.paymentUrl && booking.squareOrderId) {
    json(res, 200, { paymentUrl: booking.paymentUrl, orderId: booking.squareOrderId, alreadyMinted: true });
    return;
  }

  if (!booking.licenseFileId) { json(res, 412, { error: 'license_missing', detail: 'Customer has not uploaded their driver\'s license yet.' }); return; }
  if (!booking.agreementId) { json(res, 412, { error: 'agreement_missing', detail: 'Customer has not signed the rental agreement yet.' }); return; }

  // Reconstruct pricing from the booking snapshot persisted at agent-checkout time.
  let pricing;
  try {
    const snap = JSON.parse(booking.pricingSnapshot || '{}');
    pricing = {
      equipment: EQUIPMENT[booking.equipment],
      numDays: booking.numDays,
      lineItems: snap.lineItems,
      subtotal: booking.subtotal,
      deposit: booking.deposit,
      balance: booking.balance,
      addOns: booking.addOns,
      paymentMode: snap.paymentMode || 'full',
      chargeNow: snap.chargeNow || (booking.subtotal + booking.deposit),
    };
  } catch (e: any) {
    json(res, 500, { error: 'pricing_snapshot_corrupt', detail: e?.message });
    return;
  }

  let paymentResult;
  try {
    paymentResult = await createPaymentLink(pricing, booking.customer, booking.id);
  } catch (err: any) {
    console.error(`[agent-payment-link] Square error for ${booking.id}: ${err.message}`);
    json(res, 502, { error: 'square_failed', detail: err.message });
    return;
  }

  setBookingPaymentLink(booking.id, {
    orderId: paymentResult.orderId,
    paymentLinkId: paymentResult.paymentLinkId,
    paymentUrl: paymentResult.paymentUrl,
  });

  console.log(`[agent-payment-link] Minted Square link for ${booking.id} (${paymentResult.paymentUrl})`);
  json(res, 200, { paymentUrl: paymentResult.paymentUrl, orderId: paymentResult.orderId });
}

// ── HTML helpers for sign + signed-view pages ───────────────────────

interface SignPageProps {
  bookingId: string;
  signToken: string;
  customerName: string;
  agreementHtml: string;
  alreadySigned: boolean;
}

function renderSignPage(p: SignPageProps): string {
  // Standalone HTML; no shared layout. Inline JS posts to
  // /api/agreements/by-sign-token/:signToken and shows a success state on 200.
  const safeName = p.customerName.replace(/[<>"&']/g, '');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Sign rental agreement — Sheridan Trailer Rentals</title>
<style>
  body { margin: 0; background: #f8fafc; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 16px 14px 80px; }
  .doc { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 6px; max-height: 460px; overflow-y: auto; box-shadow: 0 2px 8px rgba(15,23,42,.06); }
  h2 { margin: 22px 0 6px; font-size: 20px; }
  p.sub { color: #64748b; margin: 0 0 16px; font-size: 14px; }
  label { display: block; font-weight: 600; margin: 14px 0 6px; font-size: 14px; }
  input[type=text] { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; box-sizing: border-box; }
  input[type=text]:focus { outline: 2px solid #0891b2; border-color: #0891b2; }
  .canvas-wrap { position: relative; }
  canvas { width: 100%; height: 170px; background: #fff; border: 1px dashed #cbd5e1; border-radius: 8px; touch-action: none; display: block; }
  .clear { position: absolute; top: 6px; right: 10px; background: transparent; border: 0; color: #64748b; font-size: 13px; cursor: pointer; }
  .check { display: flex; gap: 10px; align-items: flex-start; font-size: 15px; line-height: 1.45; margin: 18px 0 6px; }
  .check input { transform: scale(1.2); margin-top: 3px; }
  button.primary { width: 100%; padding: 16px; font-size: 17px; font-weight: 700; background: #0891b2; color: #fff; border: 0; border-radius: 10px; margin-top: 18px; cursor: pointer; }
  button.primary:disabled { background: #94a3b8; cursor: not-allowed; }
  .error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 12px 14px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
  .ok { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; padding: 16px; border-radius: 10px; font-size: 15px; text-align: center; }
  .ok h2 { margin: 0 0 8px; color: #065f46; }
</style>
</head><body>
<div class="wrap">
  ${p.alreadySigned ? `
    <div class="ok">
      <h2>You're already signed up</h2>
      <p style="margin:0;">Rental agreement for booking ${esc(p.bookingId)} is on file. Reply to your text — Andy will send the payment link shortly.</p>
    </div>` : `
    <div id="ok" class="ok" style="display:none;">
      <h2>Signed — thank you, ${esc(safeName) || 'friend'}.</h2>
      <p style="margin:0;">We've recorded your signature. Reply to your text — Andy will send the payment link in a moment.</p>
    </div>
    <div id="form">
      <div class="doc">${p.agreementHtml}</div>
      <h2>Sign here</h2>
      <p class="sub">Drawing with your finger or trackpad works — clear and re-draw if needed.</p>
      <div class="canvas-wrap"><canvas id="sig"></canvas><button class="clear" type="button" id="clear">Clear</button></div>
      <label for="name">Type your full legal name</label>
      <input id="name" type="text" autocomplete="name" maxlength="120" value="${esc(safeName)}">
      <label class="check"><input id="agree" type="checkbox"><span>I have read and agree to the terms of this rental agreement.</span></label>
      <div id="err" class="error" style="display:none;"></div>
      <button class="primary" type="button" id="submit">Sign &amp; continue</button>
    </div>
  `}
</div>
<script>
(function(){
  ${p.alreadySigned ? '' : `
  var canvas = document.getElementById('sig');
  var btn = document.getElementById('submit');
  var clearBtn = document.getElementById('clear');
  var nameInput = document.getElementById('name');
  var agree = document.getElementById('agree');
  var err = document.getElementById('err');
  var ok = document.getElementById('ok');
  var form = document.getElementById('form');
  var ctx = canvas.getContext('2d');
  var dirty = false;
  var drawing = false;
  var last = null;
  function size(){
    var ratio = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  function clearCanvas(){
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.restore();
    dirty = false;
  }
  size();
  window.addEventListener('resize', function(){ size(); clearCanvas(); });
  function pos(e){
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  canvas.addEventListener('pointerdown', function(e){
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    last = pos(e);
  });
  canvas.addEventListener('pointermove', function(e){
    if (!drawing) return;
    var p = pos(e);
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; dirty = true;
  });
  function stop(e){ drawing = false; last = null; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);
  clearBtn.addEventListener('click', clearCanvas);
  btn.addEventListener('click', function(){
    err.style.display = 'none';
    if (!dirty) { err.textContent = 'Please draw your signature.'; err.style.display = 'block'; return; }
    var name = nameInput.value.trim();
    if (name.length < 2) { err.textContent = 'Please type your full name.'; err.style.display = 'block'; return; }
    if (!agree.checked) { err.textContent = 'Please tick the box to confirm you agree.'; err.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    fetch('/api/agreements/by-sign-token/${encodeURIComponent(p.signToken)}', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: name, signatureDataUrl: canvas.toDataURL('image/png'), iAgree: true }),
    }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
      .then(function(res){
        if (res.ok && res.data.agreementId) {
          form.style.display = 'none'; ok.style.display = 'block';
        } else {
          err.textContent = res.data.detail || res.data.error || 'Something went wrong.';
          err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Sign & continue';
        }
      }).catch(function(){
        err.textContent = 'Connection error — please try again.'; err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Sign & continue';
      });
  });
  `}
})();
</script>
</body></html>`;
}

interface SignedViewProps {
  agreementId: string;
  bookingId: string;
  agreementHtml: string;
  signerName: string;
  signaturePng: string;
  signedAt: string;
  contentHash: string;
  version: string;
  kind: string;
}

function renderSignedView(p: SignedViewProps): string {
  let signedPretty = p.signedAt;
  try {
    const d = new Date(p.signedAt);
    if (!Number.isNaN(d.getTime())) {
      signedPretty = d.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Chicago' }) + ' CT';
    }
  } catch {}
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed rental agreement ${esc(p.agreementId)} — Sheridan Trailer Rentals</title>
<style>
  body { margin: 0; background: #f8fafc; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 16px 14px 60px; }
  .badge { display: inline-block; background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .frame { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 6px; margin-top: 14px; box-shadow: 0 2px 8px rgba(15,23,42,.06); }
  .sig-block { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px 22px; margin-top: 18px; }
  .sig-row { display: flex; gap: 28px; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; }
  .sig-label { font-size: 13px; color: #64748b; margin-bottom: 6px; }
  .sig-img { max-width: 320px; max-height: 110px; border-bottom: 1px solid #0f172a; padding-bottom: 4px; display: block; }
  .sig-name { font-size: 15px; margin-top: 6px; }
  .audit { color: #64748b; font-size: 12px; margin-top: 18px; }
  code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 0.85em; }
  @media print { .badge { border-color: #000; } }
</style>
</head><body>
<div class="wrap">
  <p><span class="badge">SIGNED</span> &nbsp; Agreement ${esc(p.agreementId)} &middot; Booking ${esc(p.bookingId)}</p>
  <div class="frame">${p.agreementHtml}</div>
  <div class="sig-block">
    <div class="sig-row">
      <div>
        <div class="sig-label">Customer signature</div>
        <img class="sig-img" alt="Signature" src="${esc(p.signaturePng)}">
        <div class="sig-name">${esc(p.signerName)}</div>
      </div>
      <div>
        <div class="sig-label">Date signed</div>
        <div style="font-weight:600;font-size:15px;">${esc(signedPretty)}</div>
      </div>
    </div>
  </div>
  <p class="audit">Agreement <code>${esc(p.kind)}</code> v${esc(p.version)} &middot; content hash <code>${esc(p.contentHash.slice(0, 16))}…</code> &middot; non-repudiable record stored by Sheridan Trailer Rentals.</p>
  <p class="audit">To save a PDF copy, use your browser's Print → Save as PDF.</p>
</div>
</body></html>`;
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ── Router ──────────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';

  cors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (isRateLimited(ip)) {
    json(res, 429, { error: 'Rate limited' });
    return;
  }

  const url = req.url || '';

  try {
    // GET /health
    if (req.method === 'GET' && url === '/health') {
      json(res, 200, { status: 'ok', service: 'sheridan-booking' });
      return;
    }

    // POST /api/availability
    if (req.method === 'POST' && url === '/api/availability') {
      await handleAvailability(req, res);
      return;
    }

    // POST /api/delivery-quote — live distance-tiered drop-off fee for the form.
    if (req.method === 'POST' && url === '/api/delivery-quote') {
      await handleDeliveryQuote(req, res);
      return;
    }

    // POST /api/checkout
    if (req.method === 'POST' && url === '/api/checkout') {
      if (isCheckoutRateLimited(ip)) {
        json(res, 429, { error: 'Too many checkout attempts. Please wait a minute and try again.' });
        return;
      }
      await handleCheckout(req, res);
      return;
    }

    // POST /api/agent-checkout — Andy creates a booking from a chat conversation.
    // Requires X-Agent-Token header matching AGENT_API_TOKEN env (set in .env).
    // Skips license-photo-on-disk requirement; license is collected via a
    // post-payment SMS to the customer's phone.
    if (req.method === 'POST' && url === '/api/agent-checkout') {
      const supplied = req.headers['x-agent-token'];
      const expected = process.env.AGENT_API_TOKEN;
      if (!expected) {
        json(res, 503, { error: 'Agent checkout disabled — AGENT_API_TOKEN not configured on server.' });
        return;
      }
      if (typeof supplied !== 'string' || supplied !== expected) {
        json(res, 401, { error: 'Unauthorized — missing or invalid X-Agent-Token.' });
        return;
      }
      await handleAgentCheckout(req, res);
      return;
    }

    // POST /api/upload-license/:bookingId — customer-facing license upload
    // (called from the /license/:id HTML page, no auth, throttled by IP).
    if (req.method === 'POST' && url.startsWith('/api/upload-license/')) {
      const id = url.split('/api/upload-license/')[1]?.split('?')[0] || '';
      await handleUploadLicenseByBooking(req, res, id);
      return;
    }

    // GET /license/:bookingId — mobile-friendly license upload page
    if (req.method === 'GET' && url.startsWith('/license/')) {
      const id = url.split('/license/')[1]?.split('?')[0] || '';
      handleLicensePage(res, id);
      return;
    }

    // GET /api/license/:bookingId?t=<signToken> — owner-only license photo view.
    // Gated on the booking's per-booking sign_token (unguessable; no new secret).
    // Streams the stored image so the owner can review it from the email link.
    if (req.method === 'GET' && url.startsWith('/api/license/')) {
      const rest = url.split('/api/license/')[1] || '';
      const [licBookingId, licQs] = rest.split('?');
      const token = new URLSearchParams(licQs || '').get('t') || '';
      if (licBookingId) {
        handleGetLicense(res, licBookingId, token);
        return;
      }
    }

    // ── Rental Agreement endpoints ────────────────────────────────────
    // POST /api/agreements/preview — read-only render for the sign UI
    if (req.method === 'POST' && url === '/api/agreements/preview') {
      await handleAgreementPreview(req, res);
      return;
    }
    // POST /api/agreements/pre-booking — web form sign step before checkout
    if (req.method === 'POST' && url === '/api/agreements/pre-booking') {
      await handleSignAgreementPreBooking(req, res);
      return;
    }
    // POST /api/agreements/by-sign-token/:signToken — Andy's flow
    if (req.method === 'POST' && url.startsWith('/api/agreements/by-sign-token/')) {
      const token = url.split('/api/agreements/by-sign-token/')[1]?.split('?')[0] || '';
      await handleSignAgreementByToken(req, res, token);
      return;
    }
    // GET /api/agreements/:id — public read-only signed view
    if (req.method === 'GET' && url.startsWith('/api/agreements/')) {
      const id = url.split('/api/agreements/')[1]?.split('?')[0] || '';
      handleGetAgreement(res, id);
      return;
    }
    // GET /sign/:bookingId/:signToken — mobile signing page (Andy's flow)
    if (req.method === 'GET' && url.startsWith('/sign/')) {
      const rest = url.split('/sign/')[1] || '';
      const [bookingId, signToken] = rest.split('?')[0].split('/');
      if (bookingId && signToken) {
        handleSignPage(res, bookingId, signToken);
        return;
      }
    }
    // POST /api/agent-payment-link/:bookingId — Andy's mint step
    if (req.method === 'POST' && url.startsWith('/api/agent-payment-link/')) {
      const id = url.split('/api/agent-payment-link/')[1]?.split('?')[0] || '';
      await handleAgentPaymentLink(req, res, id);
      return;
    }

    // POST /api/square-webhook
    if (req.method === 'POST' && url === '/api/square-webhook') {
      await handleSquareWebhook(req, res);
      return;
    }

    // POST /api/upload  (license photo)
    if (req.method === 'POST' && url === '/api/upload') {
      await handleUpload(req, res);
      return;
    }

    // POST /api/upload-inspection  (car hauler inspection photos)
    if (req.method === 'POST' && url === '/api/upload-inspection') {
      await handleUploadInspection(req, res);
      return;
    }

    // GET /api/inspection/:bookingId?type=before|after
    if (req.method === 'GET' && url.startsWith('/api/inspection/')) {
      const rest = url.split('/api/inspection/')[1] || '';
      const [inspBookingId, qs] = rest.split('?');
      const typeFilter = new URLSearchParams(qs || '').get('type') || '';
      if (inspBookingId) {
        handleGetInspection(res, inspBookingId, typeFilter);
        return;
      }
    }

    // POST /api/cancel
    if (req.method === 'POST' && url === '/api/cancel') {
      await handleCancel(req, res);
      return;
    }

    // GET /api/booking/:id
    if (req.method === 'GET' && url.startsWith('/api/booking/')) {
      const bookingId = url.split('/api/booking/')[1]?.split('?')[0];
      if (bookingId) {
        handleGetBooking(res, bookingId);
        return;
      }
    }

    // Also support the legacy endpoint used by the widget
    if (req.method === 'POST' && url === '/api/create-booking') {
      await handleCheckout(req, res);
      return;
    }

    // Legacy booking status endpoint
    if (req.method === 'GET' && url.startsWith('/api/booking-status')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const id = params.get('id');
      if (id) {
        handleGetBooking(res, id);
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  } catch (err: any) {
    console.error(`[server] Error handling ${req.method} ${url}:`, err.message);
    json(res, 500, { error: 'Internal server error' });
  }
}

// ── Start ───────────────────────────────────────────────────────────

function start(): void {
  loadEnv();

  PORT = parseInt(process.env.BOOKING_PORT || '3200', 10);
  ALLOWED_ORIGINS = (process.env.BOOKING_ALLOWED_ORIGIN || 'https://sheridantrailerrentals.us')
    .split(',').map(o => o.trim());

  initDb();

  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    console.log(`[booking-api] Sheridan Rentals Booking API listening on port ${PORT}`);
    console.log(`[booking-api] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });

  // Expire stale pending bookings every 5 minutes (frees blocked dates)
  setInterval(() => {
    const expired = expireStalePendingBookings(30);
    if (expired > 0) console.log(`[cleanup] Expired ${expired} stale pending booking(s)`)
  }, 5 * 60 * 1000);

  // Watchdog: any paid/confirmed booking older than 2 minutes with no
  // owner_notified_at stamp gets a retroactive owner notification.
  // Guards against silent SMTP/forwarder failures — a paid booking can
  // never go unnoticed for more than ~3 minutes.
  let watchdogRunning = false;
  setInterval(async () => {
    if (watchdogRunning) return; // skip overlapping ticks
    watchdogRunning = true;
    try {
      const unnotified = getUnnotifiedPaidBookings(120);
      for (const b of unnotified) {
        if (inFlightOwnerNotify.has(b.id)) continue; // webhook is already sending
        await notifyOwnerOnce(b, 'watchdog');
      }
    } finally {
      watchdogRunning = false;
    }
  }, 60 * 1000);

  // Graceful shutdown
  const shutdown = () => {
    console.log('[booking-api] Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
