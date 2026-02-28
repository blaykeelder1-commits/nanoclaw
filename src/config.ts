import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'QUO_API_KEY',
  'QUO_SNAK_PHONE_ID',
  'QUO_SNAK_NUMBER',
  'QUO_SHERIDAN_PHONE_ID',
  'QUO_SHERIDAN_NUMBER',
  'QUO_WEBHOOK_PORT',
  'GROQ_API_KEY',
  'WEB_CHANNEL_PORT',
  'WEB_CHANNEL_ORIGINS',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_LOCATION_ID',
  'SQUARE_ENVIRONMENT',
  'FB_PAGE_ACCESS_TOKEN',
  'FB_APP_SECRET',
  'FB_VERIFY_TOKEN',
  'FB_PAGE_ID',
  'FB_MESSENGER_PORT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '300000', 10); // 5min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- Quo Phone (OpenPhone) SMS Channel ---
export const QUO_API_KEY =
  process.env.QUO_API_KEY || envConfig.QUO_API_KEY || '';
export const QUO_SNAK_PHONE_ID =
  process.env.QUO_SNAK_PHONE_ID || envConfig.QUO_SNAK_PHONE_ID || '';
export const QUO_SNAK_NUMBER =
  process.env.QUO_SNAK_NUMBER || envConfig.QUO_SNAK_NUMBER || '+16822551033';
export const QUO_SHERIDAN_PHONE_ID =
  process.env.QUO_SHERIDAN_PHONE_ID || envConfig.QUO_SHERIDAN_PHONE_ID || '';
export const QUO_SHERIDAN_NUMBER =
  process.env.QUO_SHERIDAN_NUMBER ||
  envConfig.QUO_SHERIDAN_NUMBER ||
  '+18175871460';
export const QUO_WEBHOOK_PORT = parseInt(
  process.env.QUO_WEBHOOK_PORT || envConfig.QUO_WEBHOOK_PORT || '3100',
  10,
);

// --- Model routing & budget ---
// Scheduled/background tasks use Haiku for cost efficiency
// Interactive messages use Sonnet for quality
export const MODEL_SCHEDULED =
  process.env.MODEL_SCHEDULED || 'claude-haiku-4-5';
export const MODEL_INTERACTIVE =
  process.env.MODEL_INTERACTIVE || 'claude-sonnet-4-6';
// Per-query USD budget caps (0 = no cap)
export const BUDGET_SCHEDULED = parseFloat(
  process.env.BUDGET_SCHEDULED || '0.05',
);
export const BUDGET_SCHEDULED_HEAVY = parseFloat(
  process.env.BUDGET_SCHEDULED_HEAVY || '0.50',
);
export const BUDGET_INTERACTIVE = parseFloat(
  process.env.BUDGET_INTERACTIVE || '0.50',
);

// --- Web Channel (Socket.IO chat widget) ---
export const WEB_CHANNEL_PORT = parseInt(
  process.env.WEB_CHANNEL_PORT || '3200',
  10,
);
export const WEB_CHANNEL_ORIGINS = (
  process.env.WEB_CHANNEL_ORIGINS ||
  'https://snakgroup.biz,https://www.snakgroup.biz'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// --- Groq (voice transcription) ---
export const GROQ_API_KEY =
  process.env.GROQ_API_KEY || envConfig.GROQ_API_KEY || '';

// --- Web Chat Channel ---
export const WEB_CHANNEL_PORT = parseInt(
  process.env.WEB_CHANNEL_PORT || envConfig.WEB_CHANNEL_PORT || '3200',
  10,
);
export const WEB_CHANNEL_ORIGINS =
  process.env.WEB_CHANNEL_ORIGINS ||
  envConfig.WEB_CHANNEL_ORIGINS ||
  'https://sheridanrentals.us,https://www.sheridanrentals.us,https://sheridantrailerrentals.us,https://www.sheridantrailerrentals.us';

export const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN ||
  envConfig.SQUARE_ACCESS_TOKEN ||
  '';
export const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID ||
  envConfig.SQUARE_LOCATION_ID ||
  '';
export const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT ||
  envConfig.SQUARE_ENVIRONMENT ||
  'production';

// --- Facebook Messenger Channel ---
export const FB_PAGE_ACCESS_TOKEN =
  process.env.FB_PAGE_ACCESS_TOKEN ||
  envConfig.FB_PAGE_ACCESS_TOKEN ||
  '';
export const FB_APP_SECRET =
  process.env.FB_APP_SECRET ||
  envConfig.FB_APP_SECRET ||
  '';
export const FB_VERIFY_TOKEN =
  process.env.FB_VERIFY_TOKEN ||
  envConfig.FB_VERIFY_TOKEN ||
  '';
export const FB_PAGE_ID =
  process.env.FB_PAGE_ID ||
  envConfig.FB_PAGE_ID ||
  '';
export const FB_MESSENGER_PORT = parseInt(
  process.env.FB_MESSENGER_PORT || envConfig.FB_MESSENGER_PORT || '3300',
  10,
);

// --- Gmail (IMAP) Channel ---
const emailEnvConfig = readEnvFile([
  'IMAP_HOST',
  'IMAP_PORT',
  'IMAP_USER',
  'IMAP_PASS',
  'EMAIL_SNAK_ADDRESS',
  'EMAIL_SNAK_GROUP',
  'GMAIL_POLL_INTERVAL',
]);

export const IMAP_HOST =
  process.env.IMAP_HOST || emailEnvConfig.IMAP_HOST || '';
export const IMAP_PORT = parseInt(
  process.env.IMAP_PORT || emailEnvConfig.IMAP_PORT || '993',
  10,
);
export const IMAP_USER =
  process.env.IMAP_USER || emailEnvConfig.IMAP_USER || '';
export const IMAP_PASS =
  process.env.IMAP_PASS || emailEnvConfig.IMAP_PASS || '';
export const EMAIL_SNAK_ADDRESS =
  process.env.EMAIL_SNAK_ADDRESS || emailEnvConfig.EMAIL_SNAK_ADDRESS || '';
export const EMAIL_SNAK_GROUP =
  process.env.EMAIL_SNAK_GROUP || emailEnvConfig.EMAIL_SNAK_GROUP || 'snak-group';
export const GMAIL_POLL_INTERVAL = parseInt(
  process.env.GMAIL_POLL_INTERVAL || emailEnvConfig.GMAIL_POLL_INTERVAL || '90000',
  10,
);

// --- Spend Protection ---
export const MAX_DAILY_SPEND_USD = parseFloat(
  process.env.MAX_DAILY_SPEND_USD || '10.00',
);
