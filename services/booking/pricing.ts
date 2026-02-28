import type { EquipmentKey, EquipmentConfig, AddOn, LineItem, PriceBreakdown } from './types.js';

// ── Equipment Configuration ─────────────────────────────────────────
// Source of truth: groups/sheridan-rentals/pricing.md + inventory.md

export const EQUIPMENT: Record<EquipmentKey, EquipmentConfig> = {
  rv: {
    key: 'rv',
    label: 'RV Camper',
    rate: 150,
    unit: 'night',
    deposit: 250,
    calendarId: 'c_7ba6d46497500abce720f92671ef92bb8bbdd79e741f71d41c01084e6bb0d69c@group.calendar.google.com',
  },
  carhauler: {
    key: 'carhauler',
    label: 'Car Hauler',
    rate: 65,
    unit: 'day',
    deposit: 50,
    calendarId: 'c_f92948a07076df3480b68fcaac0dd44cfc815ca9265999f709254dfca5fc64ad@group.calendar.google.com',
  },
  landscaping: {
    key: 'landscaping',
    label: 'Landscaping Trailer',
    rate: 50,
    unit: 'day',
    deposit: 50,
    calendarId: 'c_684ca11a465fb336458c8d7dfadc9ec83265bce3b8657712d2fa10ea32cc627e@group.calendar.google.com',
  },
};

export const ADD_ONS: Record<string, AddOn> = {
  generator: {
    key: 'generator',
    label: 'Generator',
    rate: 100,
    unit: 'night',
    appliesTo: ['rv'],
  },
  delivery: {
    key: 'delivery',
    label: 'Delivery (within 60mi of Tomball)',
    rate: 250,
    unit: 'flat',
    appliesTo: ['rv'],
  },
};

// ── Price Calculation ───────────────────────────────────────────────

export function calculatePrice(
  equipmentKey: EquipmentKey,
  numDays: number,
  addOnKeys: string[] = [],
): PriceBreakdown {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);
  if (numDays < 1) throw new Error('Must rent for at least 1 day');

  const lineItems: LineItem[] = [];

  // Base rental
  lineItems.push({
    name: `${equipment.label} — ${numDays} ${equipment.unit}${numDays > 1 ? 's' : ''}`,
    quantity: numDays,
    unitPrice: equipment.rate,
    total: equipment.rate * numDays,
  });

  // Add-ons
  const validAddOns: string[] = [];
  for (const key of addOnKeys) {
    const addOn = ADD_ONS[key];
    if (!addOn) continue;
    if (!addOn.appliesTo.includes(equipmentKey)) continue;

    validAddOns.push(key);

    if (addOn.unit === 'flat') {
      lineItems.push({
        name: addOn.label,
        quantity: 1,
        unitPrice: addOn.rate,
        total: addOn.rate,
      });
    } else {
      lineItems.push({
        name: `${addOn.label} — ${numDays} ${addOn.unit}${numDays > 1 ? 's' : ''}`,
        quantity: numDays,
        unitPrice: addOn.rate,
        total: addOn.rate * numDays,
      });
    }
  }

  const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
  const deposit = equipment.deposit;
  const balance = Math.max(0, subtotal - deposit);

  return {
    equipment,
    numDays,
    lineItems,
    subtotal,
    deposit,
    balance,
    addOns: validAddOns,
  };
}

// ── Square Line Items Builder ───────────────────────────────────────

export function buildSquareLineItems(pricing: PriceBreakdown): Array<{
  name: string;
  quantity: string;
  base_price_money: { amount: number; currency: string };
}> {
  // Send all line items to Square — full amount charged upfront
  return pricing.lineItems.map((item) => ({
    name: item.name,
    quantity: item.quantity.toString(),
    base_price_money: {
      amount: Math.round(item.unitPrice * 100), // cents
      currency: 'USD',
    },
  }));
}
