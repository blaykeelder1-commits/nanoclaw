#!/usr/bin/env npx tsx
/**
 * Google Ads Management Tool for NanoClaw
 *
 * Uses Google Ads REST API (v18) with OAuth2 credentials.
 *
 * Usage:
 *   npx tsx tools/ads/google-ads.ts create-campaign --name "Spring Promo" --budget 50 [--type SEARCH] [--keywords "vending,snacks"] [--location "Houston, TX"] [--ad-text "Best Vending"] [--description "Fresh snacks daily"] [--dry-run]
 *   npx tsx tools/ads/google-ads.ts list-campaigns [--status ALL]
 *   npx tsx tools/ads/google-ads.ts pause-campaign --campaign-id 123456
 *   npx tsx tools/ads/google-ads.ts enable-campaign --campaign-id 123456
 *   npx tsx tools/ads/google-ads.ts report [--days 7] [--campaign-id 123456] [--breakdown campaign]
 *   npx tsx tools/ads/google-ads.ts add-keywords --campaign-id 123456 --keywords "vending,snacks" [--match-type PHRASE]
 *   npx tsx tools/ads/google-ads.ts adjust-budget --campaign-id 123456 --budget 75
 *   npx tsx tools/ads/google-ads.ts keyword-ideas --keywords "vending machines,snack delivery" [--location "Houston, TX"] [--limit 20]
 *
 * Environment variables:
 *   GOOGLE_ADS_CUSTOMER_ID    — Google Ads customer ID (without dashes)
 *   GOOGLE_ADS_DEVELOPER_TOKEN — Developer token
 *   GOOGLE_ADS_REFRESH_TOKEN  — OAuth2 refresh token
 *   GOOGLE_ADS_CLIENT_ID      — OAuth2 client ID
 *   GOOGLE_ADS_CLIENT_SECRET  — OAuth2 client secret
 */

import https from 'https';
import { URL } from 'url';

// ── Config ──────────────────────────────────────────────────────────────────

const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID ?? '';
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '';
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN ?? '';
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET ?? '';

const API_VERSION = 'v18';
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;

const ACTIONS = [
  'create-campaign',
  'list-campaigns',
  'pause-campaign',
  'enable-campaign',
  'report',
  'add-keywords',
  'adjust-budget',
  'keyword-ideas',
] as const;
type Action = (typeof ACTIONS)[number];

// ── Interfaces ──────────────────────────────────────────────────────────────

interface Args {
  action: Action;
  name?: string;
  budget?: number;
  type: 'SEARCH' | 'DISPLAY' | 'LOCAL';
  keywords?: string[];
  location: string;
  adText?: string;
  description?: string;
  dryRun: boolean;
  status: 'ENABLED' | 'PAUSED' | 'ALL';
  campaignId?: string;
  days: number;
  breakdown: 'campaign' | 'ad_group' | 'keyword' | 'day';
  matchType: 'BROAD' | 'PHRASE' | 'EXACT';
  limit: number;
}

