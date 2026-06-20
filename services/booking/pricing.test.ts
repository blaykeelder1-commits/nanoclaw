import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculatePrice, buildSquareLineItems, EQUIPMENT } from './pricing.js';
import { feeForMiles } from './geocode.js';

// ── Helper: generate dates relative to today ─────────────────────────

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── calculatePrice — basic pricing ───────────────────────────────────

describe('calculatePrice — basic', () => {
  it('calculates RV price for 3 nights (pricing-only — $250 equipment default)', () => {
    const result = calculatePrice('rv', 3);
    expect(result.subtotal).toBe(150 * 3);
    // Pricing uses the equipment default; the server layer enforces that RV must include
    // delivery (or an explicit promo override), so an un-configured RV never reaches Square.
    expect(result.deposit).toBe(250);
    expect(result.numDays).toBe(3);
    expect(result.equipment.key).toBe('rv');
  });

  it('calculates carhauler price for 2 days', () => {
    const result = calculatePrice('carhauler', 2);
    expect(result.subtotal).toBe(69 * 2);
    expect(result.deposit).toBe(50);
  });

  it('includes valid add-ons', () => {
    const result = calculatePrice('rv', 3, ['generator', 'delivery']);
    // Base: 150*3 = 450, Generator: 85*3 = 255, Delivery: 250 flat
    expect(result.subtotal).toBe(450 + 255 + 250);
    expect(result.addOns).toEqual(['generator', 'delivery']);
    expect(result.lineItems).toHaveLength(3);
  });

  it('ignores add-ons that do not apply to equipment', () => {
    // Generator only applies to RV
    const result = calculatePrice('carhauler', 2, ['generator']);
    expect(result.addOns).toEqual([]);
    expect(result.subtotal).toBe(69 * 2);
  });

  it('ignores unknown add-on keys', () => {
    const result = calculatePrice('rv', 1, ['nonexistent']);
    expect(result.addOns).toEqual([]);
  });

  it('prices fresh-water fill and waste-tank drop at $75 each (flat)', () => {
    const result = calculatePrice('rv', 3, ['freshwater', 'wastetank']);
    // Base: 150*3 = 450, freshwater: 75 flat, wastetank: 75 flat
    expect(result.subtotal).toBe(450 + 75 + 75);
    expect(result.addOns).toEqual(['freshwater', 'wastetank']);
  });

  it('drops tank services for a single-night RV stay', () => {
    const result = calculatePrice('rv', 1, ['freshwater', 'wastetank']);
    // Mid-stay tank services only apply to stays of 2+ nights.
    expect(result.addOns).toEqual([]);
    expect(result.subtotal).toBe(150 * 1);
  });

  it('includes tank services for a 2-night RV stay', () => {
    const result = calculatePrice('rv', 2, ['freshwater', 'wastetank']);
    expect(result.addOns).toEqual(['freshwater', 'wastetank']);
    expect(result.subtotal).toBe(150 * 2 + 75 + 75);
  });

  it('maps delivery distance to the right tier fee', () => {
    expect(feeForMiles(0)).toBe(250);
    expect(feeForMiles(60)).toBe(250);
    expect(feeForMiles(61)).toBe(300);
    expect(feeForMiles(90)).toBe(300);
    expect(feeForMiles(91)).toBe(340);
    expect(feeForMiles(120)).toBe(340);
    expect(feeForMiles(121)).toBe(375);
    expect(feeForMiles(150)).toBe(375);
    expect(feeForMiles(151)).toBeNull();
  });

  it('calculatePrice honors a delivery-fee override (distance tier)', () => {
    const r = calculatePrice('rv', 3, ['delivery'], { deliveryFee: 375 });
    const deliveryLine = r.lineItems.find((li) => li.name.includes('Delivery'));
    expect(deliveryLine?.total).toBe(375);
    expect(r.subtotal).toBe(150 * 3 + 375);
  });

  it('throws on unknown equipment', () => {
    expect(() => calculatePrice('jetski' as any, 1)).toThrow('Unknown equipment');
  });

  it('throws on zero days', () => {
    expect(() => calculatePrice('rv', 0)).toThrow('Must rent for at least 1 day');
  });
});

