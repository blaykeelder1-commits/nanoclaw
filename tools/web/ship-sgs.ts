#!/usr/bin/env npx tsx
/**
 * ship-sgs.ts — Bridge between the Simple Growth Solutions (SGS) platform's
 * customer "change requests" and Andy's website-shipping engine.
 *
 * SGS is a website-as-a-service platform: its customers (e.g. Waste Rescue KC)
 * submit edit requests for THEIR websites through the SGS portal. Those tickets
 * land on the SGS admin "Dispatch Board". This tool lets Andy:
 *   1) pending  — pull open tickets, map each to a whitelisted site, and attach
 *                 deterministic triage hints (which lens / is it auto-editable).
 *   2) get      — fetch one ticket in full.
 *   3) complete — mark a ticket Completed (SGS then emails the customer + moves
 *                 it to Done). Andy NEVER emails the customer itself.
 *   4) status   — set any other status (approved / in_progress / rejected).
 *   5) log      — append a structured lesson to the SGS edit playbook so Andy
 *                 gets better at each request over time.
 *
 * The actual editing + preview + promote of a customer site is done by its
 * sibling, tools/web/ship-site.ts (the proven preview→approve→prod engine).
 * This tool only reads/writes the SGS ticket and records learnings.
 *
 * Every command prints a single JSON receipt and exits non-zero on ANY failure,
 * so "looks done but nothing happened" is impossible. Relay receipts verbatim.
 *
 * Usage:
 *   npx tsx tools/web/ship-sgs.ts pending
 *   npx tsx tools/web/ship-sgs.ts pending-new [--maxAgeHours 72]   # intake sweep work-list (unseen only)
 *   npx tsx tools/web/ship-sgs.ts get <crId>
 *   npx tsx tools/web/ship-sgs.ts claim <crId>          # atomic pending→in_progress; SKIP if claimed:false
 *   npx tsx tools/web/ship-sgs.ts mark-seen <crId>      # stamp guard w/o status change (triage to human)
 *   npx tsx tools/web/ship-sgs.ts review-ready <crId> --preview <url> --note "<tri-lens summary>"
 *   npx tsx tools/web/ship-sgs.ts approved
 *   npx tsx tools/web/ship-sgs.ts complete <crId> -m "<what was shipped>"
 *   npx tsx tools/web/ship-sgs.ts status <crId> <status> [-m "<resolution>"]
 *   npx tsx tools/web/ship-sgs.ts log <crId> --site <site> --action auto|triage \
 *        --summary "<what>" --lesson "<what you learned>"
 *
 * Env:
 *   SGS_BASE_URL        — default https://simple-growth-solution.com
 *   ANDY_SERVICE_TOKEN  — bearer token honored by SGS /api/admin/* (see SGS with-auth.ts)
 *   SGS_GROUP_DIR       — where to write the edit playbook (default: groups/sgs)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.SGS_BASE_URL || 'https://simple-growth-solution.com').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 30_000;

// ── site registry (shared with ship-site.ts) ─────────────────────────
interface Site {
  label: string;
  liveUrl: string;
  // Optional SGS matchers: case-insensitive substrings tested against the
  // ticket's organization + project name to map a ticket → a shippable site.
  sgsMatch?: string[];
}
const SITES: Record<string, Site> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf-8'),
);

// ── triage heuristics (mirror ship-website's "Never do" denylist) ────
// These are HINTS for the agent, not a hard gate. The agent still applies the
// tri-lens review and the skill's hard guardrails before touching anything.
const NEEDS_HUMAN_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /promo|coupon|discount code|\bcode\b|voucher/i, reason: 'promo/discount-code logic' },
  { re: /checkout|payment|stripe|square|invoice|refund|pricing logic|charge/i, reason: 'checkout/payment logic' },
  { re: /booking|reservation|availability|calendar/i, reason: 'booking logic' },
  { re: /\bapi\b|integration|webhook|backend|database|env|secret|token/i, reason: 'backend/integration/secrets' },
  { re: /login|signup|auth|account|password/i, reason: 'auth flow' },
  { re: /delete page|remove page|rename route|new page|add page/i, reason: 'route/page structure' },
  { re: /upload|pdf|attach|file/i, reason: 'asset upload (needs the file)' },
];

// Simple, content-level work Andy can safely auto-edit (still preview-first).
const AUTO_FRIENDLY_PATTERNS = /typo|headline|wording|copy|text|color|colour|image|photo|hours|phone|address|button label|seo|meta|title tag|description/i;

function suggestTriage(cr: { title: string; description: string; type: string }) {
  const hay = `${cr.title}\n${cr.description}`;
  const reasons = NEEDS_HUMAN_PATTERNS.filter((p) => p.re.test(hay)).map((p) => p.reason);
  const autoFriendly = AUTO_FRIENDLY_PATTERNS.test(hay);
  const needsHuman = reasons.length > 0;
  return {
    suggestedAction: needsHuman ? 'triage' : autoFriendly ? 'auto' : 'review',
    needsHumanReasons: reasons,
    autoFriendly,
  };
}

function matchSite(cr: { project: { name: string; organizationName: string | null } }): string | null {
  const hay = `${cr.project.organizationName ?? ''} ${cr.project.name}`.toLowerCase();
  for (const [key, site] of Object.entries(SITES)) {
    for (const m of site.sgsMatch ?? []) {
      if (hay.includes(m.toLowerCase())) return key;
    }
  }
  return null;
}

// ── http ─────────────────────────────────────────────────────────────
class SgsError extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
  }
}

function requireToken(): string {
  const t = process.env.ANDY_SERVICE_TOKEN;
  if (!t) throw new SgsError('ANDY_SERVICE_TOKEN is not set — cannot authenticate to SGS');
  return t;
}

/** Replace the service token with *** so it never reaches stdout/logs. */
function scrub(s: string): string {
  const t = process.env.ANDY_SERVICE_TOKEN;
  return t ? s.split(t).join('***') : s;
}

