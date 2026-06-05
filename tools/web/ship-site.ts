#!/usr/bin/env npx tsx
/**
 * ship-site.ts — Edit + ship whitelisted business websites from NanoClaw (Andy).
 *
 * Preview-first protocol (prod NEVER changes without an explicit promote):
 *   1) start    — clean-sync the repo checkout to origin/<prodBranch>, print its path.
 *                 Andy then edits files in that path with Read/Edit.
 *   2) preview  — commit the edits to a local preview branch, build, deploy a
 *                 Cloudflare Pages PREVIEW, and record pending state. Prints the
 *                 preview URL. Prod git + prod CF env are untouched.
 *   3) promote  — fast-forward prod branch to the previewed commit, push, build,
 *                 deploy PROD, and verify the live URL returns 200. Prints the
 *                 live URL. (Run only after Blayke replies "approve".)
 *   4) discard  — throw the pending edit away and reset the checkout.
 *
 * Every command prints a single JSON receipt and exits non-zero on ANY failure,
 * so a silent "looks done but nothing shipped" outcome is impossible. Relay the
 * receipt verbatim — never claim success without `verified: true` + a live URL.
 *
 * Usage:
 *   npx tsx tools/web/ship-site.ts list
 *   npx tsx tools/web/ship-site.ts status <site>
 *   npx tsx tools/web/ship-site.ts start <site>
 *   npx tsx tools/web/ship-site.ts preview <site> -m "what changed"
 *   npx tsx tools/web/ship-site.ts promote <site>
 *   npx tsx tools/web/ship-site.ts discard <site>
 *
 * Env:
 *   GITHUB_TOKEN           — PAT with contents R/W on the whitelisted repos
 *   CLOUDFLARE_API_TOKEN   — snakgroupteam account, Pages:Edit
 *   CLOUDFLARE_ACCOUNT_ID  — snakgroupteam account id
 *   SITES_DIR              — checkout root (default: ~/sites)
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Site {
  label: string;
  owner: string;
  repo: string;
  prodBranch: string;
  build: string;
  deployDir: string;
  cfProject: string;
  liveUrl: string;
}

interface Pending {
  site: string;
  branch: string;
  sha: string;
  message: string;
  previewUrl: string;
  files: string[];
  createdAt: string;
}

const SITES: Record<string, Site> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf-8'),
);

const SITES_DIR =
  process.env.SITES_DIR || path.join(os.homedir(), 'sites');
const PENDING_DIR = path.join(SITES_DIR, '.pending');
const STAGE_DIR = path.join(SITES_DIR, '.stage');

const GIT_AUTHOR = ['-c', 'user.name=Andy (NanoClaw)', '-c', 'user.email=andy@snakgroup.biz'];

// Top-level entries never uploaded to Pages when deployDir is the repo root.
const DEPLOY_DENYLIST = new Set([
  'node_modules', '.git', '.github', 'src', '.wrangler', '.gitignore',
  'package.json', 'package-lock.json', 'README.md',
]);

// ── helpers ──────────────────────────────────────────────────────────

/** Replace secret values with *** so they never reach stdout/logs. */
function scrub(s: string): string {
  for (const key of ['GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    const v = process.env[key];
    if (v) s = s.split(v).join('***');
  }
  return s;
}

class ShipError extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
  }
}

/** Run a command, returning trimmed stdout. Throws ShipError with scrubbed stderr on failure. */
function run(file: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = (e.stderr?.toString() || '') + (e.stdout?.toString() || '');
    throw new ShipError(
      `command failed: ${file} ${args.join(' ')}`,
      scrub(stderr.trim() || e.message || 'unknown error'),
    );
  }
}

/** Run a shell build string (may contain &&) inside the checkout. */
function runShell(cmd: string, cwd: string): string {
  return run('bash', ['-lc', cmd], cwd);
}

function getSite(name: string): Site {
  const site = SITES[name];
  if (!site) {
    throw new ShipError(
      `unknown site "${name}". Known sites: ${Object.keys(SITES).join(', ')}`,
    );
  }
  return site;
}

function checkoutPath(site: Site): string {
  return path.join(SITES_DIR, site.repo);
}

function authedRemote(site: Site): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new ShipError('GITHUB_TOKEN is not set');
  return `https://x-access-token:${token}@github.com/${site.owner}/${site.repo}.git`;
}

function requireCloudflareEnv(): void {
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!process.env[key]) throw new ShipError(`${key} is not set`);
  }
}