// ── Arg Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;

  if (!ACTIONS.includes(action)) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Valid actions: ${ACTIONS.join(', ')}`,
      usage: [
        'npx tsx tools/ads/google-ads.ts create-campaign --name "Spring Promo" --budget 50',
        'npx tsx tools/ads/google-ads.ts list-campaigns [--status ALL]',
        'npx tsx tools/ads/google-ads.ts pause-campaign --campaign-id 123456',
        'npx tsx tools/ads/google-ads.ts enable-campaign --campaign-id 123456',
        'npx tsx tools/ads/google-ads.ts report [--days 7] [--campaign-id 123456] [--breakdown campaign]',
        'npx tsx tools/ads/google-ads.ts add-keywords --campaign-id 123456 --keywords "vending,snacks"',
        'npx tsx tools/ads/google-ads.ts adjust-budget --campaign-id 123456 --budget 75',
        'npx tsx tools/ads/google-ads.ts keyword-ideas --keywords "vending machines" [--limit 20]',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      boolFlags.add('dry-run');
    } else if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    name: flags.name,
    budget: flags.budget ? parseFloat(flags.budget) : undefined,
    type: (flags.type as Args['type']) || 'SEARCH',
    keywords: flags.keywords ? flags.keywords.split(',').map(k => k.trim()) : undefined,
    location: flags.location || 'Houston, TX',
    adText: flags['ad-text'],
    description: flags.description,
    dryRun: boolFlags.has('dry-run'),
    status: (flags.status as Args['status']) || 'ALL',
    campaignId: flags['campaign-id'],
    days: parseInt(flags.days || '7', 10),
    breakdown: (flags.breakdown as Args['breakdown']) || 'campaign',
    matchType: (flags['match-type'] as Args['matchType']) || 'PHRASE',
    limit: parseInt(flags.limit || '20', 10),
  };
}

// ── HTTP Helpers ────────────────────────────────────────────────────────────

function httpsRequest(url: string, options: https.RequestOptions, body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          data: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(): Promise<string> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const body = params.toString();
  const resp = await httpsRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  const json = JSON.parse(resp.data);
  if (!json.access_token) {
    throw new Error(`OAuth token refresh failed: ${resp.data}`);
  }
  return json.access_token;
}

function apiHeaders(accessToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': DEVELOPER_TOKEN,
    'login-customer-id': CUSTOMER_ID,
    'Content-Type': 'application/json',
  };
}

async function gaqlQuery(accessToken: string, query: string): Promise<any[]> {
  const url = `${BASE_URL}/customers/${CUSTOMER_ID}/googleAds:searchStream`;
  const body = JSON.stringify({ query });
  const headers = apiHeaders(accessToken);
  (headers as any)['Content-Length'] = Buffer.byteLength(body);

  const resp = await httpsRequest(url, { method: 'POST', headers }, body);
  const json = JSON.parse(resp.data);

  if (resp.status >= 400) {
    throw new Error(`GAQL query failed (${resp.status}): ${JSON.stringify(json)}`);
  }

  // searchStream returns an array of result batches
  const results: any[] = [];
  if (Array.isArray(json)) {
    for (const batch of json) {
      if (batch.results) results.push(...batch.results);
    }
  }
  return results;
}

async function apiPost(accessToken: string, path: string, payload: any): Promise<any> {
  const url = `${BASE_URL}/${path}`;
  const body = JSON.stringify(payload);
  const headers = apiHeaders(accessToken);
  (headers as any)['Content-Length'] = Buffer.byteLength(body);

  const resp = await httpsRequest(url, { method: 'POST', headers }, body);
  const json = JSON.parse(resp.data);

  if (resp.status >= 400) {
    throw new Error(`API POST ${path} failed (${resp.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

// ── Env Validation ──────────────────────────────────────────────────────────

function validateEnv(): void {
  const required = [
    'GOOGLE_ADS_CUSTOMER_ID',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_REFRESH_TOKEN',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Missing environment variables: ${missing.join(', ')}`,
    }));
    process.exit(1);
  }
}

// ── Date Helpers ────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `'${d.toISOString().slice(0, 10)}'`;
}

function today(): string {
  return `'${new Date().toISOString().slice(0, 10)}'`;
}

// ── Campaign Type Mapping ───────────────────────────────────────────────────

function campaignTypeEnum(type: string): string {
  const map: Record<string, string> = {
    SEARCH: 'SEARCH',
    DISPLAY: 'DISPLAY_NETWORK',
    LOCAL: 'LOCAL',
  };
  return map[type] || 'SEARCH';
}