async function api<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const token = requireToken();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SgsError(`request failed: ${method} ${pathname}`, scrub(String(err)));
  }
  const text = await res.text();
  if (!res.ok) {
    throw new SgsError(
      `SGS returned ${res.status} for ${method} ${pathname}`,
      scrub(text.slice(0, 500)),
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SgsError(`SGS returned non-JSON for ${method} ${pathname}`, scrub(text.slice(0, 300)));
  }
}

interface ChangeRequest {
  id: string;
  title: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  isRush: boolean;
  slaDueAt: string | null;
  createdAt: string;
  // Set when Andy prepares an autonomous edit (null for human-handled tickets).
  previewUrl: string | null;
  agentNote: string | null;
  // Anti-retrigger guard: stamped the first time Andy processes this ticket.
  // null = never seen (eligible for the intake sweep).
  andySeenAt: string | null;
  project: { id: string; name: string; organizationName: string | null };
  requester: { id: string; name: string | null; email: string } | null;
}

function slaLabel(slaDueAt: string | null): string {
  if (!slaDueAt) return 'no SLA';
  const ms = new Date(slaDueAt).getTime() - Date.now();
  const hrs = Math.round(ms / 3_600_000);
  if (ms < 0) return `OVERDUE ${Math.abs(hrs)}h`;
  if (hrs < 24) return `${hrs}h left`;
  return `${Math.ceil(hrs / 24)}d left`;
}

function emit(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ status: 'ok', ...obj }, null, 2));
}

// ── commands ─────────────────────────────────────────────────────────
async function cmdPending(): Promise<void> {
  const data = await api<{ changeRequests: ChangeRequest[] }>(
    'GET',
    '/api/admin/change-requests?status=pending',
  );
  const tickets = (data.changeRequests || []).map((cr) => {
    const triage = suggestTriage(cr);
    const site = matchSite(cr);
    return {
      id: cr.id,
      title: cr.title,
      description: cr.description,
      type: cr.type,
      priority: cr.priority,
      isRush: cr.isRush,
      sla: slaLabel(cr.slaDueAt),
      slaDueAt: cr.slaDueAt,
      customer: cr.project.organizationName,
      project: cr.project.name,
      requestedBy: cr.requester?.name || cr.requester?.email || null,
      site,                       // whitelisted ship-site key, or null
      shippable: !!site && triage.suggestedAction !== 'triage',
      ...triage,
    };
  });
  // Soonest SLA first; overdue at the very top.
  tickets.sort((a, b) => {
    const at = a.slaDueAt ? new Date(a.slaDueAt).getTime() : Infinity;
    const bt = b.slaDueAt ? new Date(b.slaDueAt).getTime() : Infinity;
    return at - bt;
  });
  emit({ action: 'pending', count: tickets.length, tickets });
}

