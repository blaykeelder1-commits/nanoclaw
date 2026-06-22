#!/usr/bin/env npx tsx
/**
 * post-all.ts — Loud-fail social fan-out orchestrator for NanoClaw
 *
 * Posts ONE piece of content to every target platform for a business and ALWAYS
 * returns a per-platform receipt: posted / not_connected / skipped / error.
 * No platform is allowed to fail silently — that is the entire point of this tool.
 *
 * Usage:
 *   npx tsx tools/social/post-all.ts --group snak|sheridan --message "text" \
 *     [--asset <index|name>] [--image <publicImageUrl>] [--source <localFile>] \
 *     [--link <url>] [--video <publicVideoUrl>] [--place-id <id>] \
 *     [--platforms facebook,instagram,linkedin,x,tiktok] [--dry-run]
 *
 * --asset pulls a photo/video from the group's Drive folder (DRIVE_ASSETS_FOLDER_ID_<GROUP>),
 * converts it (HEIC→JPEG, HEVC/MOV→MP4) via prepare-asset.ts, and auto-wires it: the local
 * file goes to Facebook (--source upload) and the public HTTPS URL goes to Instagram/TikTok.
 *
 * Reuses the existing single-platform posters in this directory. "Connected" is
 * detected by checking the SAME resolved env vars each poster reads, so the
 * receipt matches what would actually happen.
 *
 * Always exits 0 so the caller (Andy) always receives the full receipt.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

type Status = 'posted' | 'not_connected' | 'skipped' | 'error' | 'dry_run';

interface Result {
  platform: string;
  status: Status;
  detail?: string;
  postId?: string;
}

interface Args {
  group: 'snak' | 'sheridan';
  message: string;
  asset?: string;
  image?: string;
  source?: string;
  link?: string;
  video?: string;
  placeId?: string;
  platforms?: string[];
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const r: Record<string, string> = {};
  const dryRun = argv.includes('--dry-run');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') continue;
    if (a.startsWith('--') && i + 1 < argv.length) r[a.slice(2)] = argv[++i];
  }

  const group = (r.group || '').toLowerCase();
  if (group !== 'snak' && group !== 'sheridan') {
    console.error('Usage: post-all --group snak|sheridan --message "text" [--image url] [--source file] [--link url] [--video url] [--platforms a,b] [--dry-run]');
    process.exit(1);
  }
  if (!r.message) {
    console.error('Error: --message is required.');
    process.exit(1);
  }

  return {
    group: group as 'snak' | 'sheridan',
    message: r.message,
    asset: r.asset,
    image: r.image,
    source: r.source,
    link: r.link,
    video: r.video,
    placeId: r['place-id'] || r.placeId,
    platforms: r.platforms ? r.platforms.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined,
    dryRun,
  };
}

const env = process.env;
const has = (...keys: string[]): boolean => keys.every((k) => !!(env[k] && env[k]!.trim()));

interface PlatformDef {
  key: string;
  label: (groupLabel: string) => string;
  connected: () => boolean;
  /** Build the poster invocation, or return a skip reason if requirements aren't met. */
  build: (a: Args) => { script: string; args: string[] } | { skip: string };
}

const SCRIPT = (name: string) => path.join(HERE, name);

const PLATFORMS: PlatformDef[] = [
  {
    key: 'facebook',
    label: (g) => `Facebook (${g})`,
    connected: () => has('FB_PAGE_ID', 'FB_PAGE_ACCESS_TOKEN'),
    build: (a) => {
      const args = ['--message', a.message];
      if (a.source) args.push('--source', a.source);
      else if (a.image) args.push('--image', a.image);
      if (a.link) args.push('--link', a.link);
      if (a.placeId) args.push('--place-id', a.placeId);
      return { script: SCRIPT('post-facebook.ts'), args };
    },
  },
  {
    key: 'instagram',
    label: (g) => `Instagram (${g})`,
    // Token falls back to the Facebook page token, so only the account id is strictly required.
    connected: () => has('IG_ACCOUNT_ID') && (has('IG_ACCESS_TOKEN') || has('FB_PAGE_ACCESS_TOKEN')),
    build: (a) => {
      if (a.image) return { script: SCRIPT('post-instagram.ts'), args: ['--caption', a.message, '--image-url', a.image] };
      if (a.video) return { script: SCRIPT('post-instagram.ts'), args: ['--caption', a.message, '--video-url', a.video] };
      return { skip: 'needs a public image/video URL (pass --asset or --image/--video)' };
    },
  },
  {
    key: 'linkedin',
    label: () => 'LinkedIn',
    connected: () => has('LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_PERSON_URN'),
    build: (a) => {
      const args = ['--text', a.message];
      if (a.link) args.push('--link', a.link);
      return { script: SCRIPT('post-linkedin.ts'), args };
    },
  },
  {
    key: 'x',
    label: () => 'X (Twitter)',
    connected: () => has('X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'),
    build: (a) => {
      if (a.message.length > 280) return { skip: `message is ${a.message.length} chars (X limit is 280); provide a shorter post` };
      return { script: SCRIPT('post-tweet.ts'), args: ['--text', a.message] };
    },
  },
  {
    key: 'tiktok',
    label: () => 'TikTok',
    connected: () => has('TIKTOK_ACCESS_TOKEN'),
    build: (a) => {
      if (!a.video) return { skip: 'needs a public video URL (pass --video)' };
      return { script: SCRIPT('post-tiktok.ts'), args: ['--title', a.message, '--video-url', a.video] };
    },
  },
];

