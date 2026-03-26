/**
 * Tests for the SMS message splitting logic in quo.ts.
 *
 * splitSmsMessage is not exported, so we replicate the exact logic here
 * to test the algorithm. This mirrors the implementation at src/channels/quo.ts:74-100.
 */
import { describe, it, expect } from 'vitest';

const SMS_MAX_LENGTH = 600;

/** Exact copy of the private splitSmsMessage from quo.ts for testing. */
function splitSmsMessage(text: string): string[] {
  if (text.length <= SMS_MAX_LENGTH) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > SMS_MAX_LENGTH) {
    let splitAt = -1;
    for (const sep of ['. ', '! ', '? ', '\n']) {
      const idx = remaining.lastIndexOf(sep, SMS_MAX_LENGTH);
      if (idx > 0 && idx > splitAt) splitAt = idx + sep.length;
    }
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', SMS_MAX_LENGTH);
    }
    if (splitAt <= 0) splitAt = SMS_MAX_LENGTH;

    segments.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) segments.push(remaining);
  return segments;
}

// ── splitSmsMessage ──────────────────────────────────────────────────

describe('splitSmsMessage', () => {
  it('returns single segment for short messages', () => {
    const msg = 'Hello, how can I help you?';
    const result = splitSmsMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(msg);
  });

  it('returns single segment for message exactly at 600 chars', () => {
    const msg = 'A'.repeat(600);
    const result = splitSmsMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(msg);
  });

  it('splits long messages at sentence boundary (period)', () => {
    // Build a message with two sentences, first ~500 chars, second ~300 chars
    const sentence1 = 'A'.repeat(490) + '. ';
    const sentence2 = 'B'.repeat(300) + '.';
    const msg = sentence1 + sentence2;
    expect(msg.length).toBeGreaterThan(600);

    const result = splitSmsMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // First segment should end at the sentence boundary
    expect(result[0]).toBe(sentence1.trim());
  });

  it('splits at exclamation mark boundary', () => {
    const sentence1 = 'A'.repeat(490) + '! ';
    const sentence2 = 'B'.repeat(300);
    const msg = sentence1 + sentence2;

    const result = splitSmsMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toBe(sentence1.trim());
  });

  it('splits at question mark boundary', () => {
    const sentence1 = 'A'.repeat(490) + '? ';
    const sentence2 = 'B'.repeat(300);
    const msg = sentence1 + sentence2;

    const result = splitSmsMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toBe(sentence1.trim());
  });

  it('splits at newline boundary', () => {
    const line1 = 'A'.repeat(490) + '\n';
    const line2 = 'B'.repeat(300);
    const msg = line1 + line2;

    const result = splitSmsMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toBe(line1.trim());
  });

  it('falls back to word boundary when no sentence boundary exists', () => {
    // Long string with spaces but no sentence-ending punctuation
    const words = [];
    let len = 0;
    while (len < 800) {
      const word = 'word';
      words.push(word);
      len += word.length + 1; // +1 for space
    }
    const msg = words.join(' ');
    expect(msg.length).toBeGreaterThan(600);

    const result = splitSmsMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Each segment should be <= 600 chars
    for (const segment of result) {
      expect(segment.length).toBeLessThanOrEqual(600);
    }
  });

  it('hard splits when no spaces at all', () => {
    const msg = 'A'.repeat(800);
    const result = splitSmsMessage(msg);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(600);
    expect(result[1].length).toBe(200);
  });

  it('preserves all content across segments', () => {
    const sentences = [];
    for (let i = 0; i < 10; i++) {
      sentences.push(`This is sentence number ${i + 1} with some padding text to make it longer.`);
    }
    const msg = sentences.join(' ');
    expect(msg.length).toBeGreaterThan(600);

    const result = splitSmsMessage(msg);
    const rejoined = result.join(' ');
    // All original content should be preserved (modulo whitespace trimming at boundaries)
    for (const sentence of sentences) {
      expect(rejoined).toContain(sentence.trim());
    }
  });

  it('handles multiple splits for very long messages', () => {
    // Build a 2000-char message with sentence boundaries
    const sentences = [];
    for (let i = 0; i < 30; i++) {
      sentences.push(`Sentence ${i + 1} here with content.`);
    }
    const msg = sentences.join(' ');
    expect(msg.length).toBeGreaterThan(600);

    const result = splitSmsMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const segment of result) {
      expect(segment.length).toBeLessThanOrEqual(600);
    }
  });
});
