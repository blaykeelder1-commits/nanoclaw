#!/usr/bin/env npx tsx
/**
 * Revenue Intelligence — Location Performance Analyzer
 *
 * Cross-references CRM deals with vending sales data to produce
 * per-location performance reports.
 *
 * Usage:
 *   npx tsx tools/lifecycle/revenue-intelligence.ts --all-groups
 *   npx tsx tools/lifecycle/revenue-intelligence.ts --group snak-group
 *   npx tsx tools/lifecycle/revenue-intelligence.ts --group sheridan-rentals
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import { resolveGroupDir } from '../shared/group-path.js';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocationEntry {
  company: string;
  contact: string;
  deal_value_cents: number;
  days_active: number;
  status: 'healthy' | 'declining' | 'new';
  last_interaction: string | null;
  complaints: number;
}

interface ChannelStats {
  deals_won: number;
  avg_value: number;
  avg_days_to_close: number;
}

interface PerformanceReport {
  generated_at: string;
  locations: LocationEntry[];
  summary: {
    total_locations: number;
    total_pipeline_value_cents: number;
    projected_monthly_revenue_usd: number;
    avg_deal_value_cents: number;
    top_channel: string | null;
    cost_per_acquisition_usd: number | null;
  };
  channel_performance: Record<string, ChannelStats>;
}

interface DealRow {
  id: string;
  contact_id: string;
  group_folder: string;
  stage: string;
  value_cents: number | null;
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  first_name: string;
  last_name: string;
  company: string | null;
}

interface OutreachCountRow {
  contact_id: string;
  interaction_count: number;
}

interface ComplaintCountRow {
  customer_name: string;
  complaint_count: number;
}

interface StageLogRow {
  deal_id: string;
  changed_at: string;
}

interface UsageCostRow {
  group_folder: string;
  total_input: number;
  total_output: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function daysBetween(from: string, to: Date): number {
  const diff = to.getTime() - new Date(from).getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

/** Rough cost estimate: $3 / 1M input tokens, $15 / 1M output tokens (Claude Sonnet pricing). */
function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
}

