#!/usr/bin/env npx tsx
/**
 * Epsilon-Greedy Variant Selector
 *
 * Selects an A/B test message variant for a given category using an
 * epsilon-greedy algorithm (epsilon = 0.2).
 *
 * - 80% exploit: pick highest conversion rate (times_converted / times_used)
 * - 20% explore: pick a random non-best variant
 * - Any variant with < 5 uses is always explored (forced initial data collection)
 *
 * Usage:
 *   npx tsx tools/learning/get-variant.ts --category greeting_new_lead
 *
 * Output: JSON to stdout
 */

import Database from 'better-sqlite3';
import path from 'path';

const STORE_DIR = path.resolve(process.env.STORE_DIR || 'store');
const db = new Database(path.join(STORE_DIR, 'messages.db'));

// ---------- Parse CLI args ----------

function parseArgs(): { category: string } {
  const args = process.argv.slice(2);
  const catIdx = args.indexOf('--category');
  if (catIdx === -1 || catIdx + 1 >= args.length) {
    console.error('Usage: npx tsx tools/learning/get-variant.ts --category <category>');
    process.exit(1);
  }
  return { category: args[catIdx + 1] };
}

const { category } = parseArgs();

// ---------- Fetch active variants ----------

interface VariantRow {
  id: string;
  category: string;
  variant_name: string;
  template: string;
  times_used: number;
  times_converted: number;
  times_replied: number;
}

const variants = db
  .prepare('SELECT id, category, variant_name, template, times_used, times_converted, times_replied FROM message_variants WHERE category = ? AND status = ?')
  .all(category, 'active') as VariantRow[];

if (variants.length === 0) {
  console.log(JSON.stringify({ variant_id: null }));
  db.close();
  process.exit(0);
}

// ---------- Epsilon-greedy selection ----------

const EPSILON = 0.2;
const MIN_USES_THRESHOLD = 5;

/** Check if any variant still needs forced exploration (< 5 uses) */
const underExplored = variants.filter((v) => v.times_used < MIN_USES_THRESHOLD);

/** Compute conversion rate for a variant */
function conversionRate(v: VariantRow): number {
  return v.times_used > 0 ? v.times_converted / v.times_used : 0;
}

/** Find the best variant by conversion rate, breaking ties by fewest uses */
function findBest(pool: VariantRow[]): VariantRow {
  return pool.reduce((best, curr) => {
    const bestRate = conversionRate(best);
    const currRate = conversionRate(curr);
    if (currRate > bestRate) return curr;
    if (currRate === bestRate && curr.times_used < best.times_used) return curr;
    return best;
  });
}

/** Pick a random element from an array */
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

let selected: VariantRow;
let selectionMethod: 'exploit' | 'explore';

if (underExplored.length > 0) {
  // Force exploration of under-sampled variants
  selected = pickRandom(underExplored);
  selectionMethod = 'explore';
} else {
  const best = findBest(variants);
  const roll = Math.random();

  if (roll < EPSILON && variants.length > 1) {
    // Explore: pick a random variant that isn't the current best
    const others = variants.filter((v) => v.id !== best.id);
    selected = pickRandom(others);
    selectionMethod = 'explore';
  } else {
    // Exploit: use the best performer
    selected = best;
    selectionMethod = 'exploit';
  }
}

// ---------- Output ----------

console.log(
  JSON.stringify(
    {
      variant_id: selected.id,
      variant_name: selected.variant_name,
      category: selected.category,
      template: selected.template,
      selection_method: selectionMethod,
    },
    null,
    2,
  ),
);

db.close();
