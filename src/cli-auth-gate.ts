/**
 * CLI-auth circuit breaker.
 *
 * The CLI execution path (Max subscription) depends on a single OAuth credential
 * on disk. When that credential expires/revokes, EVERY scheduled task and every
 * interactive reply fails with a 401 — and, pre-breaker, the scheduler kept
 * firing the every-5-minute sweeps ~288x/day against known-dead auth for days
 * (the Jun-20 outage: 645 consecutive failures on one task alone).
 *
 * This gate makes that failure mode LOUD and SELF-LIMITING:
 *  - After N consecutive auth failures it OPENS: callers stop spawning the CLI.
 *  - It pages the owner exactly ONCE with the actionable fix (re-auth on the VPS).
 *  - The health probe authenticates for real each cycle and CLOSES the gate on
 *    recovery, paging once more that Andy is back.
 *
 * The gate holds no channel references (avoids import cycles). Bootstrap injects
 * an alerter via setCliAuthGateAlerter(); call sites only record outcomes.
 */
import { CLI_AUTH_FAILURE_THRESHOLD } from './config.js';
import { logger } from './logger.js';

type Alerter = (message: string) => void;

let consecutiveAuthFailures = 0;
let gateOpen = false;
let openedAt = 0;
let alerter: Alerter | null = null;

/** Wire the owner-paging function (WhatsApp main group + ntfy). Set once at bootstrap. */
export function setCliAuthGateAlerter(fn: Alerter): void {
  alerter = fn;
}

/** True while the CLI path is paused. Callers must NOT spawn the CLI when open. */
export function isCliAuthGateOpen(): boolean {
  return gateOpen;
}

export function cliAuthGateStatus(): {
  open: boolean;
  consecutiveAuthFailures: number;
  openedAt: number | null;
} {
  return { open: gateOpen, consecutiveAuthFailures, openedAt: gateOpen ? openedAt : null };
}

/** Record an authentication failure from any CLI run or the health probe. */
export function recordCliAuthFailure(context: string): void {
  consecutiveAuthFailures++;
  if (!gateOpen && consecutiveAuthFailures >= CLI_AUTH_FAILURE_THRESHOLD) {
    gateOpen = true;
    openedAt = Date.now();
    logger.error(
      { consecutiveAuthFailures, context },
      'CLI-auth gate OPENED — pausing CLI path until re-auth',
    );
    alerter?.(
      `🚨 *Andy CLI auth is DOWN* (${consecutiveAuthFailures}× 401).\n\n` +
        `All scheduled tasks and CLI replies are *paused* to stop a silent failure storm.\n\n` +
        `*Fix:* SSH to the VPS and run \`claude\` to re-login the Max subscription. ` +
        `Andy auto-resumes within ~5 min once auth works.`,
    );
  } else {
    logger.warn(
      { consecutiveAuthFailures, gateOpen, context },
      'CLI auth failure recorded',
    );
  }
}

/** Record a successful (authenticated) CLI run or probe. Closes the gate if open. */
export function recordCliSuccess(): void {
  if (gateOpen) {
    logger.info(
      { downMs: Date.now() - openedAt },
      'CLI-auth gate CLOSED — CLI path recovered',
    );
    alerter?.('✅ *Andy CLI auth recovered* — scheduled tasks and replies resumed.');
  }
  consecutiveAuthFailures = 0;
  gateOpen = false;
  openedAt = 0;
}

/** Test helper — reset gate state. */
export function _resetCliAuthGate(): void {
  consecutiveAuthFailures = 0;
  gateOpen = false;
  openedAt = 0;
  alerter = null;
}
