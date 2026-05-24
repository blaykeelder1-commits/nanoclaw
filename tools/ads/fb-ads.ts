#!/usr/bin/env npx tsx
/**
 * Facebook Ads READ-ONLY reporting tool.
 *
 * Andy reads ad spend, results, CPA, and ROAS — then surfaces a summary to
 * Blayke on WhatsApp so he can authorize budget shifts. Andy NEVER spends
 * money autonomously; all create/pause/budget-change actions are escalated.
 *
 * Usage:
 *   npx tsx tools/ads/fb-ads.ts accounts
 *   npx tsx tools/ads/fb-ads.ts campaigns [--account-id act_XXX] [--status ACTIVE]
 *   npx tsx tools/ads/fb-ads.ts performance [--account-id act_XXX] [--days 7]
 *   npx tsx tools/ads/fb-ads.ts pixel-events [--pixel-id XXX] [--days 7]
 *   npx tsx tools/ads/fb-ads.ts weekly-summary [--account-id act_XXX]
 *
 * Environment:
 *   FB_ADS_ACCESS_TOKEN  — user token with ads_read + ads_management scope
 *   FB_AD_ACCOUNT_ID     — default ad account id (e.g. act_758151434528302)
 *   FB_PIXEL_ID          — default pixel id (e.g. 2183188872424658)
 *
 * Token scopes:
 *   ads_read           — pull spend, results, CPA
 *   ads_management     — also OK for read; required to pause/budget-change (not used here)
 *   business_management — list ad accounts
 */
const GRAPH = 'https://graph.facebook.com/v18.0';

type Args = Record<string, string>;
function parseArgs(): { action: string; args: Args } {
  const argv = process.argv.slice(2);
  const action = argv[0] || '';
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) args[argv[i].slice(2)] = argv[++i];
  }
  return { action, args };
}

function env() {
  const token = process.env.FB_ADS_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error(JSON.stringify({ status: 'error', error: 'FB_ADS_ACCESS_TOKEN (or FB_PAGE_ACCESS_TOKEN) required' }));
    process.exit(1);
  }
  return {
    token,
    defaultAccount: process.env.FB_AD_ACCOUNT_ID || '',
    defaultPixel: process.env.FB_PIXEL_ID || '',
  };
}

async function graph<T = unknown>(path: string): Promise<T> {
  const resp = await fetch(`${GRAPH}${path}`);
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) throw new Error(`Graph GET ${path}: ${resp.status} — ${text.slice(0, 300)}`);
  return data as T;
}

async function listAccounts(): Promise<void> {
  const { token } = env();
  const r = await graph(`/me/adaccounts?fields=id,name,account_status,currency,balance,amount_spent&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', accounts: r }));
}

async function listCampaigns(args: Args): Promise<void> {
  const { token, defaultAccount } = env();
  const accountId = args['account-id'] || defaultAccount;
  if (!accountId) throw new Error('No account-id; set FB_AD_ACCOUNT_ID or pass --account-id');
  const statusFilter = args['status'] ? `&filtering=[{"field":"effective_status","operator":"IN","value":["${args['status']}"]}]` : '';
  const r = await graph(`/${accountId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time${statusFilter}&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', campaigns: r }));
}

async function performance(args: Args): Promise<void> {
  const { token, defaultAccount } = env();
  const accountId = args['account-id'] || defaultAccount;
  const days = parseInt(args['days'] || '7', 10);
  const datePreset = days <= 7 ? 'last_7d' : days <= 14 ? 'last_14d' : days <= 30 ? 'last_30d' : 'last_90d';
  const fields = [
    'campaign_name','adset_name','impressions','reach','clicks','ctr','cpc','cpm',
    'spend','actions','action_values','conversions','cost_per_conversion',
    'cost_per_action_type','website_purchase_roas','purchase_roas','date_start','date_stop',
  ].join(',');
  const r = await graph(`/${accountId}/insights?level=campaign&date_preset=${datePreset}&fields=${fields}&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', date_preset: datePreset, insights: r }));
}

async function pixelEvents(args: Args): Promise<void> {
  const { token, defaultPixel } = env();
  const pixelId = args['pixel-id'] || defaultPixel;
  if (!pixelId) throw new Error('No pixel-id; set FB_PIXEL_ID or pass --pixel-id');
  // Available endpoints: /v18.0/{pixel-id}/stats (aggregate counts by event type)
  const r = await graph(`/${pixelId}/stats?aggregation=event&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', stats: r }));
}

interface CampaignInsight {
  campaign_name?: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  ctr?: string;
  cpc?: string;
  actions?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  purchase_roas?: Array<{ action_type: string; value: string }>;
}

async function weeklySummary(args: Args): Promise<void> {
  const { token, defaultAccount, defaultPixel } = env();
  const accountId = args['account-id'] || defaultAccount;
  if (!accountId) throw new Error('No account-id; set FB_AD_ACCOUNT_ID or pass --account-id');
  const fields = ['campaign_name','impressions','clicks','spend','ctr','cpc','actions','cost_per_action_type','purchase_roas'].join(',');
  const insights = (await graph(`/${accountId}/insights?level=campaign&date_preset=last_7d&fields=${fields}&access_token=${token}`)) as { data?: CampaignInsight[] };
  const rows = insights.data || [];
  let totalSpend = 0, totalClicks = 0, totalImpr = 0;
  const campaignLines: string[] = [];
  for (const r of rows) {
    const spend = parseFloat(r.spend || '0');
    const clicks = parseInt(r.clicks || '0', 10);
    const impr = parseInt(r.impressions || '0', 10);
    totalSpend += spend; totalClicks += clicks; totalImpr += impr;
    const leads = (r.actions || []).find(a => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped')?.value || '0';
    const messages = (r.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || '0';
    const purchases = (r.actions || []).find(a => /purchase/i.test(a.action_type))?.value || '0';
    const cpl = (r.cost_per_action_type || []).find(a => /lead|messaging/.test(a.action_type))?.value;
    const roas = (r.purchase_roas || [])[0]?.value;
    campaignLines.push(`• ${r.campaign_name}: $${spend.toFixed(2)} spend, ${clicks} clicks, CTR ${r.ctr || '0'}%, ${messages} msgs, ${leads} leads, ${purchases} purchases${roas ? `, ROAS ${roas}` : ''}${cpl ? `, CPL $${parseFloat(cpl).toFixed(2)}` : ''}`);
  }
  const summary = [
    `*FB Ads — Last 7 Days*`,
    ``,
    `Spend: $${totalSpend.toFixed(2)} | Impressions: ${totalImpr.toLocaleString()} | Clicks: ${totalClicks} | Avg CTR: ${totalImpr > 0 ? ((totalClicks / totalImpr) * 100).toFixed(2) : '0.00'}%`,
    ``,
    `*Campaigns:*`,
    ...campaignLines,
  ].join('\n');
  console.log(JSON.stringify({ status: 'success', summary, raw_insights: rows, pixel_id: defaultPixel }));
}

async function main() {
  const { action, args } = parseArgs();
  try {
    switch (action) {
      case 'accounts': await listAccounts(); break;
      case 'campaigns': await listCampaigns(args); break;
      case 'performance': await performance(args); break;
      case 'pixel-events': await pixelEvents(args); break;
      case 'weekly-summary': await weeklySummary(args); break;
      default:
        console.error(JSON.stringify({
          status: 'error',
          error: `Unknown action '${action}'`,
          actions: ['accounts','campaigns','performance','pixel-events','weekly-summary'],
        }));
        process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

main();
