#!/usr/bin/env npx tsx
/**
 * Facebook Page Configuration Tool
 *
 * Manages the always-on UX of a Facebook Page so Andy (or the user) doesn't
 * have to drift back to manual UI clicks. Sets Messenger ice-breakers, Get
 * Started button, persistent menu, optional cover/profile photo, and (with a
 * pages_manage_metadata token) Page hours / about / website / cta.
 *
 * Usage:
 *   npx tsx tools/social/fb-page-config.ts apply-messenger \
 *     --greeting "Hey! Andy here..." \
 *     --menu-url "https://example.com/book"
 *
 *   npx tsx tools/social/fb-page-config.ts set-cover --image-url <url>
 *   npx tsx tools/social/fb-page-config.ts set-profile-photo --image-url <url>
 *   npx tsx tools/social/fb-page-config.ts set-hours --hours-json '{"sun_1_open":"08:00",...}'
 *   npx tsx tools/social/fb-page-config.ts set-info --about "..." --website "https://..." --phone "+1..."
 *   npx tsx tools/social/fb-page-config.ts read --fields name,about,hours,website,cover,picture
 *   npx tsx tools/social/fb-page-config.ts read-messenger
 *
 * Environment:
 *   FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN — injected per-group via secretOverrides
 *
 * Token scopes needed:
 *   pages_messaging          — ice breakers, menu, get started
 *   pages_manage_posts       — cover/profile photo upload
 *   pages_manage_metadata    — hours, about, website, cta (currently MISSING on default token)
 */

const GRAPH = 'https://graph.facebook.com/v18.0';

type Args = Record<string, string>;

function parseArgs(): { action: string; args: Args } {
  const argv = process.argv.slice(2);
  const action = argv[0] || '';
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return { action, args };
}

function env(): { pageId: string; token: string } {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    console.error(JSON.stringify({ status: 'error', error: 'FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN required' }));
    process.exit(1);
  }
  return { pageId, token };
}

async function graph(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${GRAPH}${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) throw new Error(`Graph ${method} ${path}: ${resp.status} — ${text.slice(0, 300)}`);
  return data;
}

async function applyMessenger(args: Args): Promise<void> {
  const { token } = env();
  const menuUrl = args['menu-url'] || 'https://sheridantrailerrentals.us/form';
  const iceBreakers = args['ice-breakers']
    ? JSON.parse(args['ice-breakers'])
    : [
        { question: 'What dates do you need?', payload: 'DATES' },
        { question: 'How much does it cost?', payload: 'PRICING' },
        { question: 'Can you deliver?', payload: 'DELIVERY' },
        { question: "What's included with the rental?", payload: 'INCLUDED' },
      ];
  const persistentMenuItems = args['menu-items']
    ? JSON.parse(args['menu-items'])
    : [
        { type: 'web_url', title: 'Book Now', url: menuUrl, webview_height_ratio: 'full' },
        { type: 'postback', title: 'Talk to Andy', payload: 'TALK_TO_ANDY' },
      ];
  const body = {
    ice_breakers: [{ locale: 'default', call_to_actions: iceBreakers }],
    get_started: { payload: args['get-started-payload'] || 'GET_STARTED' },
    persistent_menu: [
      {
        locale: 'default',
        composer_input_disabled: false,
        call_to_actions: persistentMenuItems,
      },
    ],
  };
  const r = await graph('POST', `/me/messenger_profile?access_token=${token}`, body);
  console.log(JSON.stringify({ status: 'success', applied: body, result: r }));
}

async function readMessenger(): Promise<void> {
  const { token } = env();
  const r = await graph('GET', `/me/messenger_profile?fields=ice_breakers,get_started,persistent_menu,greeting&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', profile: r }));
}

async function setCover(args: Args): Promise<void> {
  const { pageId, token } = env();
  const url = args['image-url'];
  if (!url) throw new Error('--image-url required');
  // Upload then set as cover. Page cover requires two-step: upload then POST cover with photo_id
  const photo = (await graph('POST', `/${pageId}/photos?url=${encodeURIComponent(url)}&published=false&access_token=${token}`)) as { id?: string };
  if (!photo.id) throw new Error('photo upload returned no id');
  const cover = await graph('POST', `/${pageId}?cover=${photo.id}&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', photoId: photo.id, cover }));
}

async function setProfilePhoto(args: Args): Promise<void> {
  const { pageId, token } = env();
  const url = args['image-url'];
  if (!url) throw new Error('--image-url required');
  const r = await graph('POST', `/${pageId}/picture?url=${encodeURIComponent(url)}&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', result: r }));
}

async function setHours(args: Args): Promise<void> {
  const { pageId, token } = env();
  const raw = args['hours-json'];
  if (!raw) throw new Error('--hours-json required (e.g. \'{"sun_1_open":"08:00","sun_1_close":"20:00",...}\')');
  const hours = JSON.parse(raw);
  const r = await graph('POST', `/${pageId}?hours=${encodeURIComponent(JSON.stringify(hours))}&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', result: r }));
}

async function setInfo(args: Args): Promise<void> {
  const { pageId, token } = env();
  const params: string[] = [];
  if (args['about']) params.push(`about=${encodeURIComponent(args['about'])}`);
  if (args['website']) params.push(`website=${encodeURIComponent(args['website'])}`);
  if (args['phone']) params.push(`phone=${encodeURIComponent(args['phone'])}`);
  if (args['description']) params.push(`description=${encodeURIComponent(args['description'])}`);
  if (params.length === 0) throw new Error('Provide at least one of --about --website --phone --description');
  const r = await graph('POST', `/${pageId}?${params.join('&')}&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', result: r }));
}

async function read(args: Args): Promise<void> {
  const { pageId, token } = env();
  const fields = args['fields'] || 'name,about,description,hours,phone,website,emails,location,category_list,fan_count,is_published,picture,cover';
  const r = await graph('GET', `/${pageId}?fields=${fields}&access_token=${token}`);
  console.log(JSON.stringify({ status: 'success', page: r }));
}

async function main() {
  const { action, args } = parseArgs();
  try {
    switch (action) {
      case 'apply-messenger': await applyMessenger(args); break;
      case 'read-messenger': await readMessenger(); break;
      case 'set-cover': await setCover(args); break;
      case 'set-profile-photo': await setProfilePhoto(args); break;
      case 'set-hours': await setHours(args); break;
      case 'set-info': await setInfo(args); break;
      case 'read': await read(args); break;
      default:
        console.error(JSON.stringify({
          status: 'error',
          error: `Unknown action '${action}'`,
          actions: ['apply-messenger','read-messenger','set-cover','set-profile-photo','set-hours','set-info','read'],
        }));
        process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

main();
