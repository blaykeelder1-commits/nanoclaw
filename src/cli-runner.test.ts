import { describe, it, expect } from 'vitest';
import { parseCliOutcome } from './cli-runner.js';

// The real-world 401 envelope captured from the VPS during the Jun-20 outage:
// the CLI exits 1 with EMPTY stderr and puts the failure on stdout.
const AUTH_401_STDOUT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result:
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
  session_id: 'abc',
});

describe('parseCliOutcome', () => {
  it('surfaces the real 401 from stdout when stderr is empty (the outage bug)', () => {
    const o = parseCliOutcome(AUTH_401_STDOUT, '', 1, false);
    expect(o.failed).toBe(true);
    expect(o.authFailure).toBe(true);
    expect(o.error).toMatch(/AUTH_401/);
    expect(o.error).toMatch(/Invalid authentication credentials/);
    expect(o.resultText).toBeNull();
  });

  it('treats is_error:true as failure even when exit code is 0 (never delivered to a customer)', () => {
    const o = parseCliOutcome(AUTH_401_STDOUT, '', 0, false);
    expect(o.failed).toBe(true);
    expect(o.resultText).toBeNull();
  });

  it('returns the result text on a clean success', () => {
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', is_error: false, result: 'All good 👍' },
    ]);
    const o = parseCliOutcome(stdout, '', 0, false);
    expect(o.failed).toBe(false);
    expect(o.resultText).toBe('All good 👍');
    expect(o.newSessionId).toBe('sess-1');
    expect(o.authFailure).toBe(false);
  });

  it('flags timeouts as failure', () => {
    const o = parseCliOutcome('', '', null, true);
    expect(o.failed).toBe(true);
    expect(o.error).toMatch(/timed out/);
  });

  it('reports a real error (not an empty string) when both streams are empty', () => {
    const o = parseCliOutcome('', '', 1, false);
    expect(o.failed).toBe(true);
    expect(o.error).toMatch(/CLI produced no output/);
    expect(o.error).not.toMatch(/:\s*$/); // never trailing-colon-empty
  });

  it('uses stderr when there is no stdout', () => {
    const o = parseCliOutcome('', 'spawn ENOENT: claude not found', 127, false);
    expect(o.failed).toBe(true);
    expect(o.error).toMatch(/ENOENT/);
  });

  it('accepts legacy non-JSON stdout on a zero exit as raw success', () => {
    const o = parseCliOutcome('plain text answer', '', 0, false);
    expect(o.failed).toBe(false);
    expect(o.resultText).toBe('plain text answer');
  });
});
