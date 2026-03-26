/**
 * Authenticity Guard — monitors outbound messages for inauthentic language.
 * Flags corporate jargon, excessive urgency, and overselling.
 * This is a monitoring stage: it logs warnings but NEVER blocks or modifies messages.
 */
import { logger } from '../../logger.js';
import type { OutboundStage, OutboundMessage, OutboundVerdict } from '../types.js';

const CORPORATE_JARGON = [
  'leverage', 'synergy', 'value proposition', 'paradigm', 'ecosystem',
  'scalable', 'streamline', 'optimize', 'bandwidth', 'circle back',
  'touch base', 'deep dive', 'drill down', 'move the needle',
  'low-hanging fruit', 'best-in-class', 'robust', 'seamless',
];

const URGENCY_PHRASES = [
  'limited time offer', 'act now', "don't miss out", 'last chance',
  'expires today', 'hurry', 'only \\d+ left',
];

const OVERSELLING_PHRASES = [
  'guaranteed', 'proven results', '100% satisfaction',
  'no-risk', 'completely free',
];

/** Channel-specific max lengths before a warning is logged. */
const CHANNEL_LENGTH_LIMITS: Record<string, number> = {
  sms: 320,
  web: 500,
};

function findMatches(text: string, phrases: string[]): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const phrase of phrases) {
    const re = new RegExp(`\\b${phrase}\\b`, 'i');
    if (re.test(lower)) {
      hits.push(phrase);
    }
  }
  return hits;
}

export class AuthenticityGuard implements OutboundStage {
  name = 'authenticity-guard';

  process(msg: OutboundMessage): OutboundVerdict {
    const flags: Record<string, string[]> = {};

    // Check corporate jargon
    const jargon = findMatches(msg.text, CORPORATE_JARGON);
    if (jargon.length > 0) flags.jargon = jargon;

    // Check excessive urgency
    const urgency = findMatches(msg.text, URGENCY_PHRASES);
    if (urgency.length > 0) flags.urgency = urgency;

    // Check overselling
    const overselling = findMatches(msg.text, OVERSELLING_PHRASES);
    if (overselling.length > 0) flags.overselling = overselling;

    // Check message length for channel
    const limit = CHANNEL_LENGTH_LIMITS[msg.channel?.toLowerCase()];
    if (limit && msg.text.length > limit) {
      flags.too_long = [`${msg.text.length} chars on ${msg.channel} (limit: ${limit})`];
    }

    if (Object.keys(flags).length > 0) {
      logger.debug({ jid: msg.chatJid, flags }, 'Authenticity check flags');
    }

    // Never modify or block — always pass through unchanged
    return { action: 'pass' };
  }
}
