---
name: ship-website
description: Edit and deploy Blayke's whitelisted business websites (Sheridan Trailer Rentals, IDDI vending front-end). Use when Blayke asks to change/update/edit a website — a headline, price, image, button, copy, SEO text — or to preview, approve, ship, promote, or discard a pending website change. Preview-first: deploy a preview, get approval, then ship to prod.
allowed-tools: Bash(npx tsx /workspace/project/tools/web/ship-site.ts *), Read, Edit, Write
---

# Ship a Website Change (preview-first)

You can make real edits to two of Blayke's live sites and deploy them — but **prod
never changes without Blayke's explicit approval**. The flow always spans two
WhatsApp turns: **preview now → Blayke approves → promote to prod**. State is kept
on disk by the tool, so each turn is independent.

Whitelisted sites (the `<site>` argument): `sheridan`, `iddi`.

Run `npx tsx /workspace/project/tools/web/ship-site.ts list` to see them and whether
a change is already pending.

## Turn 1 — Blayke asks for an edit

1. **Sync a clean checkout** and get its path:
   ```bash
   npx tsx /workspace/project/tools/web/ship-site.ts start <site>
   ```
   This prints `path` — the local repo folder. Use the real path it returns.

2. **Make the edit** with Read/Edit in that folder. Change only what Blayke asked for.
   Keep edits minimal — copy/text/price/image/section/SEO only (see "Never do" below).

3. **Deploy a preview** and record it:
   ```bash
   npx tsx /workspace/project/tools/web/ship-site.ts preview <site> -m "<one-line summary of the change>"
   ```
   The receipt includes `previewUrl`, the changed `files`, and the `commit`.

4. **Reply to Blayke** with the preview URL and a one-line summary of what changed,
   then **STOP and wait**. For example:
   > Preview ready: <previewUrl>
   > Changed the homepage headline to "…". Reply *approve* to ship it live, or tell me what to fix.

   Do NOT touch prod. Do NOT say it's live.

## Turn 2 — Blayke replies

- **"approve" / "ship it" / "yes" / "go live"** → promote to prod and verify:
  ```bash
  npx tsx /workspace/project/tools/web/ship-site.ts promote <site>
  ```
  Only report success if the receipt has `"verified": true` and a `liveUrl`. Then reply:
  > ✅ Live at <liveUrl> · commit <commit> · verified <httpStatus>

- **"no" / "change X" / wants edits** → either re-edit and run `preview` again (it
  replaces the pending one), or throw it away:
  ```bash
  npx tsx /workspace/project/tools/web/ship-site.ts discard <site>
  ```

If you're unsure whether something is pending, check first:
```bash
npx tsx /workspace/project/tools/web/ship-site.ts status <site>
```

## Loud failure — never claim success you can't prove

Every command prints a single JSON receipt and **exits non-zero on any failure**.

- **Relay the receipt** — don't paraphrase a failure into "done".
- After `promote`, you may only tell Blayke it's *live* when the receipt says
  `"verified": true`. If `status` is `"error"`, send Blayke the `error` (and `detail`)
  text and stop — do not pretend it shipped.
- This is the whole point: the past failure mode was Andy saying "done" while nothing
  shipped. A change is only done when the tool verified the live URL.

## Never do (escalate to Blayke first via mcp__nanoclaw__escalate)

These are out of scope for a quick edit — flag them instead of editing:
- Booking, checkout, or payment logic; anything under an `api/` folder or a Pages Function.
- `.env`, secrets, tokens, or config that affects how the site talks to a backend.
- Deleting pages, deleting sections wholesale, or renaming routes.
- Dependency bumps (`package.json`) or build-config changes.
- Any site not in the whitelist (`sheridan`, `iddi`).

## Notes
- `sheridan` is a static HTML + Tailwind site; the deploy folder is the repo root.
- `iddi` is a React (CRA) app; it deploys the built `build/` folder.
- Both prod environments are the Cloudflare Pages **`main`** branch. The tool already
  passes `--branch main` on promote — never deploy prod by hand.
