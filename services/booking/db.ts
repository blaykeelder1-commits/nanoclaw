/**
 * SQLite database for Sheridan Rentals bookings.
 * Adapted from nanoclaw/src/db.ts pattern.
 * Uses better-sqlite3 for synchronous operations.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Agreement, AgreementKind, Booking, BookingStatus, Customer, EquipmentKey } from './types.js';

let db: Database.Database;

export function initDb(dbPath?: string): void {
  const file = dbPath || path.join(process.cwd(), 'data', 'bookings.db');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema();
}

function createSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      equipment TEXT NOT NULL,
      equipment_label TEXT NOT NULL,
      dates TEXT NOT NULL,
      num_days INTEGER NOT NULL,
      customer_first TEXT NOT NULL,
      customer_last TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      subtotal REAL NOT NULL,
      deposit REAL NOT NULL,
      balance REAL NOT NULL,
      add_ons TEXT NOT NULL DEFAULT '[]',
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      square_order_id TEXT NOT NULL DEFAULT '',
      square_payment_link_id TEXT NOT NULL DEFAULT '',
      payment_url TEXT NOT NULL DEFAULT '',
      calendar_event_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_equipment_dates ON bookings(equipment, dates);
    CREATE INDEX IF NOT EXISTS idx_bookings_square_order ON bookings(square_order_id);

    -- Electronic rental agreements. One row per signed copy bound to a booking.
    -- content_hash is SHA-256 of the canonical rendered text at signing time
    -- so we can prove later which exact version the customer signed.
    -- For the web-form path, rows are inserted with booking_id='' + an
    -- agreement_token and linked to the real booking on /api/checkout success.
    CREATE TABLE IF NOT EXISTS agreements (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL DEFAULT '',
      agreement_token TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      signer_name TEXT NOT NULL,
      signer_email TEXT NOT NULL,
      signature_png TEXT NOT NULL,
      signer_ip TEXT NOT NULL DEFAULT '',
      signer_ua TEXT NOT NULL DEFAULT '',
      signed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agreements_booking ON agreements(booking_id);
    CREATE INDEX IF NOT EXISTS idx_agreements_token ON agreements(agreement_token);
  `);

  // Migrations — add columns that may not exist in older databases
  const migrations = [
    `ALTER TABLE bookings ADD COLUMN refund_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN followup_sent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN followup_sent_at TEXT`,
    `ALTER TABLE bookings ADD COLUMN license_photo TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN delivery_address TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN owner_notified_at TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN agent_initiated INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN license_sms_sent_at TEXT NOT NULL DEFAULT ''`,
    // Agreement linkage
    `ALTER TABLE bookings ADD COLUMN agreement_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN sign_token TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN agreement_sms_sent_at TEXT NOT NULL DEFAULT ''`,
    // Agent-checkout flow needs to defer Square link creation until after license + agreement.
    // We snapshot the pricing result JSON so the later agent-payment-link mint can hand
    // the same numbers to Square without re-validating dates or promo codes.
    `ALTER TABLE bookings ADD COLUMN pricing_snapshot TEXT NOT NULL DEFAULT ''`,
    // Pickup time slot for car hauler / utility (also the drop-off due time). Empty for RV.
    `ALTER TABLE bookings ADD COLUMN pickup_time TEXT NOT NULL DEFAULT ''`,
    // Attribution + server-side conversion tracking. device is parsed from the
    // checkout User-Agent so we get a GROUND-TRUTH mobile/desktop split for EVERY
    // booking (incl. pending/cancelled) — independent of GA's client-side undercount.
    // ga_client_id / gclid let the webhook fire a server-side conversion that's
    // joined to the original session. conversion_sent_at guards against double-fire.
    `ALTER TABLE bookings ADD COLUMN device TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN ga_client_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN gclid TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN conversion_sent_at TEXT NOT NULL DEFAULT ''`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// ── Generate Booking ID ─────────────────────────────────────────────

export function generateBookingId(): string {
  // Short, URL-safe booking ID: SR-XXXXXXXX
  return `SR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export function generateAgreementId(): string {
  // AG-XXXXXXXXXXXXXXXX — 16 hex chars = 64 bits of entropy, unguessable.
  return `AG-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

export function generateAgreementToken(): string {
  // Short-lived pre-booking token used by the web form to link sign step → checkout.
  return crypto.randomBytes(16).toString('hex');
}

export function generateSignToken(): string {
  // Unguessable token in the /sign/:bookingId/:signToken URL for Andy's flow.
  return crypto.randomBytes(16).toString('hex');
}

// ── CRUD Operations ─────────────────────────────────────────────────

export function createBooking(params: {
  id: string;
  equipment: EquipmentKey;
  equipmentLabel: string;
  dates: string[];
  numDays: number;
  customer: Customer;
  subtotal: number;
  deposit: number;
  balance: number;
  addOns: string[];
  details: string;
  squareOrderId: string;
  squarePaymentLinkId: string;
  paymentUrl: string;
  deliveryAddress?: string;
  pickupTime?: string;
  agentInitiated?: boolean;
  device?: string;
  gaClientId?: string;
  gclid?: string;
}): Booking {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO bookings (
      id, equipment, equipment_label, dates, num_days,
      customer_first, customer_last, customer_email, customer_phone,
      subtotal, deposit, balance, add_ons, details, status,
      square_order_id, square_payment_link_id, payment_url,
      calendar_event_id, delivery_address, pickup_time, agent_initiated,
      device, ga_client_id, gclid, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, 'pending',
      ?, ?, ?,
      '', ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `).run(
    params.id, params.equipment, params.equipmentLabel,
    JSON.stringify(params.dates), params.numDays,
    params.customer.firstName, params.customer.lastName,
    params.customer.email, params.customer.phone,
    params.subtotal, params.deposit, params.balance,
    JSON.stringify(params.addOns), params.details,
    params.squareOrderId, params.squarePaymentLinkId, params.paymentUrl,
    params.deliveryAddress || '',
    params.pickupTime || '',
    params.agentInitiated ? 1 : 0,
    params.device || '',
    params.gaClientId || '',
    params.gclid || '',
    now, now,
  );

  return getBooking(params.id)!;
}

export function markLicenseSmsSent(id: string): void {
  db.prepare(`UPDATE bookings SET license_sms_sent_at = ?, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), new Date().toISOString(), id);
}

export function getBooking(id: string): Booking | null {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as any;
  if (!row) return null;
  return rowToBooking(row);
}

export function getBookingByOrderId(orderId: string): Booking | null {
  const row = db.prepare('SELECT * FROM bookings WHERE square_order_id = ?').get(orderId) as any;
  if (!row) return null;
  return rowToBooking(row);
}

export function updateBookingStatus(id: string, status: BookingStatus): void {
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

export function clearBalance(id: string): void {
  db.prepare('UPDATE bookings SET balance = 0, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function setCalendarEventId(id: string, eventId: string): void {
  db.prepare('UPDATE bookings SET calendar_event_id = ?, updated_at = ? WHERE id = ?')
    .run(eventId, new Date().toISOString(), id);
}

export function setLicensePhoto(id: string, fileId: string): void {
  db.prepare('UPDATE bookings SET license_photo = ?, updated_at = ? WHERE id = ?')
    .run(fileId, new Date().toISOString(), id);
}

export function cancelBooking(id: string, refundId?: string): void {
  db.prepare(`
    UPDATE bookings
    SET status = 'cancelled',
        updated_at = ?,
        refund_id = COALESCE(?, refund_id)
    WHERE id = ?
  `).run(new Date().toISOString(), refundId || null, id);
}

export function getBookingsByEmail(email: string): Booking[] {
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE customer_email = ? AND status != 'cancelled'
    ORDER BY created_at DESC
  `).all(email) as any[];
  return rows.map(rowToBooking);
}

export function getActiveBookings(): Booking[] {
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('pending', 'paid', 'confirmed')
    ORDER BY created_at DESC
  `).all() as any[];
  return rows.map(rowToBooking);
}

// ── Owner-Notification Audit ────────────────────────────────────────

/** Stamp that the owner has been successfully notified about this booking. */
export function markOwnerNotified(id: string): void {
  db.prepare('UPDATE bookings SET owner_notified_at = ?, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), new Date().toISOString(), id);
}

/**
 * Atomically claim the server-side conversion send for a booking. Returns true
 * only for the FIRST caller (stamps conversion_sent_at in the same UPDATE that
 * checks it's empty), so duplicate webhooks never double-count a conversion.
 */
export function claimConversionSend(id: string): boolean {
  const now = new Date().toISOString();
  const res = db
    .prepare("UPDATE bookings SET conversion_sent_at = ?, updated_at = ? WHERE id = ? AND conversion_sent_at = ''")
    .run(now, now, id);
  return res.changes > 0;
}

/**
 * Find paid/confirmed bookings the owner has not been notified about yet.
 * Window: older than `minAgeSeconds` (so we don't race the normal post-webhook
 * send) AND newer than `maxAgeHours` (so a fresh deploy never resends ancient
 * bookings whose column starts empty after migration).
 */
export function getUnnotifiedPaidBookings(minAgeSeconds = 120, maxAgeHours = 24): Booking[] {
  const newerCutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const olderCutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('paid', 'confirmed')
      AND owner_notified_at = ''
      AND created_at < ?
      AND created_at > ?
    ORDER BY created_at ASC
  `).all(newerCutoff, olderCutoff) as any[];
  return rows.map(rowToBooking);
}

// ── Pending Booking Cleanup ─────────────────────────────────────────

/** Expire pending bookings older than the given minutes (default 30min). */
export function expireStalePendingBookings(maxAgeMinutes = 30): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const result = db.prepare(`
    UPDATE bookings SET status = 'cancelled', updated_at = ?
    WHERE status = 'pending' AND created_at < ?
  `).run(new Date().toISOString(), cutoff);
  return result.changes;
}

// ── Availability: DB Busy Dates ─────────────────────────────────────

/** Return dates from active bookings (pending/paid/confirmed) for a date range. */
export function getBookedDatesFromDb(
  equipment: EquipmentKey,
  startDate: string,
  endDate: string,
): { start: string; end: string }[] {
  const rows = db.prepare(`
    SELECT dates FROM bookings
    WHERE equipment = ? AND status IN ('pending', 'paid', 'confirmed')
  `).all(equipment) as Array<{ dates: string }>;

  const slots: { start: string; end: string }[] = [];
  for (const row of rows) {
    let dates: string[];
    try { dates = JSON.parse(row.dates); } catch { continue; }
    for (const d of dates) {
      if (d >= startDate && d <= endDate) {
        slots.push({ start: `${d}T00:00:00Z`, end: `${d}T23:59:59Z` });
      }
    }
  }
  return slots;
}

// ── Double-Booking Prevention ───────────────────────────────────────

export function hasOverlappingBooking(equipment: EquipmentKey, dates: string[]): boolean {
  // Check if any active booking overlaps with the requested dates
  // Must match the same statuses used in availability display
  const rows = db.prepare(`
    SELECT dates FROM bookings
    WHERE equipment = ? AND status IN ('pending', 'paid', 'confirmed')
  `).all(equipment) as Array<{ dates: string }>;

  const requestedSet = new Set(dates);

  for (const row of rows) {
    const bookedDates: string[] = JSON.parse(row.dates);
    for (const d of bookedDates) {
      if (requestedSet.has(d)) return true;
    }
  }
  return false;
}

// ── Agreement Operations ────────────────────────────────────────────

/**
 * Insert a pre-booking agreement (web-form flow). booking_id is empty and will
 * be populated by linkAgreementToBooking() once /api/checkout creates the row.
 */
export function createPreBookingAgreement(params: {
  id: string;
  agreementToken: string;
  kind: AgreementKind;
  version: string;
  contentHash: string;
  signerName: string;
  signerEmail: string;
  signaturePng: string;
  signerIp?: string;
  signerUa?: string;
}): Agreement {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agreements (
      id, booking_id, agreement_token, kind, version, content_hash,
      signer_name, signer_email, signature_png,
      signer_ip, signer_ua, signed_at
    ) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id, params.agreementToken, params.kind, params.version, params.contentHash,
    params.signerName, params.signerEmail, params.signaturePng,
    params.signerIp || '', params.signerUa || '', now,
  );
  return getAgreement(params.id)!;
}

/**
 * Insert an agreement directly bound to an existing booking (Andy's flow).
 * No agreement_token because the link is by sign_token on the booking.
 */
export function createBookingAgreement(params: {
  id: string;
  bookingId: string;
  kind: AgreementKind;
  version: string;
  contentHash: string;
  signerName: string;
  signerEmail: string;
  signaturePng: string;
  signerIp?: string;
  signerUa?: string;
}): Agreement {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agreements (
      id, booking_id, agreement_token, kind, version, content_hash,
      signer_name, signer_email, signature_png,
      signer_ip, signer_ua, signed_at
    ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id, params.bookingId, params.kind, params.version, params.contentHash,
    params.signerName, params.signerEmail, params.signaturePng,
    params.signerIp || '', params.signerUa || '', now,
  );
  db.prepare('UPDATE bookings SET agreement_id = ?, updated_at = ? WHERE id = ?')
    .run(params.id, now, params.bookingId);
  return getAgreement(params.id)!;
}

export function getAgreement(id: string): Agreement | null {
  const row = db.prepare('SELECT * FROM agreements WHERE id = ?').get(id) as any;
  return row ? rowToAgreement(row) : null;
}

export function getAgreementByToken(token: string): Agreement | null {
  const row = db.prepare('SELECT * FROM agreements WHERE agreement_token = ? AND booking_id = \'\'').get(token) as any;
  return row ? rowToAgreement(row) : null;
}

export function getAgreementForBooking(bookingId: string): Agreement | null {
  const row = db.prepare('SELECT * FROM agreements WHERE booking_id = ? LIMIT 1').get(bookingId) as any;
  return row ? rowToAgreement(row) : null;
}

/** Web-form completion: link the pre-booking row to the freshly-created booking. */
export function linkAgreementToBooking(agreementId: string, bookingId: string): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE agreements SET booking_id = ?, agreement_token = '' WHERE id = ?`)
    .run(bookingId, agreementId);
  db.prepare('UPDATE bookings SET agreement_id = ?, updated_at = ? WHERE id = ?')
    .run(agreementId, now, bookingId);
}

