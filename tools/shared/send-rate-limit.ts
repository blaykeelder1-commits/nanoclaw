/**
 * Shared email send rate limiter for NanoClaw tools.
 * Enforces a daily send limit across Gmail and SMTP tools.
 *
 * Uses a file-based counter at /tmp/.nanoclaw-send-count-YYYY-MM-DD.
 * Each tool calls checkAndIncrementSendCount() before sending.
 * The file resets naturally each day (new date = new filename).
 */

import fs from 'fs';
import path from 'path';

const DAILY_SEND_LIMIT = parseInt(process.env.NANOCLAW_DAILY_SEND_LIMIT || '20', 10);

function getCounterPath(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join('/tmp', `.nanoclaw-send-count-${today}`);
}

function readCount(): number {
  try {
    const data = fs.readFileSync(getCounterPath(), 'utf-8').trim();
    return parseInt(data, 10) || 0;
  } catch {
    return 0;
  }
}

function writeCount(count: number): void {
  fs.writeFileSync(getCounterPath(), String(count), 'utf-8');
}

/**
 * Check if we're under the daily send limit. If yes, increment and return.
 * If no, throw with a clear error message.
 */
export function checkAndIncrementSendCount(): void {
  const current = readCount();
  if (current >= DAILY_SEND_LIMIT) {
    throw new Error(
      `Daily email send limit reached (${DAILY_SEND_LIMIT}/day). ` +
      `${current} emails already sent today. ` +
      `This limit protects against runaway sends and domain blacklisting. ` +
      `The limit resets at midnight UTC. ` +
      `To adjust, set NANOCLAW_DAILY_SEND_LIMIT in .env.`
    );
  }
  writeCount(current + 1);
}

/**
 * Get current send count and limit for informational purposes.
 */
export function getSendStatus(): { sent: number; limit: number; remaining: number } {
  const sent = readCount();
  return { sent, limit: DAILY_SEND_LIMIT, remaining: Math.max(0, DAILY_SEND_LIMIT - sent) };
}
