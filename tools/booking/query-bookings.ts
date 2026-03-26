#!/usr/bin/env tsx
/**
 * Sheridan Rentals Booking Tool
 * Query and manage bookings in the SQLite database.
 *
 * Read commands:
 *   query-bookings.ts list [--status <status>] [--equipment <key>] [--days <n>]
 *   query-bookings.ts get <booking-id>
 *   query-bookings.ts summary
 *   query-bookings.ts digest
 *   query-bookings.ts unpaid-balances
 *
 * Write commands:
 *   query-bookings.ts update-status <booking-id> <status>
 *   query-bookings.ts update-dates <booking-id> <date1,date2,...>
 *   query-bookings.ts update-customer <booking-id> --first <name> --last <name> --email <email> --phone <phone>
 *   query-bookings.ts add-note <booking-id> <note text>
 *   query-bookings.ts cancel <booking-id>
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── Find Database ───────────────────────────────────────────────────

const DB_PATHS = [
  '/workspace/extra/booking-data/bookings.db',
  '/workspace/project/services/booking/data/bookings.db',
  path.join(process.cwd(), 'services', 'booking', 'data', 'bookings.db'),
  path.join(process.cwd(), 'data', 'bookings.db'),
];

function findDb(): string {
  for (const p of DB_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  console.error(JSON.stringify({ error: 'Bookings database not found', searched: DB_PATHS }));
  process.exit(1);
}

const WRITE_COMMANDS = ['update-status', 'update-dates', 'update-customer', 'add-note', 'cancel'];
const isWrite = WRITE_COMMANDS.includes(process.argv[2]);
const db = new Database(findDb(), { readonly: !isWrite });

// ── Types ───────────────────────────────────────────────────────────

interface BookingRow {
  id: string;
  equipment: string;
  equipment_label: string;
  dates: string;
  num_days: number;
  customer_first: string;
  customer_last: string;
  customer_email: string;
  customer_phone: string;
  subtotal: number;
  deposit: number;
  balance: number;
  add_ons: string;
  details: string;
  status: string;
  square_order_id: string;
  calendar_event_id: string;
  created_at: string;
  updated_at: string;
}

function formatRow(row: BookingRow) {
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
    addOns: JSON.parse(row.add_ons),
    details: row.details,
    status: row.status,
    hasCalendarEvent: !!row.calendar_event_id,
    createdAt: row.created_at,
  };
}

// ── Commands ────────────────────────────────────────────────────────

function cmdList(args: string[]) {
  let status: string | null = null;
  let equipment: string | null = null;
  let days: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) { status = args[++i]; }
    else if (args[i] === '--equipment' && args[i + 1]) { equipment = args[++i]; }
    else if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[++i], 10); }
  }

  let sql = 'SELECT * FROM bookings WHERE 1=1';
  const params: any[] = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (equipment) {
    sql += ' AND equipment = ?';
    params.push(equipment);
  }
  if (days) {
    // Filter to bookings with at least one date within the next N days
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
    // SQLite JSON: check if any date in the array falls in range
    sql += ` AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d
      WHERE d.value >= ? AND d.value <= ?
    )`;
    params.push(today, future);
  }

  sql += ' ORDER BY created_at DESC LIMIT 50';

  const rows = db.prepare(sql).all(...params) as BookingRow[];
  console.log(JSON.stringify({
    count: rows.length,
    bookings: rows.map(formatRow),
  }, null, 2));
}

function cmdGet(bookingId: string) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!row) {
    console.log(JSON.stringify({ error: `Booking ${bookingId} not found` }));
    process.exit(1);
  }
  console.log(JSON.stringify(formatRow(row), null, 2));
}

function cmdSummary() {
  const today = new Date().toISOString().split('T')[0];
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const upcoming = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('confirmed', 'paid')
    AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d
      WHERE d.value >= ? AND d.value <= ?
    )
    ORDER BY created_at ASC
  `).all(today, weekEnd) as BookingRow[];

  const byEquipment: Record<string, any[]> = {};
  for (const row of upcoming) {
    const key = row.equipment_label;
    if (!byEquipment[key]) byEquipment[key] = [];
    byEquipment[key].push(formatRow(row));
  }

  console.log(JSON.stringify({
    period: `${today} to ${weekEnd}`,
    totalBookings: upcoming.length,
    byEquipment,
  }, null, 2));
}

function cmdDigest() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const weekEnd = new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0];

  // Tomorrow's bookings (pickups starting tomorrow)
  const tomorrowBookings = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('confirmed', 'paid')
    AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d WHERE d.value = ?
    )
  `).all(tomorrow) as BookingRow[];

  // This week's bookings
  const weekBookings = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('confirmed', 'paid')
    AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d
      WHERE d.value >= ? AND d.value <= ?
    )
    ORDER BY created_at ASC
  `).all(today, weekEnd) as BookingRow[];

  // Pending bookings (awaiting payment)
  const pending = db.prepare(`
    SELECT * FROM bookings WHERE status = 'pending'
    ORDER BY created_at DESC LIMIT 10
  `).all() as BookingRow[];

  // Revenue for the week
  const weekRevenue = weekBookings.reduce((sum, r) => sum + r.subtotal, 0);

  // Recent bookings (last 24h)
  const oneDayAgo = new Date(now.getTime() - 86400000).toISOString();
  const recentBookings = db.prepare(`
    SELECT * FROM bookings WHERE created_at >= ?
    ORDER BY created_at DESC
  `).all(oneDayAgo) as BookingRow[];

  console.log(JSON.stringify({
    date: today,
    tomorrowPickups: tomorrowBookings.map(formatRow),
    thisWeek: {
      count: weekBookings.length,
      revenue: weekRevenue,
      bookings: weekBookings.map(formatRow),
    },
    pendingPayment: pending.map(formatRow),
    last24h: recentBookings.map(formatRow),
  }, null, 2));
}

// ── Unpaid Balances ─────────────────────────────────────────────────

function cmdUnpaidBalances() {
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE status = 'paid' AND balance > 0
    ORDER BY created_at ASC
  `).all() as BookingRow[];

  const now = new Date();
  const results = rows.map(row => {
    const dates: string[] = JSON.parse(row.dates);
    const firstDate = new Date(dates[0] + 'T00:00:00');
    const daysUntil = Math.floor((firstDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return {
      ...formatRow(row),
      balance: row.balance,
      deposit: row.deposit,
      daysUntilPickup: daysUntil,
      urgent: daysUntil <= 2,
    };
  });

  console.log(JSON.stringify({
    count: results.length,
    totalBalanceDue: results.reduce((sum, r) => sum + r.balance, 0),
    bookings: results,
  }, null, 2));
}

// ── Write Commands ──────────────────────────────────────────────────

function cmdUpdateStatus(bookingId: string, newStatus: string) {
  const validStatuses = ['pending', 'paid', 'confirmed', 'cancelled', 'refunded'];
  if (!validStatuses.includes(newStatus)) {
    console.error(JSON.stringify({ error: `Invalid status "${newStatus}". Valid: ${validStatuses.join(', ')}` }));
    process.exit(1);
  }

  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!row) {
    console.error(JSON.stringify({ error: `Booking ${bookingId} not found` }));
    process.exit(1);
  }

  const oldStatus = row.status;
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?')
    .run(newStatus, new Date().toISOString(), bookingId);

  console.log(JSON.stringify({
    success: true,
    bookingId,
    oldStatus,
    newStatus,
    message: `Booking ${bookingId} status changed from "${oldStatus}" to "${newStatus}"`,
  }));
}

function cmdUpdateDates(bookingId: string, datesStr: string) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!row) {
    console.error(JSON.stringify({ error: `Booking ${bookingId} not found` }));
    process.exit(1);
  }

  const newDates = datesStr.split(',').map(d => d.trim()).sort();
  // Validate date format
  for (const d of newDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      console.error(JSON.stringify({ error: `Invalid date format "${d}". Use YYYY-MM-DD` }));
      process.exit(1);
    }
  }

  const oldDates = JSON.parse(row.dates);
  const numDays = newDates.length;

  // Recalculate subtotal based on equipment rate
  const rates: Record<string, number> = { rv: 150, carhauler: 65, landscaping: 50 };
  const rate = rates[row.equipment] || 0;
  const addOns: string[] = JSON.parse(row.add_ons);
  let addOnTotal = 0;
  if (addOns.includes('delivery')) addOnTotal += 250;
  if (addOns.includes('generator')) addOnTotal += 75 * numDays;
  const subtotal = rate * numDays + addOnTotal;

  db.prepare(`
    UPDATE bookings SET dates = ?, num_days = ?, subtotal = ?, updated_at = ? WHERE id = ?
  `).run(JSON.stringify(newDates), numDays, subtotal, new Date().toISOString(), bookingId);

  console.log(JSON.stringify({
    success: true,
    bookingId,
    oldDates,
    newDates,
    numDays,
    newSubtotal: subtotal,
    message: `Booking ${bookingId} dates updated. New total: $${subtotal.toFixed(2)}`,
  }));
}

function cmdUpdateCustomer(bookingId: string, args: string[]) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!row) {
    console.error(JSON.stringify({ error: `Booking ${bookingId} not found` }));
    process.exit(1);
  }

  const updates: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--first' && args[i + 1]) updates.customer_first = args[++i];
    else if (args[i] === '--last' && args[i + 1]) updates.customer_last = args[++i];
    else if (args[i] === '--email' && args[i + 1]) updates.customer_email = args[++i];
    else if (args[i] === '--phone' && args[i + 1]) updates.customer_phone = args[++i];
  }

  if (Object.keys(updates).length === 0) {
    console.error(JSON.stringify({ error: 'No updates provided. Use --first, --last, --email, --phone' }));
    process.exit(1);
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), new Date().toISOString(), bookingId];
  db.prepare(`UPDATE bookings SET ${setClauses}, updated_at = ? WHERE id = ?`).run(...values);

  console.log(JSON.stringify({
    success: true,
    bookingId,
    updated: updates,
    message: `Customer info updated for booking ${bookingId}`,
  }));
}

function cmdAddNote(bookingId: string, note: string) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!row) {
    console.error(JSON.stringify({ error: `Booking ${bookingId} not found` }));
    process.exit(1);
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const existing = row.details || '';
  const updated = existing ? `${existing}\n[${timestamp}] ${note}` : `[${timestamp}] ${note}`;

  db.prepare('UPDATE bookings SET details = ?, updated_at = ? WHERE id = ?')
    .run(updated, new Date().toISOString(), bookingId);

  console.log(JSON.stringify({
    success: true,
    bookingId,
    note,
    message: `Note added to booking ${bookingId}`,
  }));
}

function cmdCancel(bookingId: string) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!row) {
    console.error(JSON.stringify({ error: `Booking ${bookingId} not found` }));
    process.exit(1);
  }

  if (row.status === 'cancelled') {
    console.log(JSON.stringify({ error: `Booking ${bookingId} is already cancelled` }));
    process.exit(1);
  }

  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?')
    .run('cancelled', new Date().toISOString(), bookingId);

  console.log(JSON.stringify({
    success: true,
    bookingId,
    previousStatus: row.status,
    calendarEventId: row.calendar_event_id || null,
    message: `Booking ${bookingId} cancelled.${row.calendar_event_id ? ' Remember to delete the Google Calendar event.' : ''}`,
  }));
}

// ── CLI Router ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'list':
    cmdList(args.slice(1));
    break;
  case 'get':
    if (!args[1]) {
      console.error(JSON.stringify({ error: 'Usage: query-bookings.ts get <booking-id>' }));
      process.exit(1);
    }
    cmdGet(args[1]);
    break;
  case 'summary':
    cmdSummary();
    break;
  case 'digest':
    cmdDigest();
    break;
  case 'unpaid-balances':
    cmdUnpaidBalances();
    break;
  case 'update-status':
    if (!args[1] || !args[2]) {
      console.error(JSON.stringify({ error: 'Usage: query-bookings.ts update-status <booking-id> <status>' }));
      process.exit(1);
    }
    cmdUpdateStatus(args[1], args[2]);
    break;
  case 'update-dates':
    if (!args[1] || !args[2]) {
      console.error(JSON.stringify({ error: 'Usage: query-bookings.ts update-dates <booking-id> <date1,date2,...>' }));
      process.exit(1);
    }
    cmdUpdateDates(args[1], args[2]);
    break;
  case 'update-customer':
    if (!args[1]) {
      console.error(JSON.stringify({ error: 'Usage: query-bookings.ts update-customer <booking-id> --first X --last Y --email Z --phone W' }));
      process.exit(1);
    }
    cmdUpdateCustomer(args[1], args.slice(2));
    break;
  case 'add-note':
    if (!args[1] || !args[2]) {
      console.error(JSON.stringify({ error: 'Usage: query-bookings.ts add-note <booking-id> "note text"' }));
      process.exit(1);
    }
    cmdAddNote(args[1], args.slice(2).join(' '));
    break;
  case 'cancel':
    if (!args[1]) {
      console.error(JSON.stringify({ error: 'Usage: query-bookings.ts cancel <booking-id>' }));
      process.exit(1);
    }
    cmdCancel(args[1]);
    break;
  default:
    console.error(JSON.stringify({
      error: `Unknown command: ${command}`,
      usage: [
        'list [--status confirmed] [--equipment rv] [--days 7]',
        'get <booking-id>',
        'summary',
        'digest',
        'unpaid-balances',
        'update-status <booking-id> <pending|paid|confirmed|cancelled|refunded>',
        'update-dates <booking-id> <2026-04-01,2026-04-02>',
        'update-customer <booking-id> --first X --last Y --email Z --phone W',
        'add-note <booking-id> "note text"',
        'cancel <booking-id>',
      ],
    }));
    process.exit(1);
}
