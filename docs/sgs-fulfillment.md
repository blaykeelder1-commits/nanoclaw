# SGS Edit-Request Fulfillment (Andy)

Andy handles Simple Growth Solutions (SGS) customer **change requests** (edit tickets)
through the same preview→approve→prod engine used for the other whitelisted sites.
SGS is a website-as-a-service platform: its customers submit edits for *their* sites;
those tickets land on the SGS admin Dispatch Board.

## How it works

- **Daily trigger:** the seeded cron task `sgs-daily-triage` (07:00, `MAIN` group, CLI/Max =
  $0) runs `tools/web/ship-sgs.ts pending`, reviews each ticket through three lenses
  (engineer / marketer / customer), and posts one SLA-sorted digest to Blayke's WhatsApp.
- **Auto-eligible tickets** (mapped to a whitelisted site + safe content change) get a
  **preview** deploy; the preview URL is posted for approval. Prod never changes without
  Blayke replying *approve* (the `ship-sgs` skill handles that turn).
- **On approve:** promote → verify live 2xx → `ship-sgs.ts complete <id>` flips the ticket
  to Completed. **SGS** then emails the customer and the board moves it to Done. Andy never
  emails customers (email lockdown stays in force).
- **Learning loop:** every shipped/triaged ticket gets a `ship-sgs.ts log` entry in
  `groups/sgs/edit-lessons.md`; repeating lessons get promoted into `groups/sgs/CLAUDE.md`.

## Components

| Piece | Path |
|---|---|
| Platform bridge (CR read/write + triage hints + lesson log) | `tools/web/ship-sgs.ts` |
| Deploy engine (edit + preview + promote), reused | `tools/web/ship-site.ts` |
| Skill (ties it together, tri-lens, WhatsApp loop) | `container/skills/ship-sgs/SKILL.md` |
| Group rules + learning log | `groups/sgs/CLAUDE.md`, `groups/sgs/edit-lessons.md` |
| Daily task seed | `src/bootstrap.ts` → `seedTask('sgs-daily-triage', …)` |
| Secret scope (`sgs`) | `src/cli-runner.ts`, `src/container-runner.ts` |
| SGS-side headless auth | `simple-growth-solutions/src/lib/api/with-auth.ts` (Bearer `ANDY_SERVICE_TOKEN`) |

## Deploy (one-time)

Pick one shared secret value for `ANDY_SERVICE_TOKEN` and set it in BOTH places.

**1) SGS (Render, service `srv-d856tn99rddc73a3u9kg`):**
- Add env var `ANDY_SERVICE_TOKEN=<token>` and redeploy.
- (Optional) confirm the deploy picked up `src/lib/api/with-auth.ts`.

**2) NanoClaw VPS (`ssh nanoclaw`):**
- Add to `.env`:
  ```
  ANDY_SERVICE_TOKEN=<same token>
  SGS_BASE_URL=https://simple-growth-solution.com
  ```
- Deploy the code (fold any VPS-local edits into a commit first — the tree drifts),
  then restart: `sudo systemctl restart nanoclaw` (wait ~15s for tsx restart).
- On boot, `seedHealthTasks()` inserts `sgs-daily-triage` (idempotent — skips if present).

## Verify

1. **Token path (negative):** `curl -s -o /dev/null -w "%{http_code}" \
   https://simple-growth-solution.com/api/admin/change-requests?status=pending` → **401**.
2. **Token path (positive):** add `-H "Authorization: Bearer <token>"` → **200** with the
   open change requests (today: the WRKC "DAD10" promo ticket).
3. **Tool:** on the VPS, `npx tsx tools/web/ship-sgs.ts pending` → JSON listing the ticket
   with `suggestedAction: "triage"` and a `needsHumanReasons` entry for the promo code.
4. **Task seeded:** confirm a row for `sgs-daily-triage` exists and `next_run` is set.
5. **End-to-end (dry):** on a throwaway whitelisted test site, create a content CR →
   confirm the preview URL posts to WhatsApp, *approve* promotes (`verified: true`), and the
   ticket flips to Done with the customer email sent by SGS.

## Guardrails (enforced by skill + group rules)

Never auto-edit: promo/discount codes, checkout/payment/booking/auth logic, anything under
`api/`, secrets/env, dependency bumps, page/route structure, unmapped sites, or tickets
needing an asset you don't have. Triage those to Blayke. Prod only changes after an explicit
WhatsApp approval and a verified live URL.