export function getBookingBySignToken(signToken: string): Booking | null {
  if (!signToken) return null;
  const row = db.prepare('SELECT * FROM bookings WHERE sign_token = ?').get(signToken) as any;
  return row ? rowToBooking(row) : null;
}

export function setBookingPaymentLink(id: string, square: { orderId: string; paymentLinkId: string; paymentUrl: string }): void {
  db.prepare(`
    UPDATE bookings
    SET square_order_id = ?, square_payment_link_id = ?, payment_url = ?, updated_at = ?
    WHERE id = ?
  `).run(square.orderId, square.paymentLinkId, square.paymentUrl, new Date().toISOString(), id);
}

export function setBookingSignToken(id: string, signToken: string): void {
  db.prepare('UPDATE bookings SET sign_token = ?, updated_at = ? WHERE id = ?')
    .run(signToken, new Date().toISOString(), id);
}

export function setBookingPricingSnapshot(id: string, snapshotJson: string): void {
  db.prepare('UPDATE bookings SET pricing_snapshot = ?, updated_at = ? WHERE id = ?')
    .run(snapshotJson, new Date().toISOString(), id);
}

export function getBookingPricingSnapshot(id: string): string {
  const row = db.prepare('SELECT pricing_snapshot FROM bookings WHERE id = ?').get(id) as { pricing_snapshot?: string } | undefined;
  return row?.pricing_snapshot || '';
}

