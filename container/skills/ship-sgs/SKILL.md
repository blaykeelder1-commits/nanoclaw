---
name: ship-sgs
description: Handle Simple Growth Solutions (SGS) customer change requests end-to-end. Use when Blayke asks to check SGS tickets / edit requests, when the daily SGS digest runs, or when reviewing/approving/shipping a pending SGS website change over WhatsApp. Reviews every request through three lenses (engineer, marketer, customer), edits preview-first, and only marks Done after the change is verified live.
allowed-tools: Bash(npx tsx /workspace/project/tools/web/ship-sgs.ts *), Bash(npx tsx /workspace/project/tools/web/ship-site.ts *), Read, Edit, Write
---

# Fulfill an SGS customer change request (preview-first, tri-lens)

SGS is Blayke's website-as-a-service platform. Its customers submit edit requests
("change requests" / tickets) for **their own** websites. Your job: stay on top of
those tickets, fulfill the safe ones autonomously, and get better at it every time —
**but prod NEVER changes without Blayke's explicit approval over WhatsApp.**

Two tools, clear split:
- `ship-sgs.ts` — talks to the SGS platform: read tickets, write ticket status, log lessons.
- `ship-site.ts` — the actual edit + preview + promote engine (whitelisted sites). See the `ship-website` skill.

```bash
npx tsx /workspace/project/tools/web/ship-sgs.ts pending        # full open list (digest view)
npx tsx /workspace/project/tools/web/ship-sgs.ts pending-new    # NEW unseen tickets only — the intake-sweep work-list
npx tsx /workspace/project/tools/web/ship-sgs.ts get <crId>     # one ticket in full
npx tsx /workspace/project/tools/web/ship-sgs.ts claim <crId>   # atomic pending→in_progress; SKIP if claimed:false
npx tsx /workspace/project/tools/web/ship-sgs.ts mark-seen <crId> # stamp guard, leave pending (triage to human)
npx tsx /workspace/project/tools/web/ship-sgs.ts review-ready <crId> --preview <url> --note "<tri-lens summary>"
npx tsx /workspace/project/tools/web/ship-sgs.ts approved       # tickets Blayke approved → ready to promote
npx tsx /workspace/project/tools/web/ship-sgs.ts complete <crId> -m "<what shipped>"
npx tsx /workspace/project/tools/web/ship-sgs.ts log <crId> --site <s> --action auto|triage --summary "..." --lesson "..."
```