async function cmdGet(id: string): Promise<void> {
  if (!id) throw new SgsError('a <crId> is required');
  // The list endpoint is the source of truth; filter to the one id.
  const data = await api<{ changeRequests: ChangeRequest[] }>('GET', '/api/admin/change-requests');
  const cr = (data.changeRequests || []).find((c) => c.id === id);
  if (!cr) throw new SgsError(`change request "${id}" not found`);
  emit({
    action: 'get',
    ticket: {
      ...cr,
      sla: slaLabel(cr.slaDueAt),
      site: matchSite(cr),
      ...suggestTriage(cr),
    },
  });
}

async function cmdSetStatus(id: string, status: string, resolution: string): Promise<void> {
  if (!id) throw new SgsError('a <crId> is required');
  const allowed = ['pending', 'review_ready', 'approved', 'in_progress', 'completed', 'rejected'];
  if (!allowed.includes(status)) {
    throw new SgsError(`invalid status "${status}". Use: ${allowed.join(', ')}`);
  }
  const body: Record<string, string> = { status };
  if (resolution) body.resolution = resolution;
  const data = await api<{ success: boolean; changeRequest: { id: string; status: string; title: string } }>(
    'PATCH',
    `/api/admin/change-requests/${id}`,
    body,
  );
  emit({
    action: 'status',
    id,
    newStatus: data.changeRequest?.status ?? status,
    title: data.changeRequest?.title,
    note: status === 'completed'
      ? 'SGS will email the customer and move the ticket to Done.'
      : undefined,
  });
}

/**
 * Mark a ticket review_ready: attach the preview URL + a tri-lens summary so it
 * shows in the SGS admin Dispatch "Review" column AND can be relayed to WhatsApp.
 * The customer is NOT emailed (SGS scopes notifications to completed/rejected).
 * Blayke then approves from EITHER surface (admin button or WhatsApp reply).
 */
