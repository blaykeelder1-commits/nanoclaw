import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCliAuthGateOpen,
  recordCliAuthFailure,
  recordCliSuccess,
  setCliAuthGateAlerter,
  cliAuthGateStatus,
  _resetCliAuthGate,
} from './cli-auth-gate.js';

describe('cli-auth-gate', () => {
  beforeEach(() => _resetCliAuthGate());

  it('stays closed below the threshold', () => {
    recordCliAuthFailure('test'); // threshold is 2 by default
    expect(isCliAuthGateOpen()).toBe(false);
  });

  it('opens after N consecutive auth failures and pages exactly once', () => {
    const pages: string[] = [];
    setCliAuthGateAlerter((m) => pages.push(m));
    recordCliAuthFailure('test');
    recordCliAuthFailure('test'); // opens at 2
    expect(isCliAuthGateOpen()).toBe(true);
    recordCliAuthFailure('test'); // still open — must NOT page again
    expect(pages.length).toBe(1);
    expect(pages[0]).toMatch(/auth is DOWN/i);
  });

  it('closes on success and pages a recovery message once', () => {
    const pages: string[] = [];
    setCliAuthGateAlerter((m) => pages.push(m));
    recordCliAuthFailure('test');
    recordCliAuthFailure('test');
    expect(isCliAuthGateOpen()).toBe(true);
    recordCliSuccess();
    expect(isCliAuthGateOpen()).toBe(false);
    expect(pages.filter((p) => /recovered/i.test(p)).length).toBe(1);
  });

  it('a success resets the consecutive counter so the gate does not creep open', () => {
    recordCliAuthFailure('test');
    recordCliSuccess(); // resets
    recordCliAuthFailure('test');
    expect(isCliAuthGateOpen()).toBe(false);
    expect(cliAuthGateStatus().consecutiveAuthFailures).toBe(1);
  });

  it('recordCliSuccess on an already-closed gate does not page', () => {
    const pages: string[] = [];
    setCliAuthGateAlerter((m) => pages.push(m));
    recordCliSuccess();
    recordCliSuccess();
    expect(pages.length).toBe(0);
  });
});
