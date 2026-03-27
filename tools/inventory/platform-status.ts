#!/usr/bin/env npx tsx
/**
 * Platform Status Tracker for NanoClaw
 *
 * Tracks last success/failure for each vending data platform.
 * Used by the vending inventory skill to monitor persistent failures.
 *
 * Usage:
 *   npx tsx tools/inventory/platform-status.ts get
 *   npx tsx tools/inventory/platform-status.ts update --platform hahavending --status success
 *   npx tsx tools/inventory/platform-status.ts update --platform vendera --status failure --error "Login timeout"
 *   npx tsx tools/inventory/platform-status.ts update --platform iddi --status success
 */

import fs from 'fs';
import path from 'path';
import { resolveGroupDir } from '../shared/group-path.js';

type Action = 'get' | 'update';
type PlatformName = 'hahavending' | 'vendera' | 'iddi';

interface PlatformEntry {
  last_status: 'success' | 'failure' | 'unknown';
  last_success: string | null;
  last_failure: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

interface PlatformStatusFile {
  hahavending: PlatformEntry;
  vendera: PlatformEntry;
  iddi: PlatformEntry;
  updated_at: string;
}

function getStatusFile(): string {
  return path.join(resolveGroupDir(), 'platform-status.json');
}

function defaultEntry(): PlatformEntry {
  return {
    last_status: 'unknown',
    last_success: null,
    last_failure: null,
    last_error: null,
    consecutive_failures: 0,
  };
}

function readStatus(): PlatformStatusFile {
  const file = getStatusFile();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {
      hahavending: defaultEntry(),
      vendera: defaultEntry(),
      iddi: defaultEntry(),
      updated_at: new Date().toISOString(),
    };
  }
}

function writeStatus(status: PlatformStatusFile): void {
  status.updated_at = new Date().toISOString();
  fs.writeFileSync(getStatusFile(), JSON.stringify(status, null, 2));
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }
  return { action, flags };
}

const { action, flags } = parseArgs();

if (action === 'get') {
  const status = readStatus();
  console.log(JSON.stringify(status, null, 2));
} else if (action === 'update') {
  const platform = flags.platform as PlatformName;
  const statusValue = flags.status as 'success' | 'failure';

  if (!platform || !['hahavending', 'vendera', 'iddi'].includes(platform)) {
    console.error(JSON.stringify({ status: 'error', error: 'Invalid --platform. Use: hahavending, vendera, iddi' }));
    process.exit(1);
  }
  if (!statusValue || !['success', 'failure'].includes(statusValue)) {
    console.error(JSON.stringify({ status: 'error', error: 'Invalid --status. Use: success, failure' }));
    process.exit(1);
  }

  const data = readStatus();
  const entry = data[platform];
  const now = new Date().toISOString();

  if (statusValue === 'success') {
    entry.last_status = 'success';
    entry.last_success = now;
    entry.consecutive_failures = 0;
    entry.last_error = null;
  } else {
    entry.last_status = 'failure';
    entry.last_failure = now;
    entry.consecutive_failures += 1;
    entry.last_error = flags.error || null;
  }

  writeStatus(data);
  console.log(JSON.stringify({ status: 'success', platform, updated: entry }));
} else {
  console.error(JSON.stringify({
    status: 'error',
    error: 'Unknown action. Use: get, update',
    usage: [
      'npx tsx tools/inventory/platform-status.ts get',
      'npx tsx tools/inventory/platform-status.ts update --platform hahavending --status success',
      'npx tsx tools/inventory/platform-status.ts update --platform vendera --status failure --error "Login timeout"',
    ],
  }));
  process.exit(1);
}