**Anti-retrigger (critical):** the intake sweep runs `pending-new` (only tickets with
`andySeenAt = NULL`) and acts on each exactly once. **Always `claim` before doing any edit work**
— the claim is atomic, so `claimed:false` means another run owns it and you must skip. For
out-of-scope tickets, `mark-seen` (don't claim) so they stay `pending` for Blayke but are never
re-flagged. A failed prep stays `in_progress` (never reverted to pending) so it can't re-fire.

**Approval is dual-surface.** When you set a ticket `review-ready`, it appears in the SGS
admin Dispatch **"Review"** column (with your preview link + note) AND you post it to the
SGS WhatsApp group. Blayke can approve from **either** — the admin **Approve** button or a
WhatsApp reply. Both set the ticket to `approved`; the `approved` command lists what's
approved-and-ready so you can promote it (the `sgs-approval-sweep` task does this every 30
min, so an admin approval ships even when you're not mid-conversation).

## Step 0 — Learn before you act (ALWAYS)

Before touching any ticket, **read `groups/sgs/edit-lessons.md`** (the learning loop)
and `groups/sgs/CLAUDE.md`. Past tickets tell you this customer's brand voice, what
they rejected last time, and patterns that already worked. You are expected to get
faster and more accurate every batch — reusing a known-good approach beats
re-deriving it.

## Step 1 — Triage the batch (daily digest)

Run `pending`. For each ticket the tool returns `site` (a whitelisted ship-site key,
or null), `suggestedAction` (auto / review / triage), and `needsHumanReasons`.

Sort your attention by SLA — overdue and `Xh left` first.

A ticket is **auto-eligible** only if ALL are true:
- `site` is non-null (maps to a whitelisted, Andy-controlled site), AND
- `suggestedAction` is not `triage`, AND
- it is copy / image / price / hours / SEO / section work — NOT the "Never auto-edit" list below.

Everything else → **triage to Blayke**: summarize it in the digest with the reason,
and stop. Do not guess at checkout/promo/booking/backend logic.

## Step 2 — The tri-lens review (the heart of this skill)

Before you write a single edit (and again when you summarize a triage), evaluate the
request through **three lenses**. Bake the incentives in: a sharper, more efficient
solution makes SGS look more professional, keeps customers happy, and earns **5-star
Google reviews** — that is the scoreboard.

1. **🛠 Senior software engineer** — Is this correct, minimal, and regression-safe?
   Smallest diff that fully solves it. No collateral changes. Will it build and render?
2. **📈 Marketer** — Does it convert and protect the brand? Clear CTA, on-brand tone,
   SEO-clean (titles/meta/alt), mobile-friendly, no degraded messaging. Can a small
   tasteful improvement (better headline, stronger CTA) deliver more than asked?
3. **🙂 Everyday customer** — Does it actually solve what they wanted, in plain terms?
   Is it obvious, trustworthy, and pleasant? Would *they* be impressed enough to leave
   a good review?

If the three lenses disagree, prefer the option that is safe (engineer) and on-brand
(marketer) while fully meeting the ask (customer). Note the call in your WhatsApp
message so Blayke sees the reasoning.

## Step 3 — Edit + preview (auto-eligible tickets only)

Use the `ship-website` flow on the mapped `site`:
```bash
npx tsx /workspace/project/tools/web/ship-site.ts start <site>      # clean checkout, prints path
# ... Read/Edit the requested change in that path (apply the tri-lens conclusions) ...
npx tsx /workspace/project/tools/web/ship-site.ts preview <site> -m "CR <id>: <one-line>"
```
The preview URL **is the sandbox**. Register it on the ticket so it shows in the admin
Review column, then message Blayke on WhatsApp and **STOP**:
```bash
npx tsx /workspace/project/tools/web/ship-sgs.ts review-ready <crId> --preview <previewUrl> \
  --note "Changed: <one line>. Tri-lens: 🛠 <…> · 📈 <…> · 🙂 <…>"
```
> 🎫 *<customer> — <ticket title>* (CR `<id>`, SLA <sla>)
> Preview: <previewUrl>
> Changed: <one line>. Tri-lens: 🛠 <…> · 📈 <…> · 🙂 <…>
> Approve here (reply *approve <site>*) or in the admin Review column — either ships it.

**Hard cap: at most 3 previews prepared per run.** Let the rest roll to the next run.
Do NOT promote. Do NOT say it's live.

## Step 4 — WhatsApp review loop (be in tune with Blayke)

Approval arrives on **either** surface — a WhatsApp reply OR the admin **Approve** button
(which sets the ticket to `approved`; the `sgs-approval-sweep` task picks it up via the
`approved` command and promotes it). Handle whichever comes:
- **approve / ship it / yes / go live** (WhatsApp) OR **status flips to `approved`** (admin)
  → promote, verify, then close the ticket (Step 5).
- **"change X" / "make it warmer" / any edit** → re-Read/Edit on the same checkout and
  run `preview` again, then `review-ready` again (it replaces the pending one). Re-state the
  tri-lens delta. Stop.
- **no / reject / discard** (WhatsApp) OR **status flips to `rejected`** (admin) →
  `ship-site.ts discard <site>`, set `status <crId> rejected -m "<why>"` if not already,
  and **ALWAYS log the rejection as a lesson** (Step 5) — a reject is the highest-value
  learning signal.
- **questions** → answer from the ticket/checkout; never invent. If unsure, ask Blayke.

Always relay tool receipts verbatim. A change is "live" ONLY when the promote receipt
says `"verified": true` with a `liveUrl`.

## Step 5 — Close the loop + record the lesson

After a verified promote:
```bash
npx tsx /workspace/project/tools/web/ship-sgs.ts complete <crId> -m "<what shipped> — <liveUrl>"
```
SGS then **emails the customer and moves the ticket to Done**. (You do NOT email the
customer — that is SGS's job. Andy's email lockdown stays in force.)

Then **always** record a lesson so you improve next time:
```bash
npx tsx /workspace/project/tools/web/ship-sgs.ts log <crId> --site <site> --action auto \
  --summary "<what you did>" --lesson "<what worked / what to do differently / this customer's preference>"
```
Log triaged tickets too (`--action triage --lesson "why it needed a human"`). **Always log
rejections** (`--action triage --lesson "Blayke rejected because <reason> — next time <do X>"`)
— rejections are the strongest signal for getting better. When a lesson repeats across
tickets, promote it into `groups/sgs/CLAUDE.md` as a standing rule (the weekly
`sgs-rulebook-review` task also does this consolidation automatically).

## Never auto-edit — triage to Blayke instead

These are out of scope for an autonomous edit (flag them in the digest with the reason):
- Promo / coupon / discount codes (e.g. "DAD10"), pricing logic, anything under `api/` or a Pages Function.
- Checkout, payment, booking, refund, or account/auth logic.
- `.env`, secrets, tokens, integrations, dependency bumps, build-config changes.
- Deleting pages/sections wholesale, renaming routes, adding new pages.
- Tickets needing an asset you don't have (uploaded PDF/photo) — ask Blayke for it.
- Any site not mapped to a whitelisted ship-site key.

## Loud failure — never claim success you can't prove

Every tool prints one JSON receipt and exits non-zero on failure. Relay failures as
failures. Never mark a ticket `complete` unless the site promote was `verified: true`.
The whole point: the customer's site is only changed when the engine verified the live URL.
