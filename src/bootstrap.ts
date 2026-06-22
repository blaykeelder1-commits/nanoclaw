import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLI_ENABLED,
  CLI_FALLBACK_ENABLED,
  DB_PATH,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { writeGroupsSnapshot } from './container-runner.js';
import { readEnvFile } from './env.js';
import {
  createTask,
  getDailySpendUsd,
  getTaskById,
  initDatabase,
  storeChatMetadata,
  updateTask,
  storeMessage,
} from './db.js';
import { CronExpressionParser } from 'cron-parser';
import { startHealthMonitor, sendPushAlert } from './health.js';
import { setCliAuthGateAlerter } from './cli-auth-gate.js';
import { startHealthServer } from './health-endpoint.js';
import { startDashboard } from './dashboard.js';
import { startIpcWatcher } from './ipc.js';
import { formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import {
  getRegisteredGroups,
  getSessions,
  loadState,
  registerDerivedGroup,
  registerGroup,
  getAvailableGroups,
} from './registry.js';
import {
  addChannel,
  getChannels,
  getPipelineStats,
  routeOutbound,
  setEscalationAlert,
  shouldProcessInbound,
} from './routing.js';

// ── Container system ──────────────────────────────────────────────

export function ensureContainerSystemRunning(): void {
  const isLinux = os.platform() === 'linux';

  if (isLinux) {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker is available');
    } catch (err) {
      logger.error({ err }, 'Docker is not available');
      console.error('\nFATAL: Docker is not available.');
      console.error('Agents cannot run without Docker. To fix:');
      console.error('  1. Install Docker: https://docs.docker.com/engine/install/');
      console.error('  2. Start Docker: systemctl start docker');
      console.error('  3. Restart NanoClaw\n');
      throw new Error('Docker is required but not available');
    }
  } else {
    try {
      execSync('container system status', { stdio: 'pipe' });
      logger.debug('Apple Container system already running');
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
        throw new Error('Apple Container system is required but failed to start');
      }
    }
  }

  // Kill orphaned containers from previous runs
  try {
    if (isLinux) {
      const output = execSync('docker ps --filter "name=nanoclaw-" --format "{{.Names}}"', { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
      const orphans = output.trim().split('\n').filter(Boolean);
      for (const name of orphans) { try { execSync(`docker stop ${name}`, { stdio: 'pipe' }); } catch { /* already stopped */ } }
      if (orphans.length > 0) logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    } else {
      const output = execSync('container ls --format json', { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
      const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
      const orphans = containers.filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-')).map((c) => c.configuration.id);
      for (const name of orphans) { try { execSync(`container stop ${name}`, { stdio: 'pipe' }); } catch { /* already stopped */ } }
      if (orphans.length > 0) logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

// ── Health task seeding ───────────────────────────────────────────

export function seedHealthTasks(): void {
  const registeredGroups = getRegisteredGroups();
  let mainJid: string | null = null;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) { mainJid = jid; break; }
  }
  if (!mainJid) {
    logger.debug('No main group registered yet, skipping health task seeding');
    return;
  }

  // SGS fulfillment runs in its OWN WhatsApp channel so its digests/approvals
  // don't mix with the Sheridan/Snak main command channel. Resolve the JID from
  // the registered `sgs` group if present, else the SGS_GROUP_JID env override,
  // else fall back to main (so seeding never breaks before the group is wired).
  let sgsJid: string | null = null;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === 'sgs') { sgsJid = jid; break; }
  }
  sgsJid = sgsJid || process.env.SGS_GROUP_JID || mainJid!;
  const sgsTarget: { group_folder?: string; chat_jid?: string } = sgsJid === mainJid
    ? { /* not yet isolated — runs in main */ }
    : { group_folder: 'sgs', chat_jid: sgsJid };
  if (sgsJid === mainJid) {
    logger.warn('SGS group not registered and SGS_GROUP_JID unset — SGS tasks will post to MAIN until wired');
  }

  const seedTask = (
    id: string,
    cron: string,
    prompt: string,
    opts?: { model?: string; budget_usd?: number; group_folder?: string; chat_jid?: string },
  ) => {
    const existing = getTaskById(id);
    if (existing) {
      // Task already seeded — keep its run history/timing, but refresh the parts
      // that live in code (prompt + tuning) so edits to THIS file actually take
      // effect on restart. Without this, prompt changes silently no-op forever.
      const updates: Parameters<typeof updateTask>[1] = {};
      if (existing.prompt !== prompt) updates.prompt = prompt;
      if (opts?.model !== undefined && existing.model !== opts.model) updates.model = opts.model;
      if (opts?.budget_usd !== undefined && existing.budget_usd !== opts.budget_usd) {
        updates.budget_usd = opts.budget_usd;
      }
      if (existing.schedule_value !== cron) {
        updates.schedule_type = 'cron';
        updates.schedule_value = cron;
        updates.next_run = CronExpressionParser.parse(cron, { tz: TIMEZONE }).next().toISOString();
      }
      if (Object.keys(updates).length > 0) {
        updateTask(id, updates);
        logger.info({ taskId: id, fields: Object.keys(updates) }, `Refreshed task: ${id}`);
      }
      return;
    }
    const nextRun = CronExpressionParser.parse(cron, { tz: TIMEZONE }).next().toISOString();
    createTask({
      id, group_folder: MAIN_GROUP_FOLDER, chat_jid: mainJid!,
      prompt, schedule_type: 'cron', schedule_value: cron,
      context_mode: 'isolated', next_run: nextRun, status: 'active',
      created_at: new Date().toISOString(), ...opts,
    });
    logger.info({ taskId: id, nextRun, group: opts?.group_folder ?? MAIN_GROUP_FOLDER }, `Seeded task: ${id}`);
  };

  seedTask('health-daily-check', '0 9 * * *',
    `Read the health snapshot at /workspace/ipc/health_snapshot.json and give a concise daily status report.
Include: WhatsApp connection status, last message time, recent disconnects, uptime, and any current issues.
If there are problems, suggest specific fixes. Keep it brief — this is a daily check-in, not a deep dive.
If everything looks good, just say so in one line.`);

  seedTask('health-weekly-deps', '0 10 * * 1',
    `Run a dependency health check:
1. Run \`npm outdated --json\` and report any outdated packages, especially @whiskeysockets/baileys
2. Run \`npm audit --json\` and report any critical or high severity vulnerabilities
3. If Baileys has an update available, note whether it's a patch/minor/major bump
Keep the report concise. Only flag things that need attention.`);

  seedTask('daily-digest-8am', '0 8 * * *',
    `Generate the daily morning digest for Blayk. Cover BOTH businesses comprehensively:

**SNAK GROUP (Vending):**
- Check IDDI for yesterday's sales totals, any expiring products in the next 7 days, and low-stock alerts
- Check Google Sheets for recent sales performance trends
- Check the CRM pipeline: any new leads, pending deals, or deals needing follow-up

**SHERIDAN RENTALS (Trailers/RVs):**
- Query the bookings database for today's pickups and returns
- List upcoming reservations for the next 7 days
- Flag any unpaid bookings or overdue payments
- Check the 3 equipment calendars for availability gaps

**ACROSS BOTH:**
- Check Google Calendar for today's appointments

Format as a clean, scannable snapshot. Use sections with headers. Keep it concise but complete. If a data source is unavailable, note it briefly and move on.

Send the digest via WhatsApp only. Do NOT send emails or SMS.`,
    { budget_usd: 0.50 });

  seedTask('sams-club-weekly-prices', '0 10 * * 1',
    `Run the weekly Sam's Club price update:

1. Read the current product list from the Google Sheets pricing tab
2. For each product, browse Sam's Club website to get the current price
3. Update the Google Sheets pricing tab with current prices and the date checked
4. Flag any significant price changes (>10% increase or decrease) from the previous week
5. Summarize results: how many products checked, any price changes, any products not found

Use browser automation to check Sam's Club prices. If a product page fails to load, note it and continue with the rest.`,
    { budget_usd: 0.50 });

  seedTask('follow-up-check', '0 10 * * *',
    `Check for stale customer inquiries that need follow-up:

1. Run: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 3
   This returns conversions stuck in 'inquiry' or 'quoted' stage.
2. Also check for quoted leads stale >5 days: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 5
3. For each stale entry, compose a brief, friendly follow-up message
4. Send follow-ups via WhatsApp ONLY. Do NOT send emails or SMS. Skip any conversions that originated from email or SMS channels.
5. Update the conversion with: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action update --id "<conv_id>" --notes "follow-up sent on [date]"
6. Report summary: how many follow-ups sent, which businesses

Be natural and helpful — not pushy. Reference their original inquiry. Example:
"Hi [name], just wanted to check in about the vending machine placement we discussed.
Still happy to help if you're interested! Let me know if you have any questions."

For Sheridan Rentals:
"Hi [name], following up on your trailer rental inquiry. We still have availability
if you're interested. Happy to answer any questions about the equipment."`,
    { budget_usd: 0.30 });

  seedTask('review-solicitation', '0 11 * * *',
    `Check for recently completed services that should get a review request:

1. Query completed conversions: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action query --stage completed
   Filter results to entries updated in the last 48 hours.
2. For each one, send a brief review request via WhatsApp ONLY. Do NOT send emails or SMS. Skip any conversions that originated from email or SMS channels.
3. Update to 'reviewed': npx tsx /workspace/project/tools/conversions/track-conversion.ts --action update --id "<conv_id>" --stage reviewed --notes "review requested on [date]"

For Snak Group:
"Thanks for choosing Snak Group for your breakroom vending! If you're enjoying the service,
we'd really appreciate a quick Google review — it helps other businesses find us.
[Include Google review link if available]"

For Sheridan Rentals:
"Thanks for renting with Sheridan! Hope everything went smoothly. If you have a moment,
a Google review would mean a lot to us.
[Include Google review link if available]"

Only send ONE review request per customer. Check notes for "review requested" before sending.`,
    { budget_usd: 0.20 });

  seedTask('weekly-revenue-dashboard', '0 9 * * 1',
    `Generate the weekly revenue and conversion dashboard for Blayk. Cover BOTH businesses:

**SNAK GROUP:**
1. Get conversion stats: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stats --business "snak-group" --days 7
2. Calculate conversion rate (inquiries → booked)
3. Total revenue from completed conversions this week vs. last week
4. Check stale leads: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 3
5. Top source channels (WhatsApp vs. email vs. SMS) for new inquiries

**SHERIDAN RENTALS:**
1. Get conversion stats: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stats --business "sheridan-rentals" --days 7
2. Fleet utilization: how many days were trailers/equipment rented vs. available
3. Revenue from completed rentals this week vs. last week
4. Upcoming returns this week
5. Any repeat customers (check conversion history for same customer_id)

**COMBINED:**
- Total revenue across both businesses this week
- Week-over-week growth percentage
- Pipeline value (sum of quoted + negotiating conversions)
- Complaint summary: npx tsx /workspace/project/tools/complaints/query-complaints.ts --action stats --days 7
- Check for open complaints: npx tsx /workspace/project/tools/complaints/query-complaints.ts --action open
- Top 3 action items for the coming week

Format as a clean, executive-style dashboard. Use numbers, not paragraphs.
Update the Google Sheet "Revenue Dashboard" tab if it exists.`,
    { budget_usd: 0.50 });

  seedTask('business-health-monthly', '0 8 1 * *',
    `Generate the monthly business health report. Run these tools and compile results:

1. Run business health score: npx tsx /workspace/project/tools/reporting/business-health.ts generate
2. Run demand forecast: npx tsx /workspace/project/tools/inventory/demand-forecast.ts generate
3. Run trend alerts: npx tsx /workspace/project/tools/inventory/trend-alerts.ts format
4. Run profitability analysis: npx tsx /workspace/project/tools/inventory/profitability.ts analyze
5. Run IDDI engagement: npx tsx /workspace/project/tools/iddi/iddi.ts engagement --days 30
6. Check Sheridan Rentals payments: npx tsx /workspace/project/tools/square/square.ts list-payments --begin "[30 days ago ISO]" --end "[now ISO]"

Compile into a single executive monthly report for Blayk covering:
- Overall business health score and grade (from business-health.json)
- Month-over-month score change and trend
- Revenue highlights and concerns
- Top 5 most profitable products and top 5 money losers
- Products trending up/down and any critical alerts
- Pipeline health and win rate
- Customer engagement metrics (QR scans, polls)
- Sheridan Rentals revenue summary
- Top 3 priorities for next month

Email the report to the owner (check owner-info.md). Also send a summary via WhatsApp.`,
    { budget_usd: 0.75 });

  // Responsive intake sweep — the heartbeat of SGS fulfillment. Runs every 20
  // min and acts ONLY on never-seen tickets (the `pending-new` work-list), so it
  // is idempotent: a ticket leaves the list the instant Andy claims or marks it
  // seen, and is never re-notified or re-worked. CLAIM-FIRST is the hard rule.
  seedTask('sgs-intake-sweep', '*/20 * * * *',
    `SGS intake sweep — pick up brand-new customer edit requests, fast and exactly once.

FIRST read groups/sgs/CLAUDE.md (rules) and groups/sgs/edit-lessons.md (what you learned).

1. Run: npx tsx /workspace/project/tools/web/ship-sgs.ts pending-new
2. If count is 0 → STAY SILENT: reply with EXACTLY [[SILENT]] and nothing else
   (this runs every 20 min; that token suppresses the message — do NOT add any other text).
3. Otherwise, for EACH ticket (HARD CAP: 3 per run; let the rest roll to the next sweep). The
   pending-new output already tells you the answer: a ticket with shippable:true is auto-eligible.
   a. WhatsApp Blayke ONE line: "📥 New request — {customer} · {site or 'unmapped'} · \"{title}\" ({sla}). On it."
   b. AUTO-ELIGIBLE (shippable:true — mapped site + safe content change): CLAIM FIRST →
      ship-sgs.ts claim {crId}. If claimed:false → another run took it → SKIP entirely. If
      claimed:true → REALITY-CHECK before editing: confirm the request maps to a real change in
      an actual SITE FILE. If, after investigating the repo, you find it is NOT a website edit —
      the thing it asks for lives in the app BACKEND / a database / external config (e.g. an
      in-app poll, product, pricing, or account data change), no site file matches the request,
      or the request is too ambiguous to execute faithfully — do NOT fabricate or guess an edit.
      Instead: ship-sgs.ts release {crId} --reason "<why it is not a website edit / what system it
      actually needs>", WhatsApp ONCE "🔎 Needs you — {customer}: \"{title}\". {reason}", and STOP
      on this ticket. Otherwise (it IS a real site edit): tri-lens review (🛠 engineer · 📈 marketer
      · 🙂 customer), make the edit, deploy a PREVIEW via the ship-site flow, then:
        ship-sgs.ts review-ready {crId} --preview {url} --note "<tri-lens summary>"
      and WhatsApp: "✅ Ready to review — {customer}: {preview}. {one-line tri-lens}. Approve in
      the admin Review column or reply 'approve {site}'." Do NOT promote in this run.
   c. NOT auto-eligible (shippable:false — unmapped site, or promo/checkout/booking/auth/api/
      secrets/new-page work): do NOT claim. Run ship-sgs.ts mark-seen {crId} (stamps the guard so
      it is never re-flagged; the ticket stays pending for you), then WhatsApp ONCE:
        "🔎 Needs you — {customer}: \"{title}\". {reason it needs a human}."
   d. If prep FAILS after you claimed an auto ticket (build/deploy error, or you simply cannot
      complete it): run ship-sgs.ts release {crId} --reason "<what failed>" — this returns it to
      pending WITH a note so it is VISIBLE to Blayke (never leave a claimed ticket silently stuck
      in_progress), keeps the seen-guard so the sweep will not re-claim and re-stall it, then
      WhatsApp ONCE "⚠️ Couldn't prepare {customer} \"{title}\": {reason} — left for you", run
      ship-sgs.ts log to record it, and STOP on that ticket. Do NOT retry it.

Never email customers. Never promote to prod here — that's the approval sweep's job.`,
    { budget_usd: 0.60, ...sgsTarget });

  // 7am daily digest — a read-only summary so Blayke starts the day with the full
  // picture. No edits, no claims here; the intake sweep does the work continuously.
  seedTask('sgs-daily-digest', '0 7 * * *',
    `SGS morning digest — give Blayke a clean read of the whole board. READ-ONLY (no edits/claims).

1. Read groups/sgs/CLAUDE.md and groups/sgs/edit-lessons.md.
2. Run: npx tsx /workspace/project/tools/web/ship-sgs.ts pending   (full open list, SLA-sorted)
3. Send Blayke ONE WhatsApp digest: overdue first, then by SLA. Per ticket: customer · title ·
   SLA · current state (awaiting your review / needs you / in progress) · your one-line tri-lens read.
4. End with what you SEE needs doing today (1-3 bullets). Do NOT prepare previews or change any
   status in this run — the intake sweep handles new tickets every 20 min. Never email customers.`,
    { budget_usd: 0.40, ...sgsTarget });

  // Once-daily loud-but-bounded check for tickets that got stuck mid-prep
  // (claimed → in_progress but never reached review_ready). Surfaces silent
  // failures without per-sweep spam.
  seedTask('sgs-stale-digest', '0 13 * * *',
    `SGS stale-ticket check — catch anything stuck so nothing fails silently in the background.

1. Run: npx tsx /workspace/project/tools/web/ship-sgs.ts pending  and also fetch in_progress via
   the get/list flow (status=in_progress). Identify tickets that have been in_progress > 12h with
   no previewUrl (Andy claimed them but prep didn't finish) — check agentNote for a FAILED marker.
2. If any exist, WhatsApp Blayke ONE digest listing them (customer · title · how long stuck · the
   FAILED reason if recorded) so he can re-run or handle them. If none, reply with
   EXACTLY [[SILENT]] and nothing else (that token suppresses the message).
3. Do NOT auto-retry them here (prevents loops). This is a visibility net, not a worker.`,
    { budget_usd: 0.30, ...sgsTarget });

  // Frequent sweep so an in-admin (or WhatsApp) approval ships promptly without
  // waiting for the 7am run. Cheap: usually a no-op when nothing is approved.
  seedTask('sgs-approval-sweep', '*/30 * * * *',
    `SGS approval sweep — promote anything Blayke just approved.

1. Run: npx tsx /workspace/project/tools/web/ship-sgs.ts approved
2. If count is 0 → STAY SILENT: reply with EXACTLY [[SILENT]] and nothing else
   (this runs every 30 min; that token suppresses the message).
3. For each approved+preview ticket: promote its site to PROD via the ship-site flow,
   verify a live 2xx (relay the verified receipt — never claim live without it), then:
     ship-sgs.ts complete <crId> -m "<what shipped + live URL>"
   SGS emails the customer and moves it to Done. You NEVER email customers.
4. Log the win: ship-sgs.ts log <crId> --site <site> --action auto --summary "..." --lesson "...".
5. WhatsApp Blayke a one-line "shipped: <customer> — <title> — <live URL>" per promotion.

Read groups/sgs/CLAUDE.md first. Respect every guardrail — if a promote fails verification,
do NOT mark complete; revert/triage and tell Blayke.`,
    { budget_usd: 0.40, ...sgsTarget });

  // Customer support replies — Andy answers portal Support questions the same way
  // he handles edits: his own agent, your Max subscription, NO API key. Advisory
  // only. Runs often so a customer gets an answer within a few minutes.
  seedTask('sgs-support-sweep', '*/5 * * * *',
    `SGS support sweep — answer customers waiting in the portal Support chat. Advisory only.

1. Run: npx tsx /workspace/project/tools/web/support-sgs.ts pending
2. If pendingCount is 0 → STAY SILENT: reply with EXACTLY [[SILENT]] and nothing else
   (this runs every 5 min; that token suppresses the message — never write anything else on empty).
3. The output includes "rulebook" (the rules you MUST follow) and "threads" (each = one
   customer waiting). For EACH thread (HARD CAP: 3 per run; the rest roll to the next sweep):
   a. Read the thread's "messages" (the conversation so far) and "context" (that customer's
      OWN plan, sites, and recent change requests — never reference anyone else's data).
   b. Write ONE helpful, warm, plain-language reply that obeys the rulebook:
      - Answer their question / explain status using the context.
      - If they want an actual edit, guide them to submit a Change Request (don't make the edit).
      - NEVER claim you did anything you can't do here. No binding price/time promises.
   c. Decide if this needs a human (upset, refund/cancellation/billing dispute, out of scope,
      asks for a person, or something urgent/broken). If so, add --escalate --reason "<why>".
   d. Post it: support-sgs.ts reply <organizationId> --message "<your reply>" [--escalate --reason "..."]
   e. If you escalated, also WhatsApp Blayke ONE line: "🆘 Support escalated — {orgName}: {why}."
4. Do NOT email customers (the reply lands in their portal thread). Do NOT edit or deploy any
   site from here. Do NOT post more than one reply per thread per run.

Read groups/sgs/CLAUDE.md first for customer-specific preferences.`,
    { budget_usd: 0.50, ...sgsTarget });

  // Weekly learning-loop consolidation: turn repeated lessons into standing rules
  // so Andy compounds skill instead of re-learning. This is the rulebook self-repair.
  seedTask('sgs-rulebook-review', '0 12 * * 0',
    `SGS weekly rulebook review — make the rulebook smarter from real outcomes.

1. Read groups/sgs/edit-lessons.md (the append-only learning log) and groups/sgs/CLAUDE.md.
2. Cluster the week's lessons. Any pattern that appears 2+ times, or any Blayke REJECTION,
   becomes a candidate standing rule.
3. PROMOTE durable patterns into groups/sgs/CLAUDE.md as concise rules (edit the file
   directly): customer preferences, what got rejected and why, what consistently worked,
   tighter guardrails. Keep CLAUDE.md tight — merge/replace, don't just append.
4. Prune stale or one-off notes from edit-lessons.md once promoted.
5. WhatsApp Blayke a short "what I learned this week + what I changed in the rulebook +
   what I see that needs doing" note (3-6 bullets, WhatsApp formatting).

This is how the operation gets smoother and more innovative every week. Never email customers.`,
    { budget_usd: 0.40, ...sgsTarget });
}

// ── CLI readiness check ───────────────────────────────────────────

export function checkCliReadiness(): void {
  if (!CLI_ENABLED) return;

  // Truth = the on-disk OAuth credentials the CLI actually authenticates with
  // (from `claude` login), NOT a CLAUDE_CODE_OAUTH_TOKEN env var. The run/refresh
  // paths deliberately strip env auth and use this file, so checking the env var
  // here was misleading (it reported "ready" while a stale file token 401'd).
  let ok = false;
  let detail = 'no credentials file — run `claude` as the service user to log in';
  try {
    const home = process.env.HOME || os.homedir();
    const creds = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf-8'));
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken) {
      const expMs = oauth.expiresAt ?? 0;
      if (!oauth.expiresAt || expMs > Date.now()) {
        ok = true;
        detail = oauth.expiresAt ? `token valid until ${new Date(expMs).toISOString()}` : 'token present (no expiry)';
      } else {
        detail = `token EXPIRED ${new Date(expMs).toISOString()} — re-auth: run \`claude\` as the service user`;
      }
    }
  } catch (err) {
    detail = `credentials unreadable (${err instanceof Error ? err.message : String(err)})`;
  }

  if (ok) {
    logger.info({ cli: true }, `CLI mode ready: ${detail}`);
  } else {
    const consequence = CLI_FALLBACK_ENABLED
      ? 'CLI_FALLBACK_ENABLED=true — tasks WILL fall back to container and BURN API CREDITS'
      : 'CLI_FALLBACK_ENABLED=false — the CLI-auth breaker will pause tasks and page you until re-auth';
    logger.warn({ cli: true, fallbackEnabled: CLI_FALLBACK_ENABLED }, `CLI auth NOT ready: ${detail}. ${consequence}.`);
  }
}

// ── Channel initialization ────────────────────────────────────────

export async function initChannels(queue: GroupQueue): Promise<WhatsAppChannel> {
  const whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => getRegisteredGroups(),
  });
  addChannel(whatsapp);

  const { QUO_API_KEY, QUO_CHANNEL_ENABLED } = await import('./config.js');
  if (QUO_API_KEY && QUO_CHANNEL_ENABLED === 'true') {
    const { QuoChannel } = await import('./channels/quo.js');
    const quo = new QuoChannel({
      onMessage: (chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => getRegisteredGroups(),
      shouldProcess: shouldProcessInbound,
    });
    addChannel(quo);
  }

  {
    const { WEB_CHANNEL_PORT } = await import('./config.js');
    if (WEB_CHANNEL_PORT) {
      const { WebChannel } = await import('./channels/web.js');
      const web = new WebChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => getRegisteredGroups(),
      });
      addChannel(web);
    }
  }

  {
    const { FB_PAGE_ACCESS_TOKEN } = await import('./config.js');
    if (FB_PAGE_ACCESS_TOKEN) {
      const { MessengerChannel } = await import('./channels/messenger.js');
      const messenger = new MessengerChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => getRegisteredGroups(),
        shouldProcess: shouldProcessInbound,
      });
      addChannel(messenger);
    }
  }

  {
    const { IMAP_USER: imapUser, GMAIL_CHANNEL_ENABLED } = await import('./config.js');
    if (imapUser && GMAIL_CHANNEL_ENABLED === 'true') {
      const { GmailChannel } = await import('./channels/gmail.js');
      const gmail = new GmailChannel({
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => getRegisteredGroups(),
        registerDerivedGroup,
        shouldProcess: shouldProcessInbound,
      });
      addChannel(gmail);
    }
  }

  const channels = getChannels();
  await Promise.all(channels.map((ch) => ch.connect()));

  // Wire escalation alerts now that channels are connected
  setEscalationAlert((jid, text) => routeOutbound(jid, text));

  return whatsapp;
}