function pendingPath(name: string): string {
  return path.join(PENDING_DIR, `${name}.json`);
}

function readPending(name: string): Pending | null {
  try {
    return JSON.parse(fs.readFileSync(pendingPath(name), 'utf-8')) as Pending;
  } catch {
    return null;
  }
}

function writePending(p: Pending): void {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(pendingPath(p.site), JSON.stringify(p, null, 2));
}

function clearPending(name: string): void {
  try { fs.unlinkSync(pendingPath(name)); } catch { /* already gone */ }
}

/** Clone if missing, otherwise hard-reset the checkout to origin/<prodBranch>. */
function ensureCleanCheckout(site: Site): string {
  const dir = checkoutPath(site);
  const remote = authedRemote(site);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(SITES_DIR, { recursive: true });
    run('git', ['clone', '--branch', site.prodBranch, remote, dir]);
  } else {
    run('git', ['remote', 'set-url', 'origin', remote], dir);
    run('git', ['fetch', 'origin', site.prodBranch], dir);
    run('git', ['checkout', site.prodBranch], dir);
    run('git', ['reset', '--hard', `origin/${site.prodBranch}`], dir);
    run('git', ['clean', '-fd'], dir);
  }
  return dir;
}

/** Recursively copy a directory, skipping a denylist of top-level entries. */
function copyDir(src: string, dst: string, skipTop?: Set<string>): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipTop?.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) { /* skip symlinks */ }
    else fs.copyFileSync(s, d);
  }
}

/**
 * Produce the directory of static assets to upload.
 * deployDir === '.' → stage the repo root minus the denylist (no node_modules).
 * deployDir !== '.' → the build output dir itself (already clean).
 */
function resolveUploadDir(site: Site, checkout: string): string {
  if (site.deployDir !== '.') {
    const out = path.join(checkout, site.deployDir);
    if (!fs.existsSync(out)) {
      throw new ShipError(`build output dir not found: ${site.deployDir} (did the build run?)`);
    }
    return out;
  }
  const stage = path.join(STAGE_DIR, site.repo);
  fs.rmSync(stage, { recursive: true, force: true });
  copyDir(checkout, stage, DEPLOY_DENYLIST);
  return stage;
}

/** Deploy a directory to a Cloudflare Pages branch; return the preview/prod URL. */
function wranglerDeploy(site: Site, uploadDir: string, branch: string): string {
  requireCloudflareEnv();
  const out = run('npx', [
    '--yes', 'wrangler', 'pages', 'deploy', uploadDir,
    '--project-name', site.cfProject,
    '--branch', branch,
    '--commit-dirty=true',
  ]);
  // Wrangler prints e.g. "Take a peek over at https://<hash>.<project>.pages.dev"
  const matches = out.match(/https:\/\/[^\s]*\.pages\.dev[^\s]*/g);
  if (!matches || matches.length === 0) {
    throw new ShipError('deploy succeeded but no pages.dev URL found in wrangler output', scrub(out));
  }
  return matches[matches.length - 1];
}

/** Fetch the live URL, retrying for CF propagation. Resolves to the final status code. */
async function verifyLive(url: string): Promise<number> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'cache-control': 'no-cache' },
      });
      lastStatus = res.status;
      if (res.ok) return res.status;
    } catch {
      lastStatus = 0;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return lastStatus;
}

function emit(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ status: 'ok', ...obj }, null, 2));
}

// ── commands ─────────────────────────────────────────────────────────

function cmdList(): void {
  const sites = Object.entries(SITES).map(([key, s]) => ({
    site: key,
    label: s.label,
    liveUrl: s.liveUrl,
    pending: !!readPending(key),
  }));
  emit({ action: 'list', sites });
}

function cmdStatus(name: string): void {
  getSite(name);
  const pending = readPending(name);
  emit({ action: 'status', site: name, pending: pending || null });
}

function cmdStart(name: string): void {
  const site = getSite(name);
  const dir = ensureCleanCheckout(site);
  emit({
    action: 'start',
    site: name,
    label: site.label,
    path: dir,
    prodBranch: site.prodBranch,
    instructions: `Edit files under ${dir} with Read/Edit, then run: preview ${name} -m "<summary>"`,
  });
}

