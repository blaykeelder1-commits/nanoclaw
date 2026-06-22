#!/usr/bin/env npx tsx
/**
 * prepare-asset.ts — Pull a marketing asset from a group's Drive folder, convert
 * it to a platform-ready format, and stage it as BOTH a local file (for
 * Facebook's multipart --source upload) and a public HTTPS URL (required by the
 * Instagram / TikTok APIs, which fetch media from a URL).
 *
 * iPhone assets are HEIC photos and HEVC/MOV video, which Facebook and Instagram
 * reject. This converts:
 *   HEIC / HEIF            → JPEG   (heif-convert)
 *   MOV / non-h264 video   → MP4 h264/aac (ffmpeg; remux if already h264)
 *   JPEG / PNG / MP4 h264  → passed through unchanged
 *
 * Usage:
 *   prepare-asset --group snak --list
 *   prepare-asset --group snak --index 1
 *   prepare-asset --group snak --name IMG_3974
 *   prepare-asset --group snak --file-id <driveFileId>
 *
 * Output (stdout JSON):
 *   { status, kind: 'image'|'video', localPath, publicUrl, mimeType, sourceName, sourceId }
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_KEY          service account JSON (folder must be shared with it)
 *   DRIVE_ASSETS_FOLDER_ID_<GROUP>      e.g. DRIVE_ASSETS_FOLDER_ID_SNAK
 *   ASSET_PUBLIC_DIR                    default /home/nanoclaw/nanoclaw/public-assets
 *   ASSET_PUBLIC_BASE_URL              default https://chat.snakgroup.biz/assets
 */

import { google, drive_v3 } from 'googleapis';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface Args {
  group: string;
  list: boolean;
  index?: number;
  name?: string;
  fileId?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const r: Record<string, string> = {};
  const list = argv.includes('--list');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') continue;
    if (a.startsWith('--') && i + 1 < argv.length) r[a.slice(2)] = argv[++i];
  }
  const group = (r.group || '').toLowerCase();
  if (!group) {
    fail('Usage: prepare-asset --group snak [--list | --index N | --name STR | --file-id ID]');
  }
  return {
    group,
    list,
    index: r.index ? parseInt(r.index, 10) : undefined,
    name: r.name,
    fileId: r['file-id'],
  };
}

function fail(error: string, hint?: string): never {
  console.error(JSON.stringify({ status: 'error', error, ...(hint ? { hint } : {}) }));
  process.exit(1);
}

function getDrive(): drive_v3.Drive {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) fail('Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable.');
  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    return fail('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.');
  }
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  modifiedTime: string;
}

async function listFolder(drive: drive_v3.Drive, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `trashed = false and '${folderId}' in parents`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      files.push({
        id: f.id || '',
        name: f.name || '',
        mimeType: f.mimeType || '',
        size: f.size || '0',
        modifiedTime: f.modifiedTime || '',
      });
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  // Stable order so --index is deterministic across runs.
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

async function download(drive: drive_v3.Drive, fileId: string, dest: string): Promise<void> {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  fs.writeFileSync(dest, Buffer.from(res.data as ArrayBuffer));
}

function run(cmd: string, args: string[]): { ok: boolean; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: 'utf-8' });
  return { ok: res.status === 0, stderr: (res.stderr || '').trim() };
}

function extFor(name: string): string {
  return path.extname(name).toLowerCase();
}

/** Convert an image to a Facebook/Instagram-safe JPEG if needed. Returns the final path. */
function ensureImage(srcPath: string, mimeType: string, outBase: string): string {
  const ext = extFor(srcPath);
  const isHeic = /heif|heic/.test(mimeType) || ext === '.heic' || ext === '.heif';
  if (!isHeic && /^image\/(jpeg|png|webp)$/.test(mimeType)) {
    return srcPath; // already postable
  }
  if (isHeic) {
    const out = `${outBase}.jpg`;
    const { ok, stderr } = run('heif-convert', ['-q', '90', srcPath, out]);
    if (!ok || !fs.existsSync(out)) fail(`HEIC→JPEG conversion failed: ${stderr || 'no output'}`);
    return out;
  }
  // Unknown image type — try a generic ffmpeg transcode to jpeg.
  const out = `${outBase}.jpg`;
  const { ok, stderr } = run('ffmpeg', ['-y', '-i', srcPath, out]);
  if (!ok || !fs.existsSync(out)) fail(`image conversion failed for ${mimeType}: ${stderr || 'no output'}`);
  return out;
}