function advertisingChannelType(type: string): string {
  const map: Record<string, string> = {
    SEARCH: 'SEARCH',
    DISPLAY: 'DISPLAY',
    LOCAL: 'LOCAL',
  };
  return map[type] || 'SEARCH';
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function createCampaign(args: Args): Promise<void> {
  if (!args.name) {
    console.log(JSON.stringify({ status: 'error', error: '--name is required' }));
    process.exit(1);
  }
  if (args.budget === undefined) {
    console.log(JSON.stringify({ status: 'error', error: '--budget is required (daily budget in dollars)' }));
    process.exit(1);
  }

  const budgetMicros = Math.round(args.budget * 1_000_000);
  const channelType = advertisingChannelType(args.type);

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      action: 'create-campaign',
      wouldCreate: {
        campaignName: args.name,
        dailyBudget: `$${args.budget}`,
        dailyBudgetMicros: budgetMicros,
        advertisingChannelType: channelType,
        keywords: args.keywords || [],
        location: args.location,
        adText: args.adText || null,
        description: args.description || null,
      },
      message: 'Dry run — no changes made. Remove --dry-run to execute.',
    }));
    return;
  }

  const accessToken = await getAccessToken();

  // Step 1: Create campaign budget
  const budgetResp = await apiPost(accessToken, `customers/${CUSTOMER_ID}/campaignBudgets:mutate`, {
    operations: [{
      create: {
        name: `${args.name} Budget`,
        amountMicros: budgetMicros.toString(),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    }],
  });

  const budgetResourceName = budgetResp.results?.[0]?.resourceName;
  if (!budgetResourceName) {
    throw new Error(`Failed to create budget: ${JSON.stringify(budgetResp)}`);
  }

  // Step 2: Create campaign
  const campaignResp = await apiPost(accessToken, `customers/${CUSTOMER_ID}/campaigns:mutate`, {
    operations: [{
      create: {
        name: args.name,
        advertisingChannelType: channelType,
        status: 'PAUSED', // Start paused so user can review
        campaignBudget: budgetResourceName,
        networkSettings: channelType === 'SEARCH' ? {
          targetGoogleSearch: true,
          targetSearchNetwork: true,
          targetContentNetwork: false,
        } : undefined,
        manualCpc: {},
      },
    }],
  });

  const campaignResourceName = campaignResp.results?.[0]?.resourceName;
  if (!campaignResourceName) {
    throw new Error(`Failed to create campaign: ${JSON.stringify(campaignResp)}`);
  }
  const campaignId = campaignResourceName.split('/').pop();

  // Step 3: Create ad group
  const adGroupResp = await apiPost(accessToken, `customers/${CUSTOMER_ID}/adGroups:mutate`, {
    operations: [{
      create: {
        name: `${args.name} — Ad Group 1`,
        campaign: campaignResourceName,
        type: channelType === 'SEARCH' ? 'SEARCH_STANDARD' : 'DISPLAY_STANDARD',
        status: 'ENABLED',
        cpcBidMicros: '2000000', // $2.00 default bid
      },
    }],
  });

  const adGroupResourceName = adGroupResp.results?.[0]?.resourceName;
  if (!adGroupResourceName) {
    throw new Error(`Failed to create ad group: ${JSON.stringify(adGroupResp)}`);
  }

  // Step 4: Add keywords (search campaigns)
  let keywordsAdded = 0;
  if (args.keywords && args.keywords.length > 0 && channelType === 'SEARCH') {
    const keywordOps = args.keywords.map(kw => ({
      create: {
        adGroup: adGroupResourceName,
        keyword: {
          text: kw,
          matchType: 'PHRASE',
        },
        status: 'ENABLED',
      },
    }));

    await apiPost(accessToken, `customers/${CUSTOMER_ID}/adGroupCriteria:mutate`, {
      operations: keywordOps,
    });
    keywordsAdded = args.keywords.length;
  }

  // Step 5: Create ad (if ad text provided)
  let adCreated = false;
  if (args.adText) {
    const headlines = args.adText.split('|').slice(0, 15).map(h => ({ text: h.trim().slice(0, 30) }));
    // Pad to minimum 3 headlines
    while (headlines.length < 3) {
      headlines.push({ text: headlines[0].text });
    }

    const descriptions = (args.description || args.adText)
      .split('|')
      .slice(0, 4)
      .map(d => ({ text: d.trim().slice(0, 90) }));
    while (descriptions.length < 2) {
      descriptions.push({ text: descriptions[0].text });
    }

    await apiPost(accessToken, `customers/${CUSTOMER_ID}/adGroupAds:mutate`, {
      operations: [{
        create: {
          adGroup: adGroupResourceName,
          status: 'ENABLED',
          ad: {
            responsiveSearchAd: {
              headlines,
              descriptions,
            },
            finalUrls: ['https://example.com'], // Placeholder — user should update
          },
        },
      }],
    });
    adCreated = true;
  }

  // Step 6: Add location targeting
  // Geo target constant for Houston, TX is 1026339
  const locationConstants: Record<string, string> = {
    'Houston, TX': 'geoTargetConstants/1026339',
    'Dallas, TX': 'geoTargetConstants/1026082',
    'San Antonio, TX': 'geoTargetConstants/1026481',
    'Austin, TX': 'geoTargetConstants/1026014',
  };
  const geoTarget = locationConstants[args.location];
  if (geoTarget) {
    await apiPost(accessToken, `customers/${CUSTOMER_ID}/campaignCriteria:mutate`, {
      operations: [{
        create: {
          campaign: campaignResourceName,
          location: {
            geoTargetConstant: geoTarget,
          },
        },
      }],
    });
  }

  console.log(JSON.stringify({
    status: 'ok',
    action: 'create-campaign',
    campaignId,
    campaignResourceName,
    campaignName: args.name,
    dailyBudget: `$${args.budget}`,
    channelType,
    campaignStatus: 'PAUSED',
    adGroupCreated: true,
    keywordsAdded,
    adCreated,
    locationTargeted: geoTarget ? args.location : 'none (unknown location — add manually)',
    note: 'Campaign created as PAUSED. Use enable-campaign to start it.',
  }));
}