// ── calculatePrice — RV payment mode logic ───────────────────────────

describe('calculatePrice — RV payment mode', () => {
  it('same-week dates → paymentMode = full, chargeNow = subtotal + deposit', () => {
    const dates = [daysFromNow(2), daysFromNow(3), daysFromNow(4)];
    const result = calculatePrice('rv', 3, [], { dates });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
    expect(result.balance).toBe(0);
  });

  it('advance dates (>7 days out) → paymentMode = deposit, chargeNow = deposit only', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const result = calculatePrice('rv', 3, [], { dates });
    expect(result.paymentMode).toBe('deposit');
    expect(result.chargeNow).toBe(result.deposit);
    expect(result.balance).toBe(result.subtotal);
  });

  it('advance dates with paymentMode=full → paymentMode = full, chargeNow = subtotal + deposit', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const result = calculatePrice('rv', 3, [], { dates, paymentMode: 'full' });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
    expect(result.balance).toBe(0);
  });

  it('no dates provided → defaults to full', () => {
    const result = calculatePrice('rv', 3);
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
  });

  it('empty dates array → falls to deposit (isSameWeekBooking returns false for empty)', () => {
    // NOTE: This is a potential edge case / bug. When dates=[] is passed,
    // isSameWeekBooking returns false, so the code treats it as an advance booking.
    // In practice dates should never be empty when opts.dates is provided.
    const result = calculatePrice('rv', 3, [], { dates: [] });
    expect(result.paymentMode).toBe('deposit');
  });
});

// ── calculatePrice — Non-RV always full ──────────────────────────────

describe('calculatePrice — non-RV equipment', () => {
  it('carhauler with advance dates → always full', () => {
    const dates = [daysFromNow(14), daysFromNow(15)];
    const result = calculatePrice('carhauler', 2, [], { dates });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
    expect(result.balance).toBe(0);
  });

  it('landscaping trailer with advance dates → always full', () => {
    const dates = [daysFromNow(30)];
    const result = calculatePrice('landscaping', 1, [], { dates });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
  });

  it('carhauler with paymentMode deposit hint → still full (non-RV)', () => {
    const dates = [daysFromNow(14)];
    const result = calculatePrice('carhauler', 1, [], { dates, paymentMode: 'deposit' });
    // Non-RV ignores deposit hint; only opts.paymentMode === 'full' is a special case
    // The logic: paymentMode is not 'full', equipmentKey is not 'rv', so → 'full'
    expect(result.paymentMode).toBe('full');
  });
});

// ── buildSquareLineItems — full mode ─────────────────────────────────

describe('buildSquareLineItems — full mode', () => {
  it('returns all rental line items + deposit line item', () => {
    const pricing = calculatePrice('rv', 3, ['generator']);
    expect(pricing.paymentMode).toBe('full');

    const items = buildSquareLineItems(pricing).lineItems;
    // 2 rental items (base + generator) + 1 deposit = 3
    expect(items).toHaveLength(3);

    // Base rental line item
    expect(items[0].name).toContain('RV Camper');
    expect(items[0].quantity).toBe('3');
    expect(items[0].base_price_money.amount).toBe(150 * 100); // cents

    // Generator add-on
    expect(items[1].name).toContain('Generator');
    expect(items[1].quantity).toBe('3');
    expect(items[1].base_price_money.amount).toBe(85 * 100);

    // Deposit — equipment default $250 (server layer forces delivery add-on for real bookings)
    expect(items[2].name).toBe('Refundable Security Deposit');
    expect(items[2].quantity).toBe('1');
    expect(items[2].base_price_money.amount).toBe(250 * 100);
  });

  it('all amounts are in cents (USD)', () => {
    const pricing = calculatePrice('carhauler', 2);
    const items = buildSquareLineItems(pricing).lineItems;
    for (const item of items) {
      expect(item.base_price_money.currency).toBe('USD');
      expect(Number.isInteger(item.base_price_money.amount)).toBe(true);
    }
  });
});