/** Ensure a video is MP4 (h264/aac). Remux when the codec is already h264, else re-encode. */
function ensureVideo(srcPath: string, outBase: string): string {
  const out = `${outBase}.mp4`;
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', srcPath,
  ], { encoding: 'utf-8' });
  const codec = (probe.stdout || '').trim().toLowerCase();

  if (codec === 'h264') {
    // Fast path: just repackage into a faststart MP4 container.
    const remux = run('ffmpeg', ['-y', '-i', srcPath, '-c', 'copy', '-movflags', '+faststart', out]);
    if (remux.ok && fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  }
  // Re-encode (covers HEVC/h265 from newer iPhones, or a failed remux).
  const enc = run('ffmpeg', [
    '-y', '-i', srcPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
  ]);
  if (!enc.ok || !fs.existsSync(out)) fail(`video conversion to MP4 failed: ${enc.stderr || 'no output'}`);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const folderKey = `DRIVE_ASSETS_FOLDER_ID_${args.group.toUpperCase()}`;
  const folderId = process.env[folderKey];
  if (!folderId) {
    fail(`Missing ${folderKey} in environment.`,
      `Add ${folderKey}=<driveFolderId> to .env (the folder must be shared with the service account).`);
  }

  const publicDir = process.env.ASSET_PUBLIC_DIR || '/home/nanoclaw/nanoclaw/public-assets';
  const baseUrl = (process.env.ASSET_PUBLIC_BASE_URL || 'https://chat.snakgroup.biz/assets').replace(/\/$/, '');

  const drive = getDrive();
  const files = await listFolder(drive, folderId);

  if (args.list || (!args.index && !args.name && !args.fileId)) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'list',
      group: args.group,
      folderId,
      count: files.length,
      assets: files.map((f, i) => ({
        index: i + 1,
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        kind: f.mimeType.startsWith('video/') ? 'video' : 'image',
        sizeMB: (parseInt(f.size, 10) / 1e6).toFixed(2),
      })),
    }, null, 2));
    return;
  }

  // Select the asset.
  let chosen: DriveFile | undefined;
  if (args.fileId) chosen = files.find((f) => f.id === args.fileId);
  else if (args.index) chosen = files[args.index - 1];
  else if (args.name) {
    const q = args.name.toLowerCase();
    chosen = files.find((f) => f.name.toLowerCase().includes(q));
  }
  if (!chosen) {
    fail('No matching asset found in the folder.',
      `Available: ${files.map((f, i) => `[${i + 1}] ${f.name}`).join(', ') || '(empty folder)'}`);
  }

  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  const isVideo = chosen.mimeType.startsWith('video/');

  // Idempotent cache: if this Drive id was already converted+staged, reuse it
  // (stable id-based names) instead of re-downloading and re-converting.
  const cached = fs.readdirSync(publicDir).find((f) => f.startsWith(`${chosen.id}.`));
  if (cached) {
    const ext = path.extname(cached);
    console.log(JSON.stringify({
      status: 'success',
      kind: isVideo ? 'video' : 'image',
      cached: true,
      localPath: path.join(publicDir, cached),
      publicUrl: `${baseUrl}/${cached}`,
      mimeType: ext === '.jpg' ? 'image/jpeg' : ext === '.mp4' ? 'video/mp4' : chosen.mimeType,
      sourceName: chosen.name,
      sourceId: chosen.id,
    }));
    return;
  }

  // Per-run private temp dir avoids cross-user /tmp collisions; only the final
  // public file uses a stable (Drive id) name so repeat runs dedupe and URLs stay stable.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-'));
  const tmpSrc = path.join(work, `src${extFor(chosen.name) || ''}`);
  await download(drive, chosen.id, tmpSrc);

  const stageBase = path.join(work, 'out');
  const finalLocal = isVideo
    ? ensureVideo(tmpSrc, stageBase)
    : ensureImage(tmpSrc, chosen.mimeType, stageBase);

  // Stage into the public web root under an opaque, stable name (Drive id + ext).
  const publicName = `${chosen.id}${path.extname(finalLocal)}`;
  const publicPath = path.join(publicDir, publicName);
  fs.copyFileSync(finalLocal, publicPath);

  fs.rmSync(work, { recursive: true, force: true });

  const finalMime = path.extname(finalLocal) === '.jpg' ? 'image/jpeg'
    : path.extname(finalLocal) === '.mp4' ? 'video/mp4'
    : chosen.mimeType;

  console.log(JSON.stringify({
    status: 'success',
    kind: isVideo ? 'video' : 'image',
    localPath: publicPath,
    publicUrl: `${baseUrl}/${publicName}`,
    mimeType: finalMime,
    sourceName: chosen.name,
    sourceId: chosen.id,
  }));
}

main().catch((err: unknown) => {
  const error = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: number })?.code;
  if (code === 401 || code === 403) {
    fail(error, 'Drive returned 401/403. Verify the Drive API is enabled and the folder is shared with the service account email.');
  }
  fail(error);
});
