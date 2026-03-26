#!/usr/bin/env npx tsx
/**
 * Seed A/B Test Message Variants
 *
 * Seeds initial message variants into the message_variants table for
 * the nanoclaw adaptive learning system. Uses INSERT OR IGNORE so
 * re-running is safe and won't create duplicates.
 *
 * Usage:
 *   npx tsx tools/learning/seed-variants.ts
 */

import Database from 'better-sqlite3';
import path from 'path';

const STORE_DIR = path.resolve(process.env.STORE_DIR || 'store');
const db = new Database(path.join(STORE_DIR, 'messages.db'));

// Ensure the table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS message_variants (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    variant_name TEXT NOT NULL,
    template TEXT NOT NULL,
    times_used INTEGER NOT NULL DEFAULT 0,
    times_converted INTEGER NOT NULL DEFAULT 0,
    times_replied INTEGER NOT NULL DEFAULT 0,
    avg_sentiment REAL DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// ---------- Variant definitions ----------

interface VariantDef {
  category: string;
  variant_name: string;
  template: string;
}

const variants: VariantDef[] = [
  // --- greeting_new_lead ---
  {
    category: 'greeting_new_lead',
    variant_name: 'direct',
    template:
      'Get straight to the point. Acknowledge what they need, confirm you can help, ask one qualifying question.',
  },
  {
    category: 'greeting_new_lead',
    variant_name: 'question_first',
    template:
      'Open with a curious question about their situation before pitching. Show genuine interest in understanding their needs.',
  },
  {
    category: 'greeting_new_lead',
    variant_name: 'social_proof',
    template:
      "Mention relevant experience early ('We've got 50+ locations across Houston' or 'We just set up a machine at a warehouse like yours last week'). Then ask about their needs.",
  },

  // --- objection_cost ---
  {
    category: 'objection_cost',
    variant_name: 'lead_with_value',
    template:
      "Emphasize it's zero cost to them before discussing any details. 'Everything is completely free to your location — we handle installation, stocking, and maintenance.' Then answer their specific question.",
  },
  {
    category: 'objection_cost',
    variant_name: 'ask_needs_first',
    template:
      "Before answering cost questions, ask what specifically they're looking for. 'Great question — it depends on what setup makes sense for your space. How many people are on-site daily?' Then explain the no-cost model.",
  },
  {
    category: 'objection_cost',
    variant_name: 'comparison',
    template:
      "Frame cost in terms of what they'd spend otherwise. 'Most offices spend $200-500/month on snacks and coffee. With us, you get all of that at zero cost, and your team actually votes on what goes in the machine.'",
  },

  // --- follow_up_stale ---
  {
    category: 'follow_up_stale',
    variant_name: 'check_in',
    template:
      "Keep it simple and low-pressure. 'Hey [name], just checking in — still interested in getting set up? No rush, just wanted to make sure I didn't miss anything.'",
  },
  {
    category: 'follow_up_stale',
    variant_name: 'new_info',
    template:
      "Lead with something new or valuable. 'Hey [name], wanted to let you know we just added some new coffee options to our Vitro machines. Still thinking about getting one for the office?'",
  },
  {
    category: 'follow_up_stale',
    variant_name: 'light_touch',
    template:
      "Ultra-short, casual. 'Hey [name]! Still on your radar? \u{1F60A}' — max 1-2 sentences. Don't re-explain anything.",
  },

  // --- closing_booking ---
  {
    category: 'closing_booking',
    variant_name: 'direct_ask',
    template:
      "Ask directly for the booking. 'Want me to set up a quick 15-minute call for this week? I can walk you through exactly how it works.' Be confident, not pushy.",
  },
  {
    category: 'closing_booking',
    variant_name: 'suggest_next_step',
    template:
      "Suggest the natural next step without being salesy. 'The next step would be a quick site visit — takes about 15 minutes and there's zero commitment. What day works best?' Frame it as the logical progression.",
  },
  {
    category: 'closing_booking',
    variant_name: 'assumptive',
    template:
      "Assume the sale and offer specific times. 'I've got openings Tuesday at 2pm or Thursday at 10am — which works better for you?' Only use after the lead is clearly qualified and interested.",
  },
];

// ---------- Seed ----------

const now = new Date().toISOString();

const insert = db.prepare(`
  INSERT OR IGNORE INTO message_variants
    (id, category, variant_name, template, times_used, times_converted, times_replied, avg_sentiment, status, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, 0, 0, 0, NULL, 'active', ?, ?)
`);

let inserted = 0;
let skipped = 0;

const insertMany = db.transaction(() => {
  for (const v of variants) {
    const id = `${v.category}-${v.variant_name}`;
    const result = insert.run(id, v.category, v.variant_name, v.template, now, now);
    if (result.changes > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }
});

insertMany();

// ---------- Summary ----------

const categories = [...new Set(variants.map((v) => v.category))];
const counts = db
  .prepare('SELECT category, COUNT(*) as cnt FROM message_variants GROUP BY category')
  .all() as { category: string; cnt: number }[];

console.log('=== A/B Variant Seeding Complete ===');
console.log(`  Inserted: ${inserted}`);
console.log(`  Skipped (already exist): ${skipped}`);
console.log(`  Total variants defined: ${variants.length}`);
console.log('');
console.log('Variants per category:');
for (const row of counts) {
  console.log(`  ${row.category}: ${row.cnt}`);
}

db.close();
