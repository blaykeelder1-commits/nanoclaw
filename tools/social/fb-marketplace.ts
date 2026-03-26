#!/usr/bin/env npx tsx
/**
 * Facebook Marketplace Listing Management Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/social/fb-marketplace.ts create-listing --title "2BR House" --price 1200 --description "Nice rental" [--category HOME_RENTALS] [--location "Tomball, TX"] [--images "url1,url2"] [--condition USED_GOOD] [--availability IN_STOCK] [--dry-run]
 *   npx tsx tools/social/fb-marketplace.ts list-active [--limit 20]
 *   npx tsx tools/social/fb-marketplace.ts update-listing --listing-id 123 [--title "New Title"] [--price 1300] [--description "Updated"] [--availability OUT_OF_STOCK]
 *   npx tsx tools/social/fb-marketplace.ts delete-listing --listing-id 123
 *   npx tsx tools/social/fb-marketplace.ts renew-listing --listing-id 123 [--title "Fresh Title"] [--price 1250] [--description "Refreshed"] [--images "url1,url2"]
 *
 * Actions:
 *   create-listing   Create a new Marketplace listing
 *   list-active       Fetch current active listings
 *   update-listing    Update an existing listing (partial)
 *   delete-listing    Remove a listing
 *   renew-listing     Re-post an expired/old listing with fresh content
 *
 * Environment: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
 * Uses Facebook Graph API v21.0
 */

import https from 'https';

// ── Types ──

type Category = 'VEHICLE_PARTS' | 'TOOLS' | 'CAMPING' | 'HOME_RENTALS' | 'OTHER';
type Condition = 'NEW' | 'USED_LIKE_NEW' | 'USED_GOOD' | 'USED_FAIR';
type Availability = 'IN_STOCK' | 'OUT_OF_STOCK';

interface ParsedArgs {
  action: string;
  title?: string;
  price?: string;
  description?: string;
  category?: Category;
  location?: string;
  images?: string;
  condition?: Condition;
  availability?: Availability;
  listingId?: string;
  limit?: string;
  dryRun: boolean;
}

// ── Helpers ──

