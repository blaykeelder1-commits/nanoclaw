---
name: vending-inventory
description: Track vending machine inventory by pulling sales data from HahaVending and Vendera, updating the Google Sheets inventory spreadsheet, and generating shopping lists. Use for any vending-related questions about sales, inventory, or restocking.
allowed-tools: mcp__playwright__*, Bash(npx tsx /workspace/project/tools/sheets/sheets.ts *), Bash(npx tsx /workspace/project/tools/inventory/reconcile.ts *), Bash(npx tsx /workspace/project/tools/inventory/demand-forecast.ts *), Bash(npx tsx /workspace/project/tools/inventory/trend-alerts.ts *)
---

# Vending Machine Inventory Automation

## Overview

Daily/weekly automation:
1. Log into HahaVending and Vendera via Playwright MCP, pull this week's sales
2. Update the Google Sheets inventory spreadsheet
3. **Run `reconcile full`** to cross-examine all sources (IDDI + Sheets)
4. Use reconciliation output to generate the WhatsApp report (shopping list, blacklist alerts, discrepancies)
5. Search for replacement products when items are blacklisted (use `WebSearch`, NOT browser automation, for Sam's Club / Costco)
6. Send summary + shopping list as ONE WhatsApp message to the main group

## MANDATORY RULES

1. **ONE MESSAGE ONLY:** Send exactly ONE WhatsApp message with the complete consolidated report. Do NOT send progress updates. Work silently until done, then send one clean report.
2. **WRITE TO SHEETS:** You MUST update Google Sheets (Sales Performance, Warehouse Inventory, Ordering List) — not just read them. Use the sheets tool with `write` and `append` commands.
3. **COMBINE PLATFORMS:** Merge sales from HahaVending + Vendera into unified per-product totals. Show platform breakdown, but unified totals.
4. **ALL MACHINES:** Account for every machine across both platforms. List all reporting machines.
5. **NO INTERNAL TAGS:** Never wrap your final output in `<internal>` tags. The report goes to the user via `mcp__nanoclaw__send_message`.
6. **PARTIAL REPORTS ALLOWED:** Try BOTH platforms (up to 3 retries each). If one succeeds and the other fails:
   - Send the report with the data you DO have
   - Clearly label which platform's data is included and which failed
   - Add a warning line: "⚠️ [Platform] was unavailable — data from [Other Platform] only. Totals may be incomplete."
   - Still run reconciliation and demand forecast with available data
   - If BOTH platforms fail after retries, escalate via `mcp__nanoclaw__escalate` (severity=urgent) so Blayke can intervene.

## Credentials

Login credentials are in the group's CLAUDE.md under "Platform Credentials": `/workspace/group/CLAUDE.md`. Read CLAUDE.md FIRST. Extract the email/password for both platforms (`HAHA_EMAIL`/`HAHA_PASSWORD` and `VENDERA_EMAIL`/`VENDERA_PASSWORD`).

## Browser Automation — Playwright MCP

Use the `mcp__playwright__*` tool family. Playwright auto-waits for elements; explicit `wait` calls are rarely needed. The standard flow is **navigate → snapshot → identify ref → click/type by ref**.

### Tool reference

- `mcp__playwright__browser_navigate { url }` — open a URL (auto-waits for `load`)
- `mcp__playwright__browser_snapshot` — accessibility tree of the page; returns elements with `ref` like `e1`, `e2`
- `mcp__playwright__browser_click { ref }` — click an element by ref
- `mcp__playwright__browser_type { ref, text, submit?: boolean }` — type into an input
- `mcp__playwright__browser_fill_form { fields: [{ ref, value }, ...] }` — fill multiple fields at once
- `mcp__playwright__browser_wait_for_text { text }` — wait until text appears (use for redirects)
- `mcp__playwright__browser_press_key { key }` — press a key (e.g. "Enter")
- `mcp__playwright__browser_take_screenshot` — debug screenshot
- `mcp__playwright__browser_close` — close the browser when done (frees memory)
- `mcp__playwright__browser_evaluate { function }` — run JS for edge cases (e.g. extract a structured table)

### Session persistence

Playwright MCP persists browser context across calls in a single agent run. Login once early, then navigate multiple URLs without re-logging-in. **DO NOT** call `browser_close` between Haha and Vendera — keep one browser context for the whole skill execution. Close at the very end.

If a session has been saved from a prior run via Playwright's `storageState`, the dashboard may load directly without showing the login form. After navigating, always snapshot first to detect which page you actually landed on.

### Login retry logic

If login fails (wrong page, timeout, or visible error):
1. **Attempt 1:** `browser_close`, re-navigate to login URL, retry login
2. **Attempt 2:** `browser_close`, wait 5s, retry once more
3. **Attempt 3:** `browser_close`, retry one final time

After 3 attempts, do NOT proceed with partial data. Send WhatsApp:
```
*VENDING INVENTORY — Login Failed*
Platform: [name]
Attempts: 3
Last error: [what you saw on screen / which fields were missing]
Action needed: Verify credentials in CLAUDE.md are still valid
```

## Platform: HahaVending

### Login

```
mcp__playwright__browser_navigate { url: "https://thorh5.hahabianli.com/pages/login/login" }
mcp__playwright__browser_snapshot
```

If a login form is visible (look for email + password inputs):
- `browser_type` into the email input ref with `$HAHA_EMAIL`
- `browser_type` into the password input ref with `$HAHA_PASSWORD`
- `browser_click` the Sign in button ref
- `browser_wait_for_text { text: "Dashboard" }` (or any text that confirms post-login state)
- `browser_snapshot` to confirm

If you land on the home/dashboard directly (existing session), proceed to sales data.

If redirected to `/pages/login/register`, look for a "Login" link and click it first.

### Getting weekly sales data

Calculate this week's Monday and Friday in YYYY-MM-DD, then:

```
mcp__playwright__browser_navigate { url: "https://thorh5.hahabianli.com/pages/statistics/product-sales-ranking?start_time=YYYY-MM-DD&end_time=YYYY-MM-DD&tabIndex=2" }
mcp__playwright__browser_snapshot
```

Read each row from the snapshot: Product name, Sales ($), Sales volume (quantity). The accessibility tree usually surfaces tables row-by-row; if not, scope the snapshot or use `browser_evaluate` to read the DOM table.

If "Sales volume" column is hidden, scroll right with `browser_evaluate { function: "() => window.scrollBy(200, 0)" }` and re-snapshot.

### Fallback navigation (if direct URL fails)

1. From dashboard, click "More" (top right) → "Data Center"
2. Click "Week" tab
3. Scroll to "Product Ranking" section
4. Click "More >" for full list

## Platform: Vendera

### Login

```
mcp__playwright__browser_navigate { url: "https://vms.vendera.ai/login" }
mcp__playwright__browser_snapshot
```

If a login form is visible:
- `browser_type` email field with `$VENDERA_EMAIL`
- `browser_type` password field with `$VENDERA_PASSWORD`
- `browser_click` the orange Login button
- `browser_wait_for_text { text: "Dashboard" }` or `wait_for_text { text: "Transaction" }`
- `browser_snapshot` to confirm

If you land on `/home` directly, the session is still valid — proceed.

### Getting weekly sales data

```
mcp__playwright__browser_navigate { url: "https://vms.vendera.ai/home" }
mcp__playwright__browser_snapshot
```

Process:
1. Scroll past Transaction/Revenue/Machine Overview cards
2. Find "Product Sales Ranking" section
3. Click "Past Week" tab (use snapshot ref)
4. Click "By Items Sold" sort
5. Read each row: product name, Quantity, Revenue
6. Check pagination ("Page X of Y") — click "Next >" until all pages read
7. Record every product name and its quantity sold

**Key URLs:**
- Dashboard: `https://vms.vendera.ai/home`
- Sales Transactions: `https://vms.vendera.ai/orders/orders/sale`
- Product Library: `https://vms.vendera.ai/products/products/library`

## Spreadsheet Structure

**Spreadsheet:** "snak group inventory tracker"

### Tab: Warehouse Inventory
| Column | Field |
|--------|-------|
| A | SKU |
| B | Product Name |
| C | Current Stock |
| D | Starting amount |
| E | Color Code |
| F | Expiration date |
| G | Re-Order amount |

**Warehouse Color Codes (column E) — STOCK LEVEL indicator:**
- **Red** = Low stock, running out
- **Yellow** = Moderate stock, still OK for now
- **Green** = Well stocked, plenty on hand

### Tab: Sales Performance
Tracks sales over a 4-week rolling trial per product. Has Week 1, Week 2, Week 3, Week 4 columns.

**Sales Performance Color Codes — DEMAND indicator:**
- **Green** = Selling well, high demand
- **Yellow** = Moderate sales, decent demand
- **Red** = Slow seller, low demand

### Tab: Ordering List
Generated shopping list output.

## CRITICAL: Reorder Decision Matrix

**Always check Warehouse Inventory color FIRST, then cross-reference Sales Performance.**

| Warehouse Color | Sales Performance Color | Action |
|----------------|------------------------|--------|
| RED (low stock) | GREEN (selling well) | REORDER |
| RED (low stock) | YELLOW (moderate sales) | REORDER |
| RED (low stock) | RED (slow seller) | DO NOT REORDER |
| YELLOW (OK stock) | Any color | DO NOT REORDER (enough stock) |
| GREEN (well stocked) | Any color | DO NOT REORDER (plenty on hand) |

**Key rule:** Only reorder items that are BOTH low on stock (red warehouse) AND actually selling (green/yellow sales).

## Blacklist Process

Items are NOT blacklisted immediately. They go through a 4-week trial:

1. **Week 1-3 of poor sales:** Item shows as red in Sales Performance but stays active. Include in report as "approaching blacklist" warning.
2. **Week 4 of consecutive poor sales:** Item is officially blacklisted for 3 months. Do NOT reorder.
3. **After 3 months:** Item comes off blacklist and can be retried.

When inputting weekly sales, use the correct week column (Week 1, 2, 3, or 4) so the 4-week trial tracks properly.

## Replacement Product Search

When an item is blacklisted:
1. Use `WebSearch` to find similar products at Sam's Club and Costco
2. Suggest 2-3 replacement options with:
   - Product name
   - Price (if visible)
   - Pack size
   - Which store (Sam's Club or Costco)

Do NOT use Playwright MCP on Sam's Club or Costco — they aggressively block headless browsers. WebSearch only.

## Step-by-step: Update Spreadsheet

### 1. Read all tabs

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Warehouse Inventory!A:G"
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Sales Performance!A:Z"
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Ordering List!A:Z"
```

### 2. Update Sales Performance

Record this week's sales in the correct week column (1, 2, 3, or 4). After week 4, the cycle resets.

### 3. Update Warehouse Inventory

Subtract this week's total sold from Current Stock (column C).

### 4. Run Reconciliation

```bash
npx tsx /workspace/project/tools/inventory/reconcile.ts full --yo-offset 2
```

This pulls IDDI data + the freshly-updated Sheets data and produces:
- `reorder_list` — what to buy (drives the shopping list section)
- `blacklist_warnings` — products approaching blacklist (1-3 red weeks)
- `blacklist_now` — products hitting 4 red weeks
- `coming_off_blacklist` — products eligible to retry
- `discrepancies` — products in one source but not the other

**Use this output to generate the WhatsApp report** instead of manually reading each sheet. The reconciliation engine already applies the reorder matrix and blacklist logic.

## Shopping List Format (WhatsApp)

```
*Weekly Vending Report — [Date]*

*SHOPPING LIST (Reorder from Sam's Club):*
• [Product] — buy [X] (warehouse: RED, sales: GREEN)
• [Product] — buy [X] (warehouse: RED, sales: YELLOW)

*WELL STOCKED (no reorder needed):*
• [Product] — [X] remaining (warehouse: yellow/green)

*APPROACHING BLACKLIST (warning — red sales [X] weeks):*
• [Product] — slow sales week [2/4], [X] units this week

*NEWLY BLACKLISTED (4 weeks poor sales — pulled for 3 months):*
• [Product] — avg [X] units/week over 4 weeks
  Suggested replacements:
  - [New product] from Sam's Club ($X, pack of Y)
  - [New product] from Costco ($X, pack of Y)

*COMING OFF BLACKLIST SOON:*
• [Product] — blacklisted [date], eligible to retry [date]

*MACHINE PERFORMANCE:*
• Machines reporting: [X] HahaVending / [X] Vendera
• Top machine: [Machine Name] — $[X] revenue
• Zero-sales machines: [list any with $0 this week — potential issue]

*SALES HIGHLIGHTS:*
• Top seller: [Product] — [X] units
• Total units sold: [X]
• HahaVending: [X] / Vendera: [X]
```

Use WhatsApp formatting: single *bold*, _italic_, bullet points. No markdown headings.

## Execution Order

Follow this exact sequence:

1. Read CLAUDE.md — get credentials
2. Read Google Sheets (all 3 tabs) — understand current state
3. Login to HahaVending via Playwright — pull weekly sales (retry up to 3x)
4. Login to Vendera via Playwright — pull weekly sales (retry up to 3x). Reuse the same browser context.
5. If at least ONE platform succeeded: combine available data, update sheets
6. Run reconciliation: `npx tsx /workspace/project/tools/inventory/reconcile.ts full --yo-offset 2`
7. Run demand forecast: `npx tsx /workspace/project/tools/inventory/demand-forecast.ts generate`
8. Run trend alerts: `npx tsx /workspace/project/tools/inventory/trend-alerts.ts check`
9. Capture per-machine data — note which machines reported and their individual revenue.
10. Generate and send ONE WhatsApp message with the complete report (include trending up/down highlights from forecast + any critical/warning alerts from trend-alerts + machine performance section).
11. If one platform failed: include data from the successful platform, add the warning note about the failed platform.
12. If BOTH platforms failed after 3 retries: call `mcp__nanoclaw__escalate` (severity=urgent) requesting manual intervention.
13. `mcp__playwright__browser_close` to free memory.
