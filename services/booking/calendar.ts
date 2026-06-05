/**
 * Google Calendar integration for Sheridan Rentals Booking API.
 * Adapted from nanoclaw/tools/calendar/calendar.ts
 *
 * Uses service account JWT auth to check freeBusy and create events.
 */
import { google, calendar_v3 } from 'googleapis';
import type { EquipmentKey, BusySlot, Customer } from './types.js';
import { EQUIPMENT } from './pricing.js';

let calClient: calendar_v3.Calendar | null = null;

function getAuth(): InstanceType<typeof google.auth.JWT> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY');

  const key = JSON.parse(keyJson);
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function getCal(): calendar_v3.Calendar {
  if (!calClient) {
    calClient = google.calendar({ version: 'v3', auth: getAuth() });
  }
  return calClient;
}

/** Extract YYYY-MM-DD in America/Chicago timezone from a Date object. */
function toChicagoDate(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'America/Chicago' });
}

/** Offset of America/Chicago from UTC, in minutes, at the given instant (handles DST). */
function chicagoOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - at.getTime()) / 60000;
}

/**
 * Absolute instant of 00:00 America/Chicago on the given YYYY-MM-DD.
 * Querying freeBusy with UTC-midnight (`...T00:00:00Z`) boundaries clamps all-day
 * events to UTC midnight, which then mis-converts to the prior Chicago day and
 * silently under-blocks single-day rentals at checkout. Using the true Chicago
 * day boundary keeps availability and checkout in agreement.
 */
function chicagoDayStart(dateStr: string): Date {
  const utcMidnight = Date.parse(`${dateStr}T00:00:00Z`);
  const offMin = chicagoOffsetMinutes(new Date(utcMidnight));
  return new Date(utcMidnight - offMin * 60000);
}

function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// ── Free/Busy Check ─────────────────────────────────────────────────

const FREEBUSY_MAX_DAYS = 60;

export async function getBookedSlots(
  equipmentKey: EquipmentKey,
  startDate: string,
  endDate: string,
): Promise<BusySlot[]> {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);

  // Clamp end date so the query never exceeds FREEBUSY_MAX_DAYS
  const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
  const maxEndMs = startMs + FREEBUSY_MAX_DAYS * 86_400_000;
  const requestedEndMs = new Date(`${endDate}T23:59:59Z`).getTime();
  const clampedEndMs = Math.min(requestedEndMs, maxEndMs);
  const clampedEndDate = new Date(clampedEndMs).toISOString().split('T')[0];

  const cal = getCal();
  const res = await cal.freebusy.query({
    requestBody: {
      // Chicago-local day boundaries (not UTC) so all-day events aren't clamped
      // to UTC midnight and mis-dated by the timezone offset. End respects the
      // FREEBUSY_MAX_DAYS clamp above.
      timeMin: chicagoDayStart(startDate).toISOString(),
      timeMax: chicagoDayStart(addDaysStr(clampedEndDate, 1)).toISOString(),
      timeZone: 'America/Chicago',
      items: [{ id: equipment.calendarId }],
    },
  });

  const busy = res.data.calendars?.[equipment.calendarId]?.busy || [];
  return busy.map((slot) => ({
    start: slot.start || '',
    end: slot.end || '',
  }));
}

// ── Check if specific dates overlap with existing bookings ──────────

export async function datesAreAvailable(
  equipmentKey: EquipmentKey,
  dates: string[],
): Promise<boolean> {
  if (dates.length === 0) return false;

  const sorted = [...dates].sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];

  const busySlots = await getBookedSlots(equipmentKey, startDate, endDate);
  if (busySlots.length === 0) return true;

  // Convert busy slots to date sets for comparison (all-day events)
  // Must use America/Chicago timezone — the VPS timezone differs from the
  // business timezone, and .toISOString() returns UTC which shifts dates.
  const busyDates = new Set<string>();
  for (const slot of busySlots) {
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    const current = new Date(start);
    while (current < end) {
      busyDates.add(toChicagoDate(current));
      current.setTime(current.getTime() + 86_400_000);
    }
  }

  for (const date of dates) {
    if (busyDates.has(date)) return false;
  }

  return true;
}

// ── Delete Calendar Event ───────────────────────────────────────────

export async function deleteCalendarEvent(
  equipmentKey: EquipmentKey,
  eventId: string,
): Promise<void> {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);

  const cal = getCal();
  await cal.events.delete({
    calendarId: equipment.calendarId,
    eventId,
  });
}

// ── Create Booking Event ────────────────────────────────────────────

export async function createBookingEvent(
  equipmentKey: EquipmentKey,
  dates: string[],
  customer: Customer,
  pricing: { subtotal: number; deposit: number; balance: number; addOns: string[]; numDays?: number },
): Promise<string> {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);

  const sorted = [...dates].sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];

  // Add one day to end for all-day event range
  const endPlusOne = new Date(`${endDate}T00:00:00Z`);
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);
  const endDateStr = endPlusOne.toISOString().split('T')[0];

  const addOnText = pricing.addOns.length > 0
    ? `\nAdd-ons: ${pricing.addOns.join(', ')}`
    : '';

  // numDays = billed units (nights for RV, days otherwise). Fall back to
  // equipment-aware count for callers that don't pass it explicitly.
  const billedUnits = pricing.numDays
    ?? (equipmentKey === 'rv' ? Math.max(1, dates.length - 1) : Math.max(1, dates.length - 1));

  const cal = getCal();
  const res = await cal.events.insert({
    calendarId: equipment.calendarId,
    requestBody: {
      summary: `${equipment.label} Rental — ${customer.firstName} ${customer.lastName}`,
      description: [
        `Customer: ${customer.firstName} ${customer.lastName}`,
        `Email: ${customer.email}`,
        `Phone: ${customer.phone}`,
        `Equipment: ${equipment.label}`,
        `Duration: ${billedUnits} ${equipment.unit}${billedUnits > 1 ? 's' : ''}`,
        `Total: $${pricing.subtotal.toFixed(2)}`,
        `Deposit: $${pricing.deposit.toFixed(2)}`,
        `Balance due at pickup: $${pricing.balance.toFixed(2)}`,
        addOnText,
        `\nBooked via website`,
      ].filter(Boolean).join('\n'),
      location: 'Tomball, TX',
      start: { date: startDate },
      end: { date: endDateStr },
    },
  });

  return res.data.id || '';
}