async function cmdReviewReady(id: string, preview: string, note: string): Promise<void> {
  if (!id) throw new SgsError('a <crId> is required');
  if (!preview) throw new SgsError('--preview <url> is required (the deployed preview to review)');
  if (!/^https?:\/\//i.test(preview)) throw new SgsError(`--preview must be an http(s) URL, got "${preview}"`);
  const data = await api<{ success: boolean; changeRequest: { id: string; status: string; title: string } }>(
    'PATCH',
    `/api/admin/change-requests/${id}`,
    { status: 'review_ready', previewUrl: preview, agentNote: note || undefined },
  );
  emit({
    action: 'review-ready',
    id,
    newStatus: data.changeRequest?.status ?? 'review_ready',
    title: data.changeRequest?.title,
    previewUrl: preview,
    note: 'Awaiting approval — Blayke approves via the admin Review column or a WhatsApp reply.',
  });
}

/**
 * Poll for tickets Blayke approved-to-ship. A ticket is ready to PROMOTE when
 * status === "approved" AND it has a previewUrl (the previewUrl is what
 * distinguishes Andy's "approved to go live" from the legacy "approved to start"
 * meaning). Run this on the approval-sweep cron and the daily run, then promote
 * each via ship-site.ts and complete it.
 */
async function cmdApproved(): Promise<void> {
  const data = await api<{ changeRequests: ChangeRequest[] }>(
    'GET',
    '/api/admin/change-requests?status=approved',
  );
  const ready = (data.changeRequests || [])
    .filter((cr) => !!cr.previewUrl)
    .map((cr) => ({
      id: cr.id,
      title: cr.title,
      customer: cr.project.organizationName,
      project: cr.project.name,
      site: matchSite(cr),
      previewUrl: cr.previewUrl,
      agentNote: cr.agentNote,
    }));
  emit({
    action: 'approved',
    count: ready.length,
    tickets: ready,
    note: ready.length
      ? 'Promote each via ship-site.ts, verify live 2xx, then ship-sgs.ts complete <id> and log.'
      : 'Nothing approved-and-ready to promote right now.',
  });
}

/**
 * The intake-sweep work-list: tickets Andy has NEVER processed
 * (status=pending AND andySeenAt IS NULL) created within the maxAge window.
 * This is the anti-retrigger core — a ticket leaves this list forever the
 * instant Andy claims it (→ in_progress) or marks it seen (triage). So the
 * 20-minute sweep never re-notifies or re-works the same request.
 *
 * The maxAge guard (default 72h) is belt-and-suspenders against a first-deploy
 * fan-out across historical rows (the migration also backfills andy_seen_at).
 */
async function cmdPendingNew(maxAgeHours: number): Promise<void> {
  const hrs = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 72;
  const data = await api<{ changeRequests: ChangeRequest[] }>(
    'GET',
    `/api/admin/change-requests?status=pending&unseen=true&createdWithin=${hrs}`,
  );
  const tickets = (data.changeRequests || []).map((cr) => {
    const triage = suggestTriage(cr);
    const site = matchSite(cr);
    return {
      id: cr.id,
      title: cr.title,
      description: cr.description,
      type: cr.type,
      priority: cr.priority,
      isRush: cr.isRush,
      sla: slaLabel(cr.slaDueAt),
      slaDueAt: cr.slaDueAt,
      customer: cr.project.organizationName,
      project: cr.project.name,
      requestedBy: cr.requester?.name || cr.requester?.email || null,
      site,
      shippable: !!site && triage.suggestedAction !== 'triage',
      ...triage,
    };
  });
  tickets.sort((a, b) => {
    const at = a.slaDueAt ? new Date(a.slaDueAt).getTime() : Infinity;
    const bt = b.slaDueAt ? new Date(b.slaDueAt).getTime() : Infinity;
    return at - bt;
  });
  emit({
    action: 'pending-new',
    count: tickets.length,
    maxAgeHours: hrs,
    tickets,
    note: tickets.length
      ? 'For EACH (cap 3/run): claim it FIRST, then prepare (auto) or mark-seen (triage). Never act without claiming.'
      : 'No new unseen requests. Stop silently.',
  });
}

/**
 * Atomically CLAIM a ticket: pending + never-seen → in_progress (+ stamp the
 * guard). This is the lock that prevents duplicate work: if another run already
 * took it, `claimed` is false and you MUST skip it. Always claim before doing
 * any edit work on a ticket. No customer email fires (in_progress is internal).
 */
async function cmdClaim(id: string): Promise<void> {
  if (!id) throw new SgsError('a <crId> is required');
  const data = await api<{ success: boolean; claimed: boolean; changeRequest: { id: string; status: string; title: string } | null }>(
    'PATCH',
    `/api/admin/change-requests/${id}`,
    { claim: true },
  );
  emit({
    action: 'claim',
    id,
    claimed: data.claimed === true,
    title: data.changeRequest?.title,
    note: data.claimed
      ? 'Claimed. Prepare the edit now, then review-ready. If prep fails, post the failure ONCE and stop (do not retry).'
      : 'Already taken by another run — SKIP this ticket entirely.',
  });
}

/**
 * Stamp the anti-retrigger guard WITHOUT changing status. Use this when a ticket
 * is triaged to a human (out of Andy's safe-edit scope): it stays `pending` for
 * Blayke but the intake sweep will never re-flag it. Pair with a single WhatsApp
 * "needs you" message.
 */
async function cmdMarkSeen(id: string): Promise<void> {
  if (!id) throw new SgsError('a <crId> is required');
  const data = await api<{ success: boolean; changeRequest: { id: string; status: string; title: string } | null }>(
    'PATCH',
    `/api/admin/change-requests/${id}`,
    { markSeen: true },
  );
  emit({
    action: 'mark-seen',
    id,
    title: data.changeRequest?.title,
    note: 'Stamped seen (status unchanged). Flag Blayke once; it will not be re-surfaced by the sweep.',
  });
}

/**
 * Release a ticket you already CLAIMED but cannot complete as a website edit
 * (it turned out to be an in-app/backend/data change, the request does not map
 * to any site file, or it is otherwise out of safe-edit scope). Returns it to
 * `pending` with an agentNote so it is visible to Blayke, but leaves the seen
 * guard stamped so the sweep will NOT re-claim and re-stall it. This is the
 * escape hatch that prevents a claimed ticket from silently rotting in_progress.
 * Always pair with a single WhatsApp "needs you" message.
 */
async function cmdRelease(id: string, reason: string): Promise<void> {
  if (!id) throw new SgsError('a <crId> is required');
  if (!reason) throw new SgsError('a --reason "<why this is not a website edit / what it needs>" is required');
  const data = await api<{ success: boolean; changeRequest: { id: string; status: string; title: string } | null }>(
    'PATCH',
    `/api/admin/change-requests/${id}`,
    { status: 'pending', agentNote: `NEEDS YOU — ${reason}` },
  );
  emit({
    action: 'release',
    id,
    title: data.changeRequest?.title,
    status: data.changeRequest?.status,
    note: 'Returned to pending with a needs-you note; seen-guard kept so it will not be re-claimed. Flag Blayke once.',
  });
}

/**
 * Append a structured lesson to the SGS edit playbook. This is the learning
 * loop: every shipped (or triaged) request leaves a durable note so future
 * runs reuse what worked and avoid what didn't.
 */
function cmdLog(args: Record<string, string>, id: string): void {
  if (!id) throw new SgsError('a <crId> is required');
  const groupDir = process.env.SGS_GROUP_DIR
    || path.resolve(__dirname, '../../groups/sgs');
  fs.mkdirSync(groupDir, { recursive: true });
  const file = path.join(groupDir, 'edit-lessons.md');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      '# SGS Edit Lessons (Andy\'s learning loop)\n\n' +
      'Append-only log. Andy reads this before every batch and writes one entry\n' +
      'after every shipped or triaged ticket. Patterns that repeat → promote them\n' +
      'into groups/sgs/CLAUDE.md as standing rules.\n',
    );
  }
  // Stamp the date from the SGS ticket flow is not available here; use ISO now is
  // disallowed in workflow scripts but this is a normal CLI tool, so it is fine.
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry =
    `\n## ${stamp} · CR ${id}` +
    (args.site ? ` · site=${args.site}` : '') +
    (args.action ? ` · ${args.action}` : '') +
    '\n' +
    (args.summary ? `- **What:** ${args.summary}\n` : '') +
    (args.lesson ? `- **Lesson:** ${args.lesson}\n` : '');
  fs.appendFileSync(file, entry);
  emit({ action: 'log', id, file, appended: entry.trim() });
}

