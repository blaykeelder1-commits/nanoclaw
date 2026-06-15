/**
 * RV delivery distance + tiered drop-off fee.
 *
 * The camper is delivered from the Tomball lot. The drop-off fee scales with the
 * straight-line ("geographic") distance to the customer's address:
 *
 *   ≤ 60 mi  → $250 (standard)
 *   ≤ 90 mi  → $300
 *   ≤ 120 mi → $340
 *   ≤ 150 mi → $375
 *   > 150 mi → out of delivery area
 *
 * Distance is derived by geocoding both addresses with the Google Geocoding API
 * (GOOGLE_MAPS_API_KEY) and applying the haversine formula. If geocoding is
 * unavailable (key missing, API not enabled, transient error, or an address that
 * can't be resolved) we DEGRADE GRACEFULLY: the booking proceeds at the standard
 * $250 fee rather than blocking the sale. Only a successfully-computed distance
 * over 150 miles is rejected as out of area.
 */

const ORIGIN_ADDRESS = '14235 Alice Road, Tomball, TX 77377';
export const STANDARD_DELIVERY_FEE = 250;
export const MAX_DELIVERY_MILES = 150;

const DELIVERY_TIERS: Array<{ maxMiles: number; fee: number }> = [
  { maxMiles: 60, fee: 250 },
  { maxMiles: 90, fee: 300 },
  { maxMiles: 120, fee: 340 },
  { maxMiles: 150, fee: 375 },
];

/** Tier fee for a distance, or null if beyond the delivery area. */
export function feeForMiles(miles: number): number | null {
  for (const tier of DELIVERY_TIERS) {
    if (miles <= tier.maxMiles) return tier.fee;
  }
  return null;
}

interface LatLng { lat: number; lng: number; }

function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(address: string): Promise<LatLng | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  try {
    const data = await fetchJson(url);
    if (data?.status !== 'OK' || !data.results?.[0]?.geometry?.location) {
      if (data?.status && data.status !== 'ZERO_RESULTS') {
        console.error('[geocode] Google Geocoding API status:', data.status, data.error_message || '');
      }
      return null;
    }
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err: any) {
    console.error('[geocode] request failed:', err?.message || err);
    return null;
  }
}

// The origin never changes — geocode it once and reuse.
let originCache: LatLng | null = null;

export type DeliveryQuoteStatus = 'ok' | 'out_of_range' | 'unknown';

export interface DeliveryQuote {
  /** 'ok' = distance resolved & in range; 'out_of_range' = resolved & > 150 mi; 'unknown' = couldn't resolve. */
  status: DeliveryQuoteStatus;
  /** Rounded straight-line miles when resolved. */
  miles?: number;
  /** Chargeable fee: tier fee when 'ok', standard $250 when 'unknown'. Null when 'out_of_range'. */
  fee: number | null;
}

/**
 * Resolve the delivery fee for an address. Never throws — falls back to a
 * standard-fee 'unknown' result so a geocoding outage can't block bookings.
 */
export async function quoteDelivery(address: string): Promise<DeliveryQuote> {
  if (!address || !address.trim()) {
    return { status: 'unknown', fee: STANDARD_DELIVERY_FEE };
  }
  try {
    if (!originCache) originCache = await geocode(ORIGIN_ADDRESS);
    const dest = await geocode(address);
    if (!originCache || !dest) {
      return { status: 'unknown', fee: STANDARD_DELIVERY_FEE };
    }
    const miles = haversineMiles(originCache, dest);
    const fee = feeForMiles(miles);
    if (fee === null) {
      return { status: 'out_of_range', miles: Math.round(miles), fee: null };
    }
    return { status: 'ok', miles: Math.round(miles), fee };
  } catch (err: any) {
    console.error('[geocode] quoteDelivery failed:', err?.message || err);
    return { status: 'unknown', fee: STANDARD_DELIVERY_FEE };
  }
}
