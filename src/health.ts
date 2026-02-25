import fs from 'fs';
import path from 'path';

import { DATA_DIR, HEALTH_CHECK_INTERVAL, MAIN_GROUP_FOLDER, STORE_DIR } from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { getHealthState, getLastMessageTimestamp, setHealthState } from './db.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

export interface HealthMonitorDeps {
  channels: Channel[];
  sendAlert: (jid: string, text: string) => Promise<void>;
  getMainGroupJid: () => string | null;
}

interface HealthSnapshot {
  timestamp: string;
  status: 'ok' | 'warning' | 'critical';
  whatsapp: {
    connected: boolean;
    lastConnectedAt: string | null;
    recentDisconnects: number;
    protocolErrorCount: number;
  };
  lastMessageAt: string | null;
  authPresent: boolean;
  uptimeMinutes: number;
}

const startTime = Date.now();
let alertedCriticalAt: number | null = null;

function getWhatsAppChannel(channels: Channel[]): WhatsAppChannel | null {
  return (channels.find((c) => c.name === 'whatsapp') as WhatsAppChannel) || null;
}

function checkAuthState(): boolean {
  const authDir = path.join(STORE_DIR, 'auth');
  try {
    const files = fs.readdirSync(authDir);
    return files.length > 0;
  } catch {
    return false;
  }
}

function isActiveHours(): boolean {
  const hour = new Date().getHours();
  return hour >= 8 && hour <= 22;
}

async function runHealthCheck(deps: HealthMonitorDeps): Promise<void> {
  const wa = getWhatsAppChannel(deps.channels);
  const healthInfo = wa?.getHealthInfo() ?? {
    connected: false,
    lastConnectedAt: null,
    recentDisconnects: [],
    protocolErrorCount: 0,
  };

  let status: 'ok' | 'warning' | 'critical' = 'ok';
  const issues: string[] = [];

  // Check 1: WA Connection + protocol error loop detection
  if (!healthInfo.connected) {
    status = 'warning';
    issues.push('WhatsApp disconnected');
  }

  if (healthInfo.protocolErrorCount >= 3 && wa) {
    status = 'critical';
    issues.push(`Protocol error loop detected (${healthInfo.protocolErrorCount} errors in 10 min) — forcing reconnect`);
    logger.warn({ protocolErrorCount: healthInfo.protocolErrorCount }, 'Protocol error loop — triggering force reconnect');
    try {
      await wa.forceReconnect();
      issues.push('Force reconnect initiated');
    } catch (err) {
      logger.error({ err }, 'Force reconnect failed');
      issues.push('Force reconnect failed');
    }
  }

  // Check 2: Message silence (only during active hours)
  const lastMsgTs = getLastMessageTimestamp();
  if (lastMsgTs && isActiveHours()) {
    const silenceMs = Date.now() - new Date(lastMsgTs).getTime();
    const silenceHours = silenceMs / (1000 * 60 * 60);
    if (silenceHours >= 6) {
      if (status === 'ok') status = 'warning';
      issues.push(`No messages in ${silenceHours.toFixed(1)} hours`);
    }
  }

  // Check 3: Auth state
  const authPresent = checkAuthState();
  if (!authPresent) {
    status = 'critical';
    issues.push('Auth directory empty — QR re-authentication needed');
  }

  // Persist status
  setHealthState('status', status);
  setHealthState('issues', JSON.stringify(issues));
  setHealthState('last_check', new Date().toISOString());

  // Write health snapshot for Andy's container to read
  const snapshot: HealthSnapshot = {
    timestamp: new Date().toISOString(),
    status,
    whatsapp: {
      connected: healthInfo.connected,
      lastConnectedAt: healthInfo.lastConnectedAt,
      recentDisconnects: Array.isArray(healthInfo.recentDisconnects)
        ? healthInfo.recentDisconnects.length
        : 0,
      protocolErrorCount: healthInfo.protocolErrorCount,
    },
    lastMessageAt: lastMsgTs,
    authPresent,
    uptimeMinutes: Math.round((Date.now() - startTime) / 60000),
  };

  const ipcDir = path.join(DATA_DIR, 'ipc', MAIN_GROUP_FOLDER);
  fs.mkdirSync(ipcDir, { recursive: true });
  const snapshotPath = path.join(ipcDir, 'health_snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  if (issues.length > 0) {
    logger.info({ status, issues }, 'Health check completed with issues');
  } else {
    logger.debug({ status }, 'Health check OK');
  }

  // Alert if critical for >30 minutes
  if (status === 'critical') {
    if (!alertedCriticalAt) {
      alertedCriticalAt = Date.now();
    } else if (Date.now() - alertedCriticalAt > 30 * 60 * 1000) {
      const mainJid = deps.getMainGroupJid();
      if (mainJid) {
        const alertText = `⚠️ Health Alert (critical for 30+ min):\n${issues.join('\n')}`;
        try {
          await deps.sendAlert(mainJid, alertText);
          logger.info('Critical health alert sent to main group');
          // Reset so we don't spam — will alert again after another 30 min
          alertedCriticalAt = Date.now();
        } catch (err) {
          logger.error({ err }, 'Failed to send health alert');
        }
      }
    }
  } else {
    alertedCriticalAt = null;
  }
}

export function startHealthMonitor(deps: HealthMonitorDeps): void {
  logger.info({ intervalMs: HEALTH_CHECK_INTERVAL }, 'Starting health monitor');

  // Run first check after a short delay to let connections settle
  setTimeout(() => {
    runHealthCheck(deps).catch((err) =>
      logger.error({ err }, 'Health check error'),
    );
  }, 30000);

  setInterval(() => {
    runHealthCheck(deps).catch((err) =>
      logger.error({ err }, 'Health check error'),
    );
  }, HEALTH_CHECK_INTERVAL);
}