// ── buildSquareLineItems — deposit mode ──────────────────────────────

describe('buildSquareLineItems — deposit mode', () => {
  it('returns single deposit line item with balance note', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const pricing = calculatePrice('rv', 3, [], { dates });
    expect(pricing.paymentMode).toBe('deposit');

    const items = buildSquareLineItems(pricing).lineItems;
    expect(items).toHaveLength(1);
    expect(items[0].name).toContain('Refundable Security Deposit');
    expect(items[0].name).toContain('balance');
    expect(items[0].quantity).toBe('1');
    // Equipment default $250 (server enforces delivery for real RV bookings)
    expect(items[0].base_price_money.amount).toBe(250 * 100);
  });

  it('deposit line item includes the balance amount in the name', () => {
    // Fixed far-future non-holiday dates: keeps it in advance/deposit mode and
    // deterministic (relative dates here previously drifted onto the July 4
    // holiday window and broke the hardcoded balance).
    const dates = ['2035-03-10', '2035-03-11', '2035-03-12'];
    const pricing = calculatePrice('rv', 3, [], { dates });
    const items = buildSquareLineItems(pricing).lineItems;
    // Balance = subtotal = 150*3 = 450
    expect(items[0].name).toContain('$450.00');
  });
});

// ── Integration: full booking flow simulation ────────────────────────

describe('Integration — booking flow', () => {
  it('RV with advance dates → deposit mode → correct line items', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const pricing = calculatePrice('rv', 3, ['delivery'], { dates });

    expect(pricing.paymentMode).toBe('deposit');
    expect(pricing.chargeNow).toBe(pricing.deposit); // $250
    expect(pricing.balance).toBe(pricing.subtotal);   // $450 + $250 delivery = $700

    const items = buildSquareLineItems(pricing).lineItems;
    expect(items).toHaveLength(1);
    expect(items[0].base_price_money.amount).toBe(250 * 100);
  });

  it('RV with same-week dates → full mode → all line items', () => {
    const dates = [daysFromNow(2), daysFromNow(3), daysFromNow(4)];
    const pricing = calculatePrice('rv', 3, ['delivery'], { dates });

    expect(pricing.paymentMode).toBe('full');
    expect(pricing.chargeNow).toBe(pricing.subtotal + pricing.deposit);
    expect(pricing.balance).toBe(0);

    const items = buildSquareLineItems(pricing).lineItems;
    // Base rental + delivery + deposit = 3
    expect(items).toHaveLength(3);
  });

  it('carhauler with advance dates → always full mode → all line items', () => {
    const dates = [daysFromNow(14), daysFromNow(15)];
    const pricing = calculatePrice('carhauler', 2, [], { dates });

    expect(pricing.paymentMode).toBe('full');
    expect(pricing.chargeNow).toBe(pricing.subtotal + pricing.deposit); // $138 + $50
    expect(pricing.balance).toBe(0);

    const items = buildSquareLineItems(pricing).lineItems;
    // Base rental + deposit = 2
    expect(items).toHaveLength(2);
    expect(items[0].name).toContain('Car Hauler');
    expect(items[1].name).toBe('Refundable Security Deposit');
  });

  it('RV full mode with add-ons → correct totals', () => {
    const dates = [daysFromNow(2), daysFromNow(3)];
    const pricing = calculatePrice('rv', 2, ['generator', 'delivery'], { dates });

    expect(pricing.paymentMode).toBe('full');
    // Base: 150*2=300, Generator: 85*2=170, Delivery: 250 flat
    expect(pricing.subtotal).toBe(300 + 170 + 250);
    expect(pricing.chargeNow).toBe(300 + 170 + 250 + 250); // subtotal + deposit
    expect(pricing.deposit).toBe(250);

    const items = buildSquareLineItems(pricing).lineItems;
    expect(items).toHaveLength(4); // base + generator + delivery + deposit
  });
});