function cmdPreview(name: string, message: string): void {
  const site = getSite(name);
  if (!message) throw new ShipError('a -m "<summary>" message is required');
  const dir = checkoutPath(site);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    throw new ShipError(`no checkout for "${name}" — run: start ${name}`);
  }

  const changed = run('git', ['status', '--porcelain'], dir);
  if (!changed) {
    throw new ShipError(`no edits to preview for "${name}" — edit files under ${dir} first`);
  }
  const files = changed.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const branch = `preview-${ts}`;
  run('git', ['checkout', '-b', branch], dir);
  run('git', ['add', '-A'], dir);
  run('git', [...GIT_AUTHOR, 'commit', '-m', message], dir);
  const sha = run('git', ['rev-parse', 'HEAD'], dir);

  runShell(site.build, dir);
  const uploadDir = resolveUploadDir(site, dir);
  const previewUrl = wranglerDeploy(site, uploadDir, branch);

  // Leave the preview branch in place for promote; return to a clean prod branch.
  run('git', ['checkout', site.prodBranch], dir);

  writePending({
    site: name, branch, sha, message, previewUrl, files,
    createdAt: new Date().toISOString(),
  });

  emit({
    action: 'preview',
    site: name,
    previewUrl,
    commit: sha.slice(0, 7),
    files,
    message,
    next: `Reply "approve ${name}" to ship to prod, or "discard ${name}" to throw it away.`,
  });
}

async function cmdPromote(name: string): Promise<void> {
  const site = getSite(name);
  const pending = readPending(name);
  if (!pending) {
    throw new ShipError(`nothing to promote for "${name}" — run preview first`);
  }
  const dir = checkoutPath(site);
  const remote = authedRemote(site);

  // Sync prod branch, then fast-forward it to the previewed commit.
  run('git', ['remote', 'set-url', 'origin', remote], dir);
  run('git', ['fetch', 'origin', site.prodBranch], dir);
  run('git', ['checkout', site.prodBranch], dir);
  run('git', ['reset', '--hard', `origin/${site.prodBranch}`], dir);
  try {
    run('git', ['merge', '--ff-only', pending.sha], dir);
  } catch {
    throw new ShipError(
      `${site.prodBranch} moved on since preview — cannot fast-forward. Re-run start + preview to rebase on the latest.`,
    );
  }
  run('git', ['push', 'origin', site.prodBranch], dir);

  runShell(site.build, dir);
  const uploadDir = resolveUploadDir(site, dir);
  wranglerDeploy(site, uploadDir, site.prodBranch);

  const httpStatus = await verifyLive(site.liveUrl);
  const verified = httpStatus >= 200 && httpStatus < 400;

  // Clean up the local preview branch + pending state.
  try { run('git', ['branch', '-D', pending.branch], dir); } catch { /* ignore */ }
  clearPending(name);

  if (!verified) {
    throw new ShipError(
      `deployed to prod but live check did not return 2xx (got ${httpStatus || 'no response'}) for ${site.liveUrl}`,
    );
  }

  emit({
    action: 'promote',
    site: name,
    liveUrl: site.liveUrl,
    commit: pending.sha.slice(0, 7),
    httpStatus,
    verified: true,
  });
}

function cmdDiscard(name: string): void {
  const site = getSite(name);
  const pending = readPending(name);
  const dir = checkoutPath(site);
  if (fs.existsSync(path.join(dir, '.git'))) {
    run('git', ['checkout', site.prodBranch], dir);
    run('git', ['reset', '--hard', `origin/${site.prodBranch}`], dir);
    run('git', ['clean', '-fd'], dir);
    if (pending?.branch) {
      try { run('git', ['branch', '-D', pending.branch], dir); } catch { /* ignore */ }
    }
  }
  clearPending(name);
  emit({ action: 'discard', site: name, discarded: pending?.commit ?? pending?.sha?.slice(0, 7) ?? null });
}

// ── entry ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const action = argv[0];
  const site = argv[1];

  // Parse -m/--message
  let message = '';
  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === '-m' || argv[i] === '--message') && i + 1 < argv.length) {
      message = argv[++i];
    }
  }

  switch (action) {
    case 'list': return cmdList();
    case 'status': return cmdStatus(site);
    case 'start': return cmdStart(site);
    case 'preview': return cmdPreview(site, message);
    case 'promote': return cmdPromote(site);
    case 'discard': return cmdDiscard(site);
    default:
      throw new ShipError(
        `unknown action "${action ?? ''}". Use: list | status | start | preview | promote | discard`,
      );
  }
}

main().catch((err) => {
  const e = err as ShipError;
  console.log(JSON.stringify({
    status: 'error',
    error: scrub(e.message || String(err)),
    detail: e.detail ? scrub(e.detail) : undefined,
  }, null, 2));
  process.exit(1);
});