interface AssetInfo { kind: 'image' | 'video'; localPath: string; publicUrl: string; sourceName: string }

/**
 * Resolve --asset into a converted, platform-ready file via prepare-asset.ts.
 * Returns the staged asset, or throws with a clear message the caller surfaces.
 */
function resolveAsset(group: string, selector: string): AssetInfo {
  const isIndex = /^\d+$/.test(selector.trim());
  const selArgs = isIndex ? ['--index', selector.trim()] : ['--name', selector];
  const res = spawnSync('npx', ['tsx', SCRIPT('prepare-asset.ts'), '--group', group, ...selArgs], {
    encoding: 'utf-8', env,
  });
  const out = (res.stdout || '').trim();
  const errOut = (res.stderr || '').trim();
  let parsed: any = null;
  try { parsed = JSON.parse(out || errOut); } catch { /* non-JSON */ }
  if (res.status === 0 && parsed && parsed.status === 'success' && parsed.localPath) {
    return { kind: parsed.kind, localPath: parsed.localPath, publicUrl: parsed.publicUrl, sourceName: parsed.sourceName };
  }
  throw new Error((parsed && (parsed.error || parsed.hint)) || errOut || out || `prepare-asset exited ${res.status}`);
}

interface PosterOutcome { status: Status; postId?: string; detail?: string }

function runPoster(script: string, args: string[], dryRun: boolean): PosterOutcome {
  const argv = ['tsx', script, ...args];
  if (dryRun) argv.push('--dry-run');
  const res = spawnSync('npx', argv, { encoding: 'utf-8', env });
  const out = (res.stdout || '').trim();
  const errOut = (res.stderr || '').trim();
  let parsed: any = null;
  try { parsed = JSON.parse(out || errOut); } catch { /* non-JSON output */ }

  if (res.status === 0 && parsed && (parsed.status === 'success' || parsed.status === 'dry_run')) {
    return {
      status: parsed.status === 'dry_run' ? 'dry_run' : 'posted',
      postId: parsed.post_id || parsed.id || parsed.post_urn || undefined,
    };
  }
  const detail = (parsed && parsed.error) || errOut || out || `exited with code ${res.status}`;
  return { status: 'error', detail: String(detail).slice(0, 300) };
}

function main(): void {
  const a = parseArgs();
  const groupLabel = a.group === 'snak' ? 'Snak Group' : 'Sheridan Rentals';

  let selected = PLATFORMS;
  if (a.platforms && a.platforms.length) {
    selected = PLATFORMS.filter((p) => a.platforms!.includes(p.key));
  }

  // Resolve a Drive asset (if requested) into a local file + public URL, then auto-wire it:
  // local file → Facebook (--source upload); public URL → Instagram/TikTok.
  let assetNote: string | undefined;
  if (a.asset) {
    try {
      const asset = resolveAsset(a.group, a.asset);
      a.source = asset.localPath;
      if (asset.kind === 'video') a.video = asset.publicUrl;
      else a.image = asset.publicUrl;
      assetNote = `asset: ${asset.sourceName} (${asset.kind})`;
    } catch (err) {
      const receipt = `*Post receipt — ${groupLabel}*\n⚠️ Asset prep failed — ${(err as Error).message}\nNothing was posted.`;
      console.log(JSON.stringify({ group: a.group, dryRun: a.dryRun, assetError: (err as Error).message, results: [], receipt }, null, 2));
      return;
    }
  }

  const results: Result[] = [];
  for (const p of selected) {
    const label = p.label(groupLabel);
    if (!p.connected()) {
      results.push({ platform: label, status: 'not_connected', detail: 'platform credentials are not configured' });
      continue;
    }
    const built = p.build(a);
    if ('skip' in built) {
      results.push({ platform: label, status: 'skipped', detail: built.skip });
      continue;
    }
    const r = runPoster(built.script, built.args, a.dryRun);
    results.push({ platform: label, status: r.status, postId: r.postId, detail: r.detail });
  }

  const icon: Record<Status, string> = {
    posted: '✅',
    dry_run: '🧪',
    not_connected: '❌',
    skipped: '⏭️',
    error: '⚠️',
  };

  const lines = results.map((r) => {
    const tail = r.status === 'posted' || r.status === 'dry_run'
      ? (r.postId ? ` — ${r.postId}` : '')
      : ` — ${r.detail || r.status.replace('_', ' ')}`;
    return `${icon[r.status]} ${r.platform}${tail}`;
  });

  const posted = results.filter((r) => r.status === 'posted').length;
  const attempted = results.filter((r) => r.status !== 'not_connected' && r.status !== 'skipped').length;

  const header = assetNote ? `*Post receipt — ${groupLabel}*\n_${assetNote}_` : `*Post receipt — ${groupLabel}*`;
  const receipt = `${header}\n${lines.join('\n')}`;

  console.log(JSON.stringify({
    group: a.group,
    dryRun: a.dryRun,
    asset: assetNote || null,
    summary: { posted, attempted, total: results.length },
    results,
    receipt,
  }, null, 2));
  // Always exit 0: the receipt itself is the deliverable, even on partial failure.
}

main();
