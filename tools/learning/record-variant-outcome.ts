#!/usr/bin/env npx tsx
/**
 * Record A/B Test Variant Outcome
 *
 * Records the result of using a message variant: increments times_used,
 * and optionally times_converted and times_replied.
 *
 * Usage:
 *   npx tsx tools/learning/record-variant-outcome.ts --variant-id greeting_new_lead-direct --converted --replied
 *   npx tsx tools/learning/record-variant-outcome.ts --variant-id follow_up_stale-check_in --replied
 *   npx tsx tools/learning/record-variant-outcome.ts --variant-id closing_booking-direct_ask
 *
 * Flags:
 *   --variant-id <id>   (required) The variant that was used
 *   --converted         (optional) The interaction led to a stage advancement
 *   --replied           (optional) The customer responded
 */

import Database from 'better-sqlite3';
import path from 'path';

const STORE_DIR = path.resolve(process.env.STORE_DIR || 'store');
const db = new Database(path.join(STORE_DIR, 'messages.db'));

// ---------- Parse CLI args ----------

function parseArgs(): { variantId: string; converted: boolean; replied: boolean } {
  const args = process.argv.slice(2);

  const idIdx = args.indexOf('--variant-id');
  if (idIdx === -1 || idIdx + 1 >= args.length) {
    console.error(
      'Usage: npx tsx tools/learning/record-variant-outcome.ts --variant-id <id> [--converted] [--replied]',
    );
    process.exit(1);
  }

  return {
    variantId: args[idIdx + 1],
    converted: args.includes('--converted'),
    replied: args.includes('--replied'),
  };
}

const { variantId, converted, replied } = parseArgs();

// ---------- Update the variant ----------

const now = new Date().toISOString();

const result = db
  .prepare(
    `UPDATE message_variants SET
      times_used = times_used + 1,
      times_converted = times_converted + ?,
      times_replied = times_replied + ?,
      updated_at = ?
    WHERE id = ?`,
  )
  .run(converted ? 1 : 0, replied ? 1 : 0, now, variantId);

if (result.changes === 0) {
  console.error(JSON.stringify({ status: 'error', error: `Variant not found: ${variantId}` }));
  db.close();
  process.exit(1);
}

// ---------- Print confirmation with current stats ----------

interface VariantStats {
  id: string;
  category: string;
  variant_name: string;
  times_used: number;
  times_converted: number;
  times_replied: number;
  avg_sentiment: number | null;
  status: string;
}

const variant = db
  .prepare(
    'SELECT id, category, variant_name, times_used, times_converted, times_replied, avg_sentiment, status FROM message_variants WHERE id = ?',
  )
  .get(variantId) as VariantStats;

const convRate =
  variant.times_used > 0
    ? ((variant.times_converted / variant.times_used) * 100).toFixed(1)
    : '0.0';
const replyRate =
  variant.times_used > 0
    ? ((variant.times_replied / variant.times_used) * 100).toFixed(1)
    : '0.0';

console.log(
  JSON.stringify(
    {
      status: 'recorded',
      variant_id: variant.id,
      category: variant.category,
      variant_name: variant.variant_name,
      outcome: {
        converted,
        replied,
      },
      current_stats: {
        times_used: variant.times_used,
        times_converted: variant.times_converted,
        times_replied: variant.times_replied,
        conversion_rate: `${convRate}%`,
        reply_rate: `${replyRate}%`,
        avg_sentiment: variant.avg_sentiment,
      },
    },
    null,
    2,
  ),
);

db.close();