// ── Service startup ───────────────────────────────────────────────

export function startServices(queue: GroupQueue, whatsapp: WhatsAppChannel): void {
  // HTTP health endpoint for monitoring
  startHealthServer({
    getStatus: () => ({
      uptime: process.uptime(),
      channels: Object.fromEntries(
        getChannels().map(ch => [ch.name, ch.isConnected() ? 'up' as const : 'down' as const]),
      ),
      activeGroups: Object.keys(getRegisteredGroups()).length,
      dailySpend: getDailySpendUsd(),
      pipelineStats: getPipelineStats(),
    }),
  });

  // Performance dashboard
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '9091', 10);
  startDashboard(dashboardPort);
  logger.info({ port: dashboardPort }, 'Dashboard started');

  const mainGroupJid = (): string | null => {
    for (const [jid, group] of Object.entries(getRegisteredGroups())) {
      if (group.folder === MAIN_GROUP_FOLDER) return jid;
    }
    return null;
  };

  // Wire the CLI-auth breaker's pager: WhatsApp main (works during a Claude-auth
  // outage — WhatsApp doesn't use Claude) + ntfy push as a backup channel.
  setCliAuthGateAlerter((message) => {
    const jid = mainGroupJid();
    if (jid) {
      routeOutbound(jid, message).catch((err: unknown) =>
        logger.warn({ err }, 'CLI-auth gate WhatsApp alert failed'),
      );
    }
    sendPushAlert(message);
  });

  startHealthMonitor({
    channels: getChannels(),
    sendAlert: (jid, text) => routeOutbound(jid, text),
    getMainGroupJid: mainGroupJid,
  });

  startSchedulerLoop({
    registeredGroups: () => getRegisteredGroups(),
    getSessions: () => getSessions(),
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await routeOutbound(jid, text);
    },
  });

  startIpcWatcher({
    sendMessage: (jid, text) => routeOutbound(jid, text),
    registeredGroups: () => getRegisteredGroups(),
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
}

// ── Database init + backup ─────────────────────────────────────────

export { initDatabase } from './db.js';

/**
 * Best-effort DB backup at startup — overwrites previous backup. Runs BEFORE the
 * DB handle is opened, so it's a raw file copy of the real DB (store/messages.db,
 * via DB_PATH). The previous instance checkpointed WAL on clean shutdown; the
 * daily in-process backup (health.ts) is the WAL-safe VACUUM INTO snapshot.
 * (Previously targeted DATA_DIR/data.db — a 0-byte stray — so startup "backups"
 * silently backed up nothing.)
 */
export function backupDatabase(): void {
  const dbPath = DB_PATH;
  const backupPath = dbPath + '.startup-backup';
  try {
    if (!fs.existsSync(dbPath)) return;
    fs.copyFileSync(dbPath, backupPath);
    // Include the WAL if present so the startup copy is restorable.
    const wal = dbPath + '-wal';
    if (fs.existsSync(wal)) fs.copyFileSync(wal, backupPath + '-wal');
    const sizeMb = (fs.statSync(backupPath).size / (1024 ** 2)).toFixed(1);
    logger.info({ backupPath, sizeMb }, 'Database backed up at startup');
  } catch (err) {
    logger.error({ err }, 'Database backup failed (non-fatal)');
  }
}
