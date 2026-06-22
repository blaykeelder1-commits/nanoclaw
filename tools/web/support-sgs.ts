#!/usr/bin/env npx tsx
/**
 * support-sgs.ts — Andy's bridge to the SGS client-portal SUPPORT chat.
 *
 * SGS customers can ask questions in a Support tab in their portal. Each message
 * is stored; the latest-message-is-the-customer threads are "waiting on Andy".
 * Andy (this is run on his Max-subscription CLI, NOT an API key) reads the queue,
 * writes an advisory reply per the rulebook, and posts it back into the thread.
 *
 * Commands:
 *   npx tsx tools/web/support-sgs.ts pending
 *       → JSON: { pendingCount, rulebook, threads:[{organizationId, orgName,
 *         context, messages:[{role,content}], lastCustomerAt}] }
 *   npx tsx tools/web/support-sgs.ts reply <organizationId> --message "<text>" \
 *         [--escalate] [--reason "<why>"]
 *       → posts Andy's reply into the customer's thread (escalate also emails staff).
 *
 * Scope: ADVISORY ONLY (see the rulebook returned by `pending`). Andy never edits,
 * deploys, emails customers, or changes settings from here.
 *
 * Env:
 *   SGS_BASE_URL        — default https://simple-growth-solution.com
 *   ANDY_SERVICE_TOKEN  — bearer honored by SGS /api/support/agent (admin scope)
 *
 * Prints a single JSON receipt and exits non-zero on ANY failure.
 */

const BASE_URL = (process.env.SGS_BASE_URL || 'https://simple-growth-solution.com').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 30_000;

class SupportError extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
  }
}

function scrub(s: string): string {
  const t = process.env.ANDY_SERVICE_TOKEN;
  return t ? s.split(t).join('***') : s;
}

async function api<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const token = process.env.ANDY_SERVICE_TOKEN;
  if (!token) throw new SupportError('ANDY_SERVICE_TOKEN is not set — cannot authenticate to SGS');
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SupportError(`request failed: ${method} ${pathname}`, scrub(String(err)));
  }
  const text = await res.text();
  if (!res.ok) {
    throw new SupportError(`SGS returned ${res.status} for ${method} ${pathname}`, scrub(text.slice(0, 500)));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SupportError(`SGS returned non-JSON for ${method} ${pathname}`, scrub(text.slice(0, 300)));
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function ok(payload: unknown) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function fail(err: unknown): never {
  const e = err instanceof SupportError ? err : new SupportError(String(err));
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, detail: e.detail }, null, 2) + '\n');
  process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'pending') {
    const data = await api<{ rulebook: string; pendingCount: number; threads: unknown[] }>(
      'GET',
      '/api/support/agent',
    );
    ok({ ok: true, ...data });
    return;
  }

  if (cmd === 'reply') {
    const organizationId = rest[0];
    const message = flag(rest, '--message');
    const escalate = rest.includes('--escalate');
    const reason = flag(rest, '--reason');
    if (!organizationId || !message) {
      throw new SupportError('usage: reply <organizationId> --message "<text>" [--escalate] [--reason "<why>"]');
    }
    await api('POST', '/api/support/agent', {
      organizationId,
      reply: message,
      escalate,
      escalateReason: reason,
    });
    ok({ ok: true, posted: true, organizationId, escalated: escalate });
    return;
  }

  throw new SupportError(`unknown command: ${cmd || '(none)'} — use "pending" or "reply"`);
}

main().catch(fail);