// ── Helpers ─────────────────────────────────────────────────────────

function rowToBooking(row: any): Booking {
  return {
    id: row.id,
    equipment: row.equipment,
    equipmentLabel: row.equipment_label,
    dates: JSON.parse(row.dates),
    numDays: row.num_days,
    customer: {
      firstName: row.customer_first,
      lastName: row.customer_last,
      email: row.customer_email,
      phone: row.customer_phone,
    },
    subtotal: row.subtotal,
    deposit: row.deposit,
    balance: row.balance,
    addOns: JSON.parse(row.add_ons),
    details: row.details,
    status: row.status,
    squareOrderId: row.square_order_id,
    squarePaymentLinkId: row.square_payment_link_id,
    paymentUrl: row.payment_url,
    calendarEventId: row.calendar_event_id,
    refundId: row.refund_id || '',
    followupSent: !!row.followup_sent,
    followupSentAt: row.followup_sent_at || null,
    licenseFileId: row.license_photo || '',
    deliveryAddress: row.delivery_address || '',
    pickupTime: row.pickup_time || '',
    agentInitiated: !!row.agent_initiated,
    licenseSmsSentAt: row.license_sms_sent_at || '',
    agreementId: row.agreement_id || '',
    signToken: row.sign_token || '',
    agreementSmsSentAt: row.agreement_sms_sent_at || '',
    pricingSnapshot: row.pricing_snapshot || '',
    device: row.device || '',
    gaClientId: row.ga_client_id || '',
    gclid: row.gclid || '',
    conversionSentAt: row.conversion_sent_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAgreement(row: any): Agreement {
  return {
    id: row.id,
    bookingId: row.booking_id || '',
    agreementToken: row.agreement_token || '',
    kind: row.kind,
    version: row.version,
    contentHash: row.content_hash,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    signaturePng: row.signature_png,
    signerIp: row.signer_ip || '',
    signerUa: row.signer_ua || '',
    signedAt: row.signed_at,
  };
}