async function listCampaigns(args: Args): Promise<void> {
  const accessToken = await getAccessToken();

  let statusFilter = '';
  if (args.status !== 'ALL') {
    statusFilter = ` AND campaign.status = '${args.status}'`;
  }

  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS${statusFilter}
    ORDER BY campaign.name
  `;

  const results = await gaqlQuery(accessToken, query);

  const campaigns = results.map(r => ({
    id: r.campaign?.id,
    name: r.campaign?.name,
    status: r.campaign?.status,
    channelType: r.campaign?.advertisingChannelType,
    dailyBudget: r.campaignBudget?.amountMicros
      ? `$${(parseInt(r.campaignBudget.amountMicros) / 1_000_000).toFixed(2)}`
      : 'N/A',
    spend: r.metrics?.costMicros
      ? `$${(parseInt(r.metrics.costMicros) / 1_000_000).toFixed(2)}`
      : '$0.00',
    impressions: parseInt(r.metrics?.impressions || '0'),
    clicks: parseInt(r.metrics?.clicks || '0'),
    ctr: r.metrics?.ctr ? `${(parseFloat(r.metrics.ctr) * 100).toFixed(2)}%` : '0.00%',
  }));

  console.log(JSON.stringify({
    status: 'ok',
    action: 'list-campaigns',
    count: campaigns.length,
    campaigns,
  }));
}

async function toggleCampaignStatus(args: Args, newStatus: 'ENABLED' | 'PAUSED'): Promise<void> {
  if (!args.campaignId) {
    console.log(JSON.stringify({ status: 'error', error: '--campaign-id is required' }));
    process.exit(1);
  }

  const accessToken = await getAccessToken();
  const resourceName = `customers/${CUSTOMER_ID}/campaigns/${args.campaignId}`;

  await apiPost(accessToken, `customers/${CUSTOMER_ID}/campaigns:mutate`, {
    operations: [{
      update: {
        resourceName,
        status: newStatus,
      },
      updateMask: 'status',
    }],
  });

  console.log(JSON.stringify({
    status: 'ok',
    action: newStatus === 'ENABLED' ? 'enable-campaign' : 'pause-campaign',
    campaignId: args.campaignId,
    newStatus,
  }));
}

async function report(args: Args): Promise<void> {
  const accessToken = await getAccessToken();

  let selectFields: string;
  let fromResource: string;
  let groupNote: string;

  switch (args.breakdown) {
    case 'ad_group':
      selectFields = `
        campaign.id, campaign.name,
        ad_group.id, ad_group.name,
        metrics.impressions, metrics.clicks, metrics.ctr,
        metrics.conversions, metrics.cost_micros, metrics.conversions_value`;
      fromResource = 'ad_group';
      groupNote = 'ad_group';
      break;
    case 'keyword':
      selectFields = `
        campaign.id, campaign.name,
        ad_group.name,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        metrics.impressions, metrics.clicks, metrics.ctr,
        metrics.conversions, metrics.cost_micros, metrics.conversions_value`;
      fromResource = 'keyword_view';
      groupNote = 'keyword';
      break;
    case 'day':
      selectFields = `
        segments.date,
        campaign.id, campaign.name,
        metrics.impressions, metrics.clicks, metrics.ctr,
        metrics.conversions, metrics.cost_micros, metrics.conversions_value`;
      fromResource = 'campaign';
      groupNote = 'day';
      break;
    default: // campaign
      selectFields = `
        campaign.id, campaign.name, campaign.status,
        metrics.impressions, metrics.clicks, metrics.ctr,
        metrics.conversions, metrics.cost_micros, metrics.conversions_value`;
      fromResource = 'campaign';
      groupNote = 'campaign';
  }

  const campaignFilter = args.campaignId
    ? ` AND campaign.id = ${args.campaignId}`
    : '';

  const query = `
    SELECT ${selectFields}
    FROM ${fromResource}
    WHERE segments.date BETWEEN ${daysAgo(args.days)} AND ${today()}${campaignFilter}
    ORDER BY metrics.cost_micros DESC
  `;

  const results = await gaqlQuery(accessToken, query);

  const rows = results.map(r => {
    const costMicros = parseInt(r.metrics?.costMicros || '0');
    const conversionsValue = parseFloat(r.metrics?.conversionsValue || '0');
    const cost = costMicros / 1_000_000;
    const roas = cost > 0 ? (conversionsValue / cost).toFixed(2) : 'N/A';

    const row: Record<string, any> = {};

    if (args.breakdown === 'day') {
      row.date = r.segments?.date;
    }
    row.campaignId = r.campaign?.id;
    row.campaignName = r.campaign?.name;

    if (args.breakdown === 'ad_group') {
      row.adGroupId = r.adGroup?.id;
      row.adGroupName = r.adGroup?.name;
    }
    if (args.breakdown === 'keyword') {
      row.adGroupName = r.adGroup?.name;
      row.keyword = r.adGroupCriterion?.keyword?.text;
      row.matchType = r.adGroupCriterion?.keyword?.matchType;
    }

    row.impressions = parseInt(r.metrics?.impressions || '0');
    row.clicks = parseInt(r.metrics?.clicks || '0');
    row.ctr = r.metrics?.ctr ? `${(parseFloat(r.metrics.ctr) * 100).toFixed(2)}%` : '0.00%';
    row.conversions = parseFloat(r.metrics?.conversions || '0');
    row.cost = `$${cost.toFixed(2)}`;
    row.roas = roas;

    return row;
  });

  console.log(JSON.stringify({
    status: 'ok',
    action: 'report',
    breakdown: args.breakdown,
    days: args.days,
    campaignId: args.campaignId || 'all',
    rowCount: rows.length,
    rows,
  }));
}

async function addKeywords(args: Args): Promise<void> {
  if (!args.campaignId) {
    console.log(JSON.stringify({ status: 'error', error: '--campaign-id is required' }));
    process.exit(1);
  }
  if (!args.keywords || args.keywords.length === 0) {
    console.log(JSON.stringify({ status: 'error', error: '--keywords is required (comma-separated)' }));
    process.exit(1);
  }

  const accessToken = await getAccessToken();

  // Find the first ad group for this campaign
  const adGroupQuery = `
    SELECT ad_group.resource_name, ad_group.name
    FROM ad_group
    WHERE campaign.id = ${args.campaignId}
    LIMIT 1
  `;
  const adGroupResults = await gaqlQuery(accessToken, adGroupQuery);

  if (adGroupResults.length === 0) {
    console.log(JSON.stringify({
      status: 'error',
      error: `No ad groups found for campaign ${args.campaignId}. Create an ad group first.`,
    }));
    process.exit(1);
  }

  const adGroupResourceName = adGroupResults[0].adGroup.resourceName;

  const operations = args.keywords.map(kw => ({
    create: {
      adGroup: adGroupResourceName,
      keyword: {
        text: kw,
        matchType: args.matchType,
      },
      status: 'ENABLED',
    },
  }));

  const resp = await apiPost(accessToken, `customers/${CUSTOMER_ID}/adGroupCriteria:mutate`, {
    operations,
  });

  console.log(JSON.stringify({
    status: 'ok',
    action: 'add-keywords',
    campaignId: args.campaignId,
    adGroup: adGroupResults[0].adGroup.name,
    keywordsAdded: args.keywords.length,
    keywords: args.keywords.map(kw => ({ text: kw, matchType: args.matchType })),
    results: resp.results?.length || 0,
  }));
}

async function adjustBudget(args: Args): Promise<void> {
  if (!args.campaignId) {
    console.log(JSON.stringify({ status: 'error', error: '--campaign-id is required' }));
    process.exit(1);
  }
  if (args.budget === undefined) {
    console.log(JSON.stringify({ status: 'error', error: '--budget is required (daily budget in dollars)' }));
    process.exit(1);
  }

  const accessToken = await getAccessToken();

  // Get the campaign's budget resource name
  const budgetQuery = `
    SELECT campaign.campaign_budget
    FROM campaign
    WHERE campaign.id = ${args.campaignId}
    LIMIT 1
  `;
  const budgetResults = await gaqlQuery(accessToken, budgetQuery);

  if (budgetResults.length === 0) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Campaign ${args.campaignId} not found.`,
    }));
    process.exit(1);
  }

  const budgetResourceName = budgetResults[0].campaign.campaignBudget;
  const newBudgetMicros = Math.round(args.budget * 1_000_000);

  await apiPost(accessToken, `customers/${CUSTOMER_ID}/campaignBudgets:mutate`, {
    operations: [{
      update: {
        resourceName: budgetResourceName,
        amountMicros: newBudgetMicros.toString(),
      },
      updateMask: 'amount_micros',
    }],
  });

  console.log(JSON.stringify({
    status: 'ok',
    action: 'adjust-budget',
    campaignId: args.campaignId,
    newDailyBudget: `$${args.budget}`,
    newBudgetMicros,
  }));
}