// ── Holiday pricing (RV only) ────────────────────────────────────────

describe('calculatePrice — RV holiday pricing', () => {
  it('all-regular dates use base rate', () => {
    // Pick far-future non-holiday dates
    const dates = ['2035-03-10', '2035-03-11', '2035-03-12'];
    const pricing = calculatePrice('rv', 3, [], { dates, paymentMode: 'full' });
    expect(pricing.subtotal).toBe(150 * 3);
    expect(pricing.lineItems[0].unitPrice).toBe(150);
  });

  it('all-holiday dates use $175/night', () => {
    // July 4th weekend 2035 — 3 selected dates = 2 nights (drop-off date is not a night)
    const dates = ['2035-07-03', '2035-07-04', '2035-07-05'];
    const pricing = calculatePrice('rv', 2, [], { dates, paymentMode: 'full' });
    expect(pricing.subtotal).toBe(175 * 2);
    expect(pricing.lineItems[0].unitPrice).toBe(175);
    expect(pricing.lineItems[0].name).toContain('holiday');
  });

  it('mixed holiday + regular dates split into two line items', () => {
    // 4 dates = 3 nights. Jul 4, 5 are holiday-nights. Jul 6 is a regular night.
    // (Jul 7 is the drop-off morning, not a night.)
    const dates = ['2035-07-04', '2035-07-05', '2035-07-06', '2035-07-07'];
    const pricing = calculatePrice('rv', 3, [], { dates, paymentMode: 'full' });
    // 1 regular @ $150 + 2 holiday @ $175 = $500
    expect(pricing.subtotal).toBe(150 + 175 * 2);
    expect(pricing.lineItems).toHaveLength(2);
    expect(pricing.lineItems.some(li => li.unitPrice === 150)).toBe(true);
    expect(pricing.lineItems.some(li => li.unitPrice === 175)).toBe(true);
  });

  it('does not apply holiday pricing to carhauler', () => {
    const dates = ['2035-07-04', '2035-07-05'];
    const pricing = calculatePrice('carhauler', 2, [], { dates });
    expect(pricing.subtotal).toBe(69 * 2);
  });
});

// ── Promo code (RIVER) ───────────────────────────────────────────────