// ── entry ────────────────────────────────────────────────────────────
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--message') out.message = argv[++i] ?? '';
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i] ?? '';
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const action = argv[0];
  const flags = parseFlags(argv.slice(1));

  switch (action) {
    case 'pending':
    case 'list':
      return cmdPending();
    case 'pending-new':
      return cmdPendingNew(flags.maxAgeHours ? parseInt(flags.maxAgeHours, 10) : 72);
    case 'get':
      return cmdGet(argv[1]);
    case 'claim':
      return cmdClaim(argv[1]);
    case 'mark-seen':
      return cmdMarkSeen(argv[1]);
    case 'release':
      return cmdRelease(argv[1], flags.reason || '');
    case 'complete':
      return cmdSetStatus(argv[1], 'completed', flags.message || '');
    case 'status':
      return cmdSetStatus(argv[1], argv[2], flags.message || '');
    case 'review-ready':
      return cmdReviewReady(argv[1], flags.preview || '', flags.note || '');
    case 'approved':
      return cmdApproved();
    case 'log':
      return cmdLog(flags, argv[1]);
    default:
      throw new SgsError(
        `unknown action "${action ?? ''}". Use: pending | pending-new | get | claim | mark-seen | release | review-ready | approved | complete | status | log`,
      );
  }
}

main().catch((err) => {
  const e = err as SgsError;
  console.log(JSON.stringify({
    status: 'error',
    error: scrub(e.message || String(err)),
    detail: e.detail ? scrub(e.detail) : undefined,
  }, null, 2));
  process.exit(1);
});