async function keywordIdeas(args: Args): Promise<void> {
  if (!args.keywords || args.keywords.length === 0) {
    console.log(JSON.stringify({ status: 'error', error: '--keywords is required (comma-separated seed keywords)' }));
    process.exit(1);
  }

  const accessToken = await getAccessToken();

  // Geo target constant for common locations
  const locationConstants: Record<string, string> = {
    'Houston, TX': 'geoTargetConstants/1026339',
    'Dallas, TX': 'geoTargetConstants/1026082',
    'San Antonio, TX': 'geoTargetConstants/1026481',
    'Austin, TX': 'geoTargetConstants/1026014',
    'United States': 'geoTargetConstants/2840',
  };
  const geoTarget = locationConstants[args.location] || locationConstants['Houston, TX'];

  const payload = {
    keywordSeed: {
      keywords: args.keywords,
    },
    geoTargetConstants: [geoTarget],
    language: 'languageConstants/1000', // English
    keywordPlanNetwork: 'GOOGLE_SEARCH',
    pageSize: args.limit,
  };

  const resp = await apiPost(
    accessToken,
    `customers/${CUSTOMER_ID}:generateKeywordIdeas`,
    payload,
  );

  const ideas = (resp.results || []).map((r: any) => ({
    keyword: r.text,
    avgMonthlySearches: r.keywordIdeaMetrics?.avgMonthlySearches || 0,
    competition: r.keywordIdeaMetrics?.competition || 'UNSPECIFIED',
    competitionIndex: r.keywordIdeaMetrics?.competitionIndex || 0,
    suggestedBidLow: r.keywordIdeaMetrics?.lowTopOfPageBidMicros
      ? `$${(parseInt(r.keywordIdeaMetrics.lowTopOfPageBidMicros) / 1_000_000).toFixed(2)}`
      : 'N/A',
    suggestedBidHigh: r.keywordIdeaMetrics?.highTopOfPageBidMicros
      ? `$${(parseInt(r.keywordIdeaMetrics.highTopOfPageBidMicros) / 1_000_000).toFixed(2)}`
      : 'N/A',
  }));

  console.log(JSON.stringify({
    status: 'ok',
    action: 'keyword-ideas',
    seedKeywords: args.keywords,
    location: args.location,
    count: ideas.length,
    ideas,
  }));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  // Dry run on create-campaign doesn't need env vars
  if (!(args.action === 'create-campaign' && args.dryRun)) {
    validateEnv();
  }

  switch (args.action) {
    case 'create-campaign':
      await createCampaign(args);
      break;
    case 'list-campaigns':
      await listCampaigns(args);
      break;
    case 'pause-campaign':
      await toggleCampaignStatus(args, 'PAUSED');
      break;
    case 'enable-campaign':
      await toggleCampaignStatus(args, 'ENABLED');
      break;
    case 'report':
      await report(args);
      break;
    case 'add-keywords':
      await addKeywords(args);
      break;
    case 'adjust-budget':
      await adjustBudget(args);
      break;
    case 'keyword-ideas':
      await keywordIdeas(args);
      break;
  }
}

main().catch(err => {
  console.log(JSON.stringify({
    status: 'error',
    error: err.message || String(err),
    stack: process.env.DEBUG ? err.stack : undefined,
  }));
  process.exit(1);
});
