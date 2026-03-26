import { describe, it, expect } from 'vitest';
import { channelFromJid, escapeXml, formatMessages, formatConversationHistory, stripInternalTags, formatOutbound } from './router.js';

// ── channelFromJid ───────────────────────────────────────────────────

describe('channelFromJid', () => {
  it('maps quo: prefix to sms', () => {
    expect(channelFromJid('quo:+16822551033')).toBe('sms');
    expect(channelFromJid('quo:+18175871460')).toBe('sms');
  });

  it('maps web: prefix to web', () => {
    expect(channelFromJid('web:snak-group')).toBe('web');
  });

  it('maps email: prefix to email', () => {
    expect(channelFromJid('email:info@snakgroup.biz:lead@test.com')).toBe('email');
  });

  it('maps messenger: prefix to messenger', () => {
    expect(channelFromJid('messenger:123456')).toBe('messenger');
  });

  it('maps @g.us JIDs to whatsapp', () => {
    expect(channelFromJid('120363@g.us')).toBe('whatsapp');
  });

  it('maps @s.whatsapp.net JIDs to whatsapp', () => {
    expect(channelFromJid('+1234@s.whatsapp.net')).toBe('whatsapp');
  });

  it('returns unknown for unrecognized JIDs', () => {
    expect(channelFromJid('random-jid')).toBe('unknown');
    expect(channelFromJid('')).toBe('unknown');
    expect(channelFromJid('foobar:123')).toBe('unknown');
  });
});

// ── escapeXml ────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes special XML characters', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('returns empty string for falsy input', () => {
    expect(escapeXml('')).toBe('');
  });
});

// ── stripInternalTags ────────────────────────────────────────────────

describe('stripInternalTags', () => {
  it('removes <internal>...</internal> blocks', () => {
    expect(stripInternalTags('Hello <internal>secret</internal> world')).toBe('Hello  world');
  });

  it('handles multiline internal tags', () => {
    expect(stripInternalTags('Hi\n<internal>\nfoo\nbar\n</internal>\nbye')).toBe('Hi\n\nbye');
  });

  it('returns original text when no internal tags', () => {
    expect(stripInternalTags('just text')).toBe('just text');
  });
});

// ── formatOutbound ───────────────────────────────────────────────────

describe('formatOutbound', () => {
  it('strips internal tags and trims', () => {
    expect(formatOutbound('Hello <internal>hidden</internal>')).toBe('Hello');
  });

  it('returns empty string when only internal tags remain', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });
});