describe('calculatePrice — RIVER promo (10% off)', () => {
  it('takes 10% off the RV rental + add-ons subtotal; deposit & delivery unchanged', () => {
    const dates = ['2035-03-10', '2035-03-11']; // non-holiday
    const pricing = calculatePrice('rv', 2, ['delivery', 'generator'], {
      dates,
      paymentMode: 'full',
      promoCode: 'RIVER',
    });
    const gross = 150 * 2 + 85 * 2 + 250; // base + generator + delivery
    expect(pricing.subtotal).toBe(Math.round(gross * 0.9 * 100) / 100);
    expect(pricing.deposit).toBe(250);            // unchanged — deposit is never discounted
    expect(pricing.addOns).toContain('delivery'); // RIVER no longer removes delivery
    expect(pricing.addOns).toContain('generator');
    expect(pricing.discount?.amount).toBe(Math.round(gross * 0.1 * 100) / 100);
  });

  it('applies to the car hauler', () => {
    const dates = ['2035-03-10', '2035-03-11'];
    const pricing = calculatePrice('carhauler', 2, [], { dates, promoCode: 'RIVER' });
    const gross = 69 * 2;
    expect(pricing.subtotal).toBe(gross * 0.9);
    expect(pricing.deposit).toBe(50);
    expect(pricing.discount?.amount).toBe(gross * 0.1);
  });

  it('is case-insensitive', () => {
    const pricing = calculatePrice('carhauler', 1, [], { dates: ['2035-03-10'], promoCode: 'river' });
    expect(pricing.subtotal).toBe(69 * 0.9);
  });

  it('does NOT apply to the landscaping/utility trailer', () => {
    const pricing = calculatePrice('landscaping', 1, [], { dates: ['2035-03-10'], promoCode: 'RIVER' });
    expect(pricing.subtotal).toBe(50);
    expect(pricing.discount).toBeUndefined();
  });

  it('unknown promo code is silently ignored', () => {
    const pricing = calculatePrice('rv', 2, ['delivery'], {
      dates: ['2035-03-10', '2035-03-11'],
      paymentMode: 'full',
      promoCode: 'NOPE',
    });
    expect(pricing.discount).toBeUndefined();
    expect(pricing.deposit).toBe(250);
  });

  it('discount reaches Square as an ORDER-scope discount (no negative line items)', () => {
    const pricing = calculatePrice('carhauler', 2, [], {
      dates: ['2035-03-10', '2035-03-11'],
      promoCode: 'RIVER',
    });
    const { lineItems, discounts } = buildSquareLineItems(pricing);
    expect(discounts).toHaveLength(1);
    expect(discounts[0].scope).toBe('ORDER');
    expect(discounts[0].amount_money.amount).toBe(Math.round(69 * 2 * 0.1 * 100)); // cents
    expect(lineItems.every((li) => li.base_price_money.amount >= 0)).toBe(true);
  });
});

// ── Automatic longer-rental discount ─────────────────────────────────

describe('calculatePrice — longer-rental discount', () => {
  it('car hauler under 3 days gets no discount', () => {
    const pricing = calculatePrice('carhauler', 2);
    expect(pricing.subtotal).toBe(69 * 2);
    expect(pricing.discount).toBeUndefined();
  });

  it('car hauler 3–6 days gets 10% off (3+ day discount)', () => {
    const pricing = calculatePrice('carhauler', 3);
    expect(pricing.subtotal).toBeCloseTo(69 * 3 * 0.9, 2);
    expect(pricing.discount?.label).toContain('3+ day discount');
    expect(pricing.discount?.amount).toBeCloseTo(69 * 3 * 0.1, 2);
  });

  it('car hauler 7+ days gets 18% off (weekly rate)', () => {
    const pricing = calculatePrice('carhauler', 7);
    expect(pricing.subtotal).toBeCloseTo(69 * 7 * 0.82, 2);
    expect(pricing.discount?.label).toContain('Weekly rate');
    expect(pricing.discount?.amount).toBeCloseTo(69 * 7 * 0.18, 2);
  });

  it('utility/landscaping trailer 7+ days gets the 18% weekly rate', () => {
    const pricing = calculatePrice('landscaping', 7);
    expect(pricing.subtotal).toBeCloseTo(50 * 7 * 0.82, 2);
    expect(pricing.discount?.label).toContain('Weekly rate');
  });

  it('RV gets a smaller 10% break at 7+ nights, nothing below', () => {
    expect(calculatePrice('rv', 6).discount).toBeUndefined();
    const week = calculatePrice('rv', 7);
    expect(week.subtotal).toBeCloseTo(150 * 7 * 0.9, 2);
    expect(week.discount?.amount).toBeCloseTo(150 * 7 * 0.1, 2);
  });

  it('takes the BETTER of promo vs duration and never stacks them', () => {
    // 7-day car hauler + RIVER(10%): weekly 18% wins, applied once.
    const pricing = calculatePrice('carhauler', 7, [], {
      dates: ['2035-03-10', '2035-03-11', '2035-03-12', '2035-03-13', '2035-03-14', '2035-03-15', '2035-03-16'],
      promoCode: 'RIVER',
    });
    expect(pricing.subtotal).toBeCloseTo(69 * 7 * 0.82, 2);
    expect(pricing.discount?.label).toContain('Weekly rate');
  });
});