function httpsRequest(options: https.RequestOptions, body?: string | Buffer): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function graphRequest(
  method: string,
  endpoint: string,
  params?: URLSearchParams,
  jsonBody?: Record<string, unknown>,
): Promise<{ statusCode: number; data: string }> {
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN!;

  if (method === 'GET') {
    const qs = params || new URLSearchParams();
    qs.set('access_token', accessToken);
    const path = `/v21.0${endpoint}?${qs.toString()}`;
    return httpsRequest({
      hostname: 'graph.facebook.com',
      path,
      method: 'GET',
    });
  }

  if (jsonBody) {
    const body = JSON.stringify({ ...jsonBody, access_token: accessToken });
    return httpsRequest({
      hostname: 'graph.facebook.com',
      path: `/v21.0${endpoint}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);
  }

  const postParams = params || new URLSearchParams();
  postParams.set('access_token', accessToken);
  const postData = postParams.toString();
  return httpsRequest({
    hostname: 'graph.facebook.com',
    path: `/v21.0${endpoint}`,
    method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, postData);
}

function fail(error: string): never {
  console.log(JSON.stringify({ status: 'error', error }));
  process.exit(1);
}

function requireEnv(): { pageId: string; accessToken: string } {
  const pageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !accessToken) {
    fail('Missing Facebook credentials. Set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN.');
  }
  return { pageId, accessToken };
}

// ── Arg Parsing ──

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  const action = argv[0];

  if (!action || action.startsWith('--')) {
    console.error('Usage: fb-marketplace.ts <action> [flags]');
    console.error('Actions: create-listing, list-active, update-listing, delete-listing, renew-listing');
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  const dryRun = argv.includes('--dry-run');

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') continue;
    if (arg.startsWith('--') && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[++i];
    }
  }

  return {
    action,
    title: flags.title,
    price: flags.price,
    description: flags.description,
    category: flags.category as Category | undefined,
    location: flags.location,
    images: flags.images,
    condition: flags.condition as Condition | undefined,
    availability: flags.availability as Availability | undefined,
    listingId: flags['listing-id'],
    limit: flags.limit,
    dryRun,
  };
}

// ── Actions ──

async function createListing(args: ParsedArgs): Promise<void> {
  if (!args.title) fail('--title is required for create-listing');
  if (!args.price) fail('--price is required for create-listing');
  if (!args.description) fail('--description is required for create-listing');

  const category = args.category || 'OTHER';
  const location = args.location || 'Tomball, TX';
  const condition = args.condition || 'USED_GOOD';
  const availability = args.availability || 'IN_STOCK';
  const imageUrls = args.images ? args.images.split(',').map((u) => u.trim()) : [];
  const priceInCents = Math.round(parseFloat(args.price) * 100);

  const listingData = {
    title: args.title,
    price: args.price,
    price_in_cents: priceInCents,
    description: args.description,
    category,
    location,
    condition,
    availability,
    images: imageUrls,
  };

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      action: 'create-listing',
      listing_data: listingData,
      message: 'No listing was created. Remove --dry-run to post for real.',
    }));
    return;
  }

  const { pageId } = requireEnv();

  // Attempt Commerce API first
  const commerceBody: Record<string, unknown> = {
    name: args.title,
    description: args.description,
    price: priceInCents,
    currency: 'USD',
    condition,
    availability,
    category,
  };

  if (imageUrls.length > 0) {
    commerceBody.image_urls = imageUrls;
  }

  const res = await graphRequest('POST', `/${pageId}/commerce_listings`, undefined, commerceBody);
  const parsed = JSON.parse(res.data);

  if (res.statusCode === 200 && parsed.id) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'create-listing',
      listing_id: parsed.id,
      listing_data: listingData,
    }));
    return;
  }

  // Commerce API not available — provide fallback with structured data
  console.log(JSON.stringify({
    status: 'fallback_needed',
    message: 'Marketplace Commerce API not available for this page. Use agent-browser to post manually.',
    api_error: parsed.error?.message || parsed.error || res.data,
    api_status_code: res.statusCode,
    listing_data: listingData,
  }));
}

async function listActive(args: ParsedArgs): Promise<void> {
  const { pageId } = requireEnv();
  const limit = args.limit || '20';

  // Try Commerce API first
  const params = new URLSearchParams();
  params.set('limit', limit);

  const res = await graphRequest('GET', `/${pageId}/commerce_listings`, params);
  const parsed = JSON.parse(res.data);

  if (res.statusCode === 200 && parsed.data) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'list-active',
      source: 'commerce_api',
      count: parsed.data.length,
      listings: parsed.data,
      paging: parsed.paging || null,
    }));
    return;
  }

  // Fallback: search page feed for marketplace-style posts
  const feedParams = new URLSearchParams();
  feedParams.set('limit', limit);
  feedParams.set('fields', 'id,message,created_time,permalink_url,full_picture,attachments');

  const feedRes = await graphRequest('GET', `/${pageId}/feed`, feedParams);
  const feedParsed = JSON.parse(feedRes.data);

  if (feedRes.statusCode === 200 && feedParsed.data) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'list-active',
      source: 'page_feed_fallback',
      note: 'Commerce API unavailable. Showing recent page posts instead. Marketplace listings may require manual review.',
      count: feedParsed.data.length,
      posts: feedParsed.data,
      paging: feedParsed.paging || null,
    }));
    return;
  }

  console.log(JSON.stringify({
    status: 'error',
    action: 'list-active',
    commerce_error: parsed.error?.message || parsed.error || null,
    feed_error: feedParsed.error?.message || feedParsed.error || null,
  }));
}

async function updateListing(args: ParsedArgs): Promise<void> {
  if (!args.listingId) fail('--listing-id is required for update-listing');

  const { pageId } = requireEnv();

  const updates: Record<string, unknown> = {};
  if (args.title) updates.name = args.title;
  if (args.price) updates.price = Math.round(parseFloat(args.price) * 100);
  if (args.description) updates.description = args.description;
  if (args.availability) updates.availability = args.availability;

  if (Object.keys(updates).length === 0) {
    fail('No update flags provided. Use --title, --price, --description, or --availability.');
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      action: 'update-listing',
      listing_id: args.listingId,
      updates,
      message: 'No update was applied. Remove --dry-run to update for real.',
    }));
    return;
  }

  const res = await graphRequest('POST', `/${args.listingId}`, undefined, updates);
  const parsed = JSON.parse(res.data);

  if (res.statusCode === 200 && (parsed.success || parsed.id)) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'update-listing',
      listing_id: args.listingId,
      updates,
    }));
    return;
  }

  console.log(JSON.stringify({
    status: 'fallback_needed',
    action: 'update-listing',
    message: 'Commerce API update failed. Use agent-browser to update the listing manually.',
    api_error: parsed.error?.message || parsed.error || res.data,
    api_status_code: res.statusCode,
    listing_id: args.listingId,
    updates,
  }));
}

async function deleteListing(args: ParsedArgs): Promise<void> {
  if (!args.listingId) fail('--listing-id is required for delete-listing');

  const { pageId } = requireEnv();

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      action: 'delete-listing',
      listing_id: args.listingId,
      message: 'No listing was deleted. Remove --dry-run to delete for real.',
    }));
    return;
  }

  const res = await graphRequest('DELETE', `/${args.listingId}`);
  const parsed = JSON.parse(res.data);

  if (res.statusCode === 200 && (parsed.success || parsed.id)) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'delete-listing',
      listing_id: args.listingId,
    }));
    return;
  }

  console.log(JSON.stringify({
    status: 'fallback_needed',
    action: 'delete-listing',
    message: 'Commerce API delete failed. Use agent-browser to remove the listing manually.',
    api_error: parsed.error?.message || parsed.error || res.data,
    api_status_code: res.statusCode,
    listing_id: args.listingId,
  }));
}

async function renewListing(args: ParsedArgs): Promise<void> {
  if (!args.listingId) fail('--listing-id is required for renew-listing');

  const { pageId } = requireEnv();

  // Step 1: Fetch existing listing data
  const fetchRes = await graphRequest('GET', `/${args.listingId}`, new URLSearchParams({
    fields: 'id,name,description,price,currency,condition,availability,category,images',
  }));
  const existing = JSON.parse(fetchRes.data);

  if (fetchRes.statusCode !== 200 || existing.error) {
    // If we can't fetch the old listing, we can still create a new one if overrides are provided
    if (!args.title || !args.price || !args.description) {
      console.log(JSON.stringify({
        status: 'error',
        action: 'renew-listing',
        message: 'Could not fetch existing listing and insufficient override data provided. Provide --title, --price, and --description to create a fresh listing.',
        api_error: existing.error?.message || existing.error || fetchRes.data,
        api_status_code: fetchRes.statusCode,
        listing_id: args.listingId,
      }));
      return;
    }
  }

  // Merge existing data with overrides
  const title = args.title || existing.name || 'Untitled Listing';
  const priceStr = args.price || (existing.price ? String(existing.price / 100) : '0');
  const description = args.description || existing.description || '';
  const imageUrls = args.images
    ? args.images.split(',').map((u) => u.trim())
    : (existing.images?.data?.map((img: { uri: string }) => img.uri) || []);

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      action: 'renew-listing',
      old_listing_id: args.listingId,
      new_listing_data: {
        title,
        price: priceStr,
        description,
        images: imageUrls,
        condition: existing.condition || 'USED_GOOD',
        availability: 'IN_STOCK',
      },
      message: 'No listing was renewed. Remove --dry-run to renew for real.',
    }));
    return;
  }

  // Step 2: Delete the old listing (best-effort)
  const deleteRes = await graphRequest('DELETE', `/${args.listingId}`);
  const deleteParsed = JSON.parse(deleteRes.data);
  const deleteSucceeded = deleteRes.statusCode === 200 && (deleteParsed.success || deleteParsed.id);

  // Step 3: Create the new listing
  const createArgs: ParsedArgs = {
    action: 'create-listing',
    title,
    price: priceStr,
    description,
    category: existing.category || 'OTHER',
    location: 'Tomball, TX',
    images: imageUrls.length > 0 ? imageUrls.join(',') : undefined,
    condition: existing.condition || 'USED_GOOD',
    availability: 'IN_STOCK',
    dryRun: false,
  };

  const priceInCents = Math.round(parseFloat(priceStr) * 100);

  const commerceBody: Record<string, unknown> = {
    name: title,
    description,
    price: priceInCents,
    currency: 'USD',
    condition: existing.condition || 'USED_GOOD',
    availability: 'IN_STOCK',
    category: existing.category || 'OTHER',
  };

  if (imageUrls.length > 0) {
    commerceBody.image_urls = imageUrls;
  }

  const createRes = await graphRequest('POST', `/${pageId}/commerce_listings`, undefined, commerceBody);
  const createParsed = JSON.parse(createRes.data);

  if (createRes.statusCode === 200 && createParsed.id) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'renew-listing',
      old_listing_id: args.listingId,
      old_listing_deleted: deleteSucceeded,
      new_listing_id: createParsed.id,
    }));
    return;
  }

  // Fallback
  console.log(JSON.stringify({
    status: 'fallback_needed',
    action: 'renew-listing',
    message: 'Marketplace Commerce API not available for this page. Use agent-browser to re-post manually.',
    old_listing_id: args.listingId,
    old_listing_deleted: deleteSucceeded,
    api_error: createParsed.error?.message || createParsed.error || createRes.data,
    api_status_code: createRes.statusCode,
    listing_data: {
      title,
      price: priceStr,
      price_in_cents: priceInCents,
      description,
      images: imageUrls,
      condition: existing.condition || 'USED_GOOD',
      availability: 'IN_STOCK',
    },
  }));
}

// ── Main ──

async function main(): Promise<void> {
  const args = parseArgs();

  switch (args.action) {
    case 'create-listing':
      await createListing(args);
      break;
    case 'list-active':
      await listActive(args);
      break;
    case 'update-listing':
      await updateListing(args);
      break;
    case 'delete-listing':
      await deleteListing(args);
      break;
    case 'renew-listing':
      await renewListing(args);
      break;
    default:
      fail(`Unknown action: ${args.action}. Valid actions: create-listing, list-active, update-listing, delete-listing, renew-listing`);
  }
}

main();