function determineStatus(
  daysActive: number,
  prevEntry: LocationEntry | undefined,
): 'healthy' | 'declining' | 'new' {
  if (daysActive <= 30) return 'new';
  if (prevEntry && prevEntry.status === 'healthy' && prevEntry.complaints > 0) return 'declining';
  if (prevEntry && prevEntry.status === 'declining') return 'declining';
  return 'healthy';
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function analyzeGroup(db: Database.Database, groupFolder: string, now: Date): PerformanceReport {
  // 1. All closed_won deals for this group, joined with contacts
  const closedDeals = db.prepare(`
    SELECT d.*, c.first_name, c.last_name, c.company
    FROM deals d
    LEFT JOIN contacts c ON d.contact_id = c.id
    WHERE d.group_folder = ? AND d.stage = 'closed_won'
    ORDER BY d.closed_at DESC
  `).all(groupFolder) as DealRow[];

  // 2. All active (non-closed) deals for pipeline value
  const activeDeals = db.prepare(`
    SELECT d.*, c.first_name, c.last_name, c.company
    FROM deals d
    LEFT JOIN contacts c ON d.contact_id = c.id
    WHERE d.group_folder = ? AND d.stage NOT IN ('closed_won', 'closed_lost')
    ORDER BY d.updated_at DESC
  `).all(groupFolder) as DealRow[];

  // 3. Outreach interaction counts per contact
  const outreachCounts = db.prepare(`
    SELECT contact_id, COUNT(*) as interaction_count
    FROM outreach_log
    GROUP BY contact_id
  `).all() as OutreachCountRow[];
  const interactionMap = new Map(outreachCounts.map(r => [r.contact_id, r.interaction_count]));

  // 4. Complaint counts by customer_name (best-effort match to contact)
  const complaintCounts = db.prepare(`
    SELECT customer_name, COUNT(*) as complaint_count
    FROM complaints
    WHERE customer_name IS NOT NULL
    GROUP BY customer_name
  `).all() as ComplaintCountRow[];
  const complaintMap = new Map<string, number>();
  for (const row of complaintCounts) {
    if (row.customer_name) {
      complaintMap.set(row.customer_name.toLowerCase(), row.complaint_count);
    }
  }

  // 5. Latest interaction date per contact from outreach_log
  const lastInteractions = db.prepare(`
    SELECT contact_id, MAX(sent_at) as last_sent
    FROM outreach_log
    GROUP BY contact_id
  `).all() as Array<{ contact_id: string; last_sent: string }>;
  const lastInteractionMap = new Map(lastInteractions.map(r => [r.contact_id, r.last_sent]));

  // 6. Load previous report for trend detection
  const reportDir = resolveGroupDir(groupFolder);
  const reportPath = path.join(reportDir, 'location-performance.json');

  let previousLocations: LocationEntry[] = [];
  if (fs.existsSync(reportPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as PerformanceReport;
      previousLocations = prev.locations || [];
    } catch {
      // Corrupted previous file — start fresh
    }
  }
  const prevMap = new Map(previousLocations.map(l => [l.company?.toLowerCase() ?? '', l]));

  // 7. Build location entries from closed deals
  const locationsByCompany = new Map<string, LocationEntry>();

  for (const deal of closedDeals) {
    const companyName = deal.company || `${deal.first_name} ${deal.last_name}`.trim() || 'Unknown';
    const contactName = `${deal.first_name || ''} ${deal.last_name || ''}`.trim() || 'Unknown';
    const daysActive = deal.closed_at ? daysBetween(deal.closed_at, now) : 0;
    const key = companyName.toLowerCase();

    const complaintCount =
      complaintMap.get(key) ||
      complaintMap.get(contactName.toLowerCase()) ||
      0;

    const prevEntry = prevMap.get(key);
    const status = determineStatus(daysActive, prevEntry);

    const existing = locationsByCompany.get(key);
    if (existing) {
      // Aggregate: sum value, take max days, sum complaints
      existing.deal_value_cents += deal.value_cents || 0;
      existing.days_active = Math.max(existing.days_active, daysActive);
      existing.complaints = Math.max(existing.complaints, complaintCount);
    } else {
      locationsByCompany.set(key, {
        company: companyName,
        contact: contactName,
        deal_value_cents: deal.value_cents || 0,
        days_active: daysActive,
        status,
        last_interaction: lastInteractionMap.get(deal.contact_id) || null,
        complaints: complaintCount,
      });
    }
  }

  // Also include active deals as locations with status based on stage
  for (const deal of activeDeals) {
    const companyName = deal.company || `${deal.first_name} ${deal.last_name}`.trim() || 'Unknown';
    const contactName = `${deal.first_name || ''} ${deal.last_name || ''}`.trim() || 'Unknown';
    const key = companyName.toLowerCase();

    if (!locationsByCompany.has(key)) {
      const daysActive = daysBetween(deal.created_at, now);
      const complaintCount =
        complaintMap.get(key) ||
        complaintMap.get(contactName.toLowerCase()) ||
        0;

      locationsByCompany.set(key, {
        company: companyName,
        contact: contactName,
        deal_value_cents: deal.value_cents || 0,
        days_active: daysActive,
        status: daysActive <= 30 ? 'new' : 'healthy',
        last_interaction: lastInteractionMap.get(deal.contact_id) || null,
        complaints: complaintCount,
      });
    }
  }

  const locations = Array.from(locationsByCompany.values());

  // 8. Channel performance from closed_won deals
  const channelPerformance: Record<string, ChannelStats> = {};
  const allDeals = db.prepare(`
    SELECT d.id, d.source, d.value_cents, d.created_at, d.closed_at
    FROM deals d
    WHERE d.group_folder = ? AND d.stage = 'closed_won' AND d.source IS NOT NULL
  `).all(groupFolder) as Array<{
    id: string;
    source: string;
    value_cents: number | null;
    created_at: string;
    closed_at: string | null;
  }>;

  const channelBuckets = new Map<string, Array<{ value: number; daysToClose: number }>>();
  for (const d of allDeals) {
    const ch = d.source;
    if (!ch) continue;
    const bucket = channelBuckets.get(ch) || [];
    const daysToClose = d.closed_at ? daysBetween(d.created_at, new Date(d.closed_at)) : 0;
    bucket.push({ value: d.value_cents || 0, daysToClose });
    channelBuckets.set(ch, bucket);
  }

  let topChannel: string | null = null;
  let topChannelWins = 0;

  for (const [channel, entries] of channelBuckets) {
    const totalValue = entries.reduce((s, e) => s + e.value, 0);
    const totalDays = entries.reduce((s, e) => s + e.daysToClose, 0);
    channelPerformance[channel] = {
      deals_won: entries.length,
      avg_value: Math.round(totalValue / entries.length),
      avg_days_to_close: Math.round(totalDays / entries.length),
    };
    if (entries.length > topChannelWins) {
      topChannelWins = entries.length;
      topChannel = channel;
    }
  }

  // 9. Pipeline value (active deals)
  const totalPipelineValueCents = activeDeals.reduce((s, d) => s + (d.value_cents || 0), 0);

  // 10. Historical close rate for projection
  const allTimeDeals = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN stage = 'closed_won' THEN 1 ELSE 0 END) as won
    FROM deals WHERE group_folder = ?
  `).get(groupFolder) as { total: number; won: number };

  const closeRate = allTimeDeals.total > 0 ? allTimeDeals.won / allTimeDeals.total : 0;

  // Deals created in last 30 days to estimate monthly velocity
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentDeals = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(value_cents), 0) as total_value
    FROM deals WHERE group_folder = ? AND created_at >= ?
  `).get(groupFolder, thirtyDaysAgo) as { count: number; total_value: number };

  const projectedMonthlyRevenueCents = Math.round(recentDeals.total_value * closeRate);
  const projectedMonthlyRevenueUsd = projectedMonthlyRevenueCents / 100;

  // 11. Cost per acquisition from usage_log
  const usageCost = db.prepare(`
    SELECT group_folder,
           COALESCE(SUM(input_tokens), 0) as total_input,
           COALESCE(SUM(output_tokens), 0) as total_output
    FROM usage_log
    WHERE group_folder = ?
  `).get(groupFolder) as UsageCostRow | undefined;

  let costPerAcquisitionUsd: number | null = null;
  if (usageCost && allTimeDeals.won > 0) {
    const totalCost = estimateCostUsd(usageCost.total_input, usageCost.total_output);
    costPerAcquisitionUsd = Math.round((totalCost / allTimeDeals.won) * 100) / 100;
  }

  // 12. Summary
  const closedValues = closedDeals.map(d => d.value_cents || 0);
  const avgDealValueCents = closedValues.length > 0
    ? Math.round(closedValues.reduce((a, b) => a + b, 0) / closedValues.length)
    : 0;

  const report: PerformanceReport = {
    generated_at: now.toISOString(),
    locations,
    summary: {
      total_locations: locations.length,
      total_pipeline_value_cents: totalPipelineValueCents,
      projected_monthly_revenue_usd: projectedMonthlyRevenueUsd,
      avg_deal_value_cents: avgDealValueCents,
      top_channel: topChannel,
      cost_per_acquisition_usd: costPerAcquisitionUsd,
    },
    channel_performance: channelPerformance,
  };

  return report;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeReport(report: PerformanceReport, groupFolder: string): string {
  const reportDir = resolveGroupDir(groupFolder);

  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const reportPath = path.join(reportDir, 'location-performance.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

function printSummary(report: PerformanceReport, groupFolder: string): void {
  const s = report.summary;
  const lines: string[] = [
    '',
    `=== Revenue Intelligence: ${groupFolder} ===`,
    `Generated: ${report.generated_at}`,
    '',
    `Locations: ${s.total_locations}`,
    `Pipeline value: $${(s.total_pipeline_value_cents / 100).toFixed(2)}`,
    `Projected monthly revenue: $${s.projected_monthly_revenue_usd.toFixed(2)}`,
    `Avg deal value: $${(s.avg_deal_value_cents / 100).toFixed(2)}`,
    `Top channel: ${s.top_channel || 'N/A'}`,
    `Cost per acquisition: ${s.cost_per_acquisition_usd != null ? '$' + s.cost_per_acquisition_usd.toFixed(2) : 'N/A'}`,
  ];

  // Top 5
  const sorted = [...report.locations].sort((a, b) => b.deal_value_cents - a.deal_value_cents);
  if (sorted.length > 0) {
    lines.push('', '--- Top 5 Locations ---');
    for (const loc of sorted.slice(0, 5)) {
      lines.push(`  ${loc.company}: $${(loc.deal_value_cents / 100).toFixed(2)} (${loc.status}, ${loc.days_active}d)`);
    }
  }

  // Bottom 5 / declining
  const declining = report.locations.filter(l => l.status === 'declining');
  const bottom = sorted.length > 5
    ? sorted.slice(-5).reverse()
    : [];

  if (declining.length > 0) {
    lines.push('', '--- Declining Locations ---');
    for (const loc of declining.slice(0, 5)) {
      lines.push(`  ${loc.company}: $${(loc.deal_value_cents / 100).toFixed(2)} (${loc.complaints} complaints)`);
    }
  } else if (bottom.length > 0) {
    lines.push('', '--- Bottom 5 Locations ---');
    for (const loc of bottom) {
      lines.push(`  ${loc.company}: $${(loc.deal_value_cents / 100).toFixed(2)} (${loc.status}, ${loc.days_active}d)`);
    }
  }

  // Channel performance
  const channels = Object.entries(report.channel_performance);
  if (channels.length > 0) {
    lines.push('', '--- Channel Performance ---');
    for (const [ch, stats] of channels) {
      lines.push(`  ${ch}: ${stats.deals_won} won, avg $${(stats.avg_value / 100).toFixed(2)}, ~${stats.avg_days_to_close}d to close`);
    }
  }

  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const allGroups = hasFlag(args, '--all-groups');
  const singleGroup = parseFlag(args, '--group');

  if (!allGroups && !singleGroup) {
    console.error('Usage:');
    console.error('  npx tsx tools/lifecycle/revenue-intelligence.ts --all-groups');
    console.error('  npx tsx tools/lifecycle/revenue-intelligence.ts --group <folder>');
    process.exit(1);
  }

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error('Database not found. Run NanoClaw first.');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const now = new Date();

  let groups: string[];

  if (allGroups) {
    // Discover groups that have deals
    const rows = db.prepare(
      'SELECT DISTINCT group_folder FROM deals ORDER BY group_folder',
    ).all() as Array<{ group_folder: string }>;
    groups = rows.map(r => r.group_folder);

    if (groups.length === 0) {
      console.log('No deals found in any group.');
      db.close();
      return;
    }
  } else {
    groups = [singleGroup!];
  }

  for (const group of groups) {
    try {
      const report = analyzeGroup(db, group, now);
      const outPath = writeReport(report, group);
      printSummary(report, group);
      console.log(`\nReport written: ${outPath}`);
    } catch (err) {
      console.error(`Error analyzing ${group}: ${(err as Error).message}`);
    }
  }

  db.close();
}

main();
