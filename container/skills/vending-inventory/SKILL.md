---
name: vending-inventory
description: Track vending machine inventory by pulling sales data from HahaVending and Vendera, updating the Google Sheets inventory spreadsheet, and generating shopping lists. Use for any vending-related questions about sales, inventory, or restocking.
allowed-tools: Bash(agent-browser:*), Bash(npx tsx /workspace/project/tools/sheets/sheets.ts *)
---

# Vending Machine Inventory Automation

## Overview

Weekly automation (runs every Friday at 7pm Central):
1. Log into HahaVending and Vendera to pull the full week's sales
2. Update the Google Sheets inventory spreadsheet
3. Generate a shopping list based on warehouse stock levels + sales performance
4. Search for replacement products when items are blacklisted
5. Send summary + shopping list via WhatsApp

## MANDATORY RULES

1. **ONE MESSAGE ONLY:** Send exactly ONE WhatsApp message with the complete consolidated report. Do NOT send progress updates, status messages, or multiple messages. Work silently until done, then send one clean report.
2. **WRITE TO SHEETS:** You MUST update Google Sheets (Sales Performance, Warehouse Inventory, Ordering List) — not just read them. Use the sheets tool with `write` and `append` commands.
3. **COMBINE PLATFORMS:** Merge sales from HahaVending + Vendera into unified per-product totals. Show platform breakdown in the report but totals should be combined.
4. **ALL MACHINES:** Account for every machine across both platforms. List all reporting machines in the report.
5. **NO INTERNAL TAGS:** Never wrap your final output in `<internal>` tags. The report must be delivered to the user via `send_message`.

## Credentials

Login credentials are in the group's CLAUDE.md: `/workspace/group/CLAUDE.md`

## Platform Navigation: Vendera

**Login URL:** `https://vms.vendera.ai/login`

### Login steps:
1. `agent-browser open https://vms.vendera.ai/login`
2. `agent-browser snapshot -i` — look for Email and Password fields
3. Fill email field with credentials from CLAUDE.md
4. Fill password field
5. Click the orange "Login" button
6. Save auth state: `agent-browser state save vendera-auth.json`

### Getting weekly sales data:
1. After login, you land on Dashboard (`/home`)
2. Scroll down past the Transaction/Revenue/Machine Overview cards
3. Find the **"Product Sales Ranking"** section
4. Click **"Past Week"** tab (shows Mon-Sun date range)
5. Click **"By Items Sold"** to sort by quantity
6. Read the product list: each row has product image, name, Quantity, Revenue
7. Click **"Next >"** at bottom to go to page 2 if there are more products (check "Page X of Y")
8. Record every product name and its Quantity sold

**Key URLs:**
- Dashboard: `https://vms.vendera.ai/home`
- Sales Transactions: `https://vms.vendera.ai/orders/orders/sale`
- Product Library: `https://vms.vendera.ai/products/products/library`

## Platform Navigation: HahaVending

**Login URL:** `https://thorh5.hahabianli.com/pages/login/login`

NOTE: This URL may redirect to `/pages/login/register` (Sign up page). If that happens, scroll down to find a "Login" link, or the browser may auto-login from saved state.

### Login steps:
1. `agent-browser open https://thorh5.hahabianli.com/pages/login/login`
2. `agent-browser snapshot -i`
3. If on Sign up page, look for "Login" link and click it
4. Fill Email address and Password fields with credentials from CLAUDE.md
5. Click the Login/Sign in button
6. Save auth state: `agent-browser state save hahavending-auth.json`

### Getting weekly sales data:
**METHOD 1 (Preferred — direct URL with date parameters):**
1. Calculate this week's Monday and Friday dates (YYYY-MM-DD format)
2. Navigate directly to: `https://thorh5.hahabianli.com/pages/statistics/product-sales-ranking?start_time=YYYY-MM-DD&end_time=YYYY-MM-DD&tabIndex=2`
3. This shows the full Product Ranking page with all products
4. Read each row: Product name, Sales ($), Sales volume (quantity)
5. Scroll down to see all products (it's a single scrollable list)
6. The "Sales volume" column may require swiping/scrolling left — use `agent-browser snapshot` to read the page text which includes all columns

**METHOD 2 (Manual navigation):**
1. After login, land on home page showing "Snak group" with Daily/Monthly Sales
2. Click **"More"** button (top right, next to sales summary) — goes to Data Center
3. Click **"Week"** tab at top of Data Center page (`/pages/statistics/statistics`)
4. Scroll down to **"Product Ranking"** section
5. Click **"More >"** to see full product list
6. Read Product name + Sales volume for each item
7. Scroll down to see all products

**Key URLs:**
- Home: `https://thorh5.hahabianli.com/`
- Data Center: `https://thorh5.hahabianli.com/pages/statistics/statistics`
- Product Ranking (direct): `https://thorh5.hahabianli.com/pages/statistics/product-sales-ranking?start_time=YYYY-MM-DD&end_time=YYYY-MM-DD&tabIndex=2`

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
1. Open Sam's Club website (`https://www.samsclub.com`) and search for similar products in the same category
2. Open Costco website (`https://www.costco.com`) and search for similar products
3. Suggest 2-3 replacement options with:
   - Product name
   - Price (if visible)
   - Pack size
   - Which store (Sam's Club or Costco)

This keeps the product lineup fresh — always rotating in new items to replace underperformers.

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
• [Product] — slow sales week [3/4], [X] units this week

*NEWLY BLACKLISTED (4 weeks poor sales — pulled for 3 months):*
• [Product] — avg [X] units/week over 4 weeks
  Suggested replacements:
  - [New product] from Sam's Club ($X, pack of Y)
  - [New product] from Costco ($X, pack of Y)

*COMING OFF BLACKLIST SOON:*
• [Product] — blacklisted [date], eligible to retry [date]

*SALES HIGHLIGHTS:*
• Top seller: [Product] — [X] units
• Total units sold: [X]
• HahaVending: [X] / Vendera: [X]
```

Use WhatsApp formatting: single *bold*, _italic_, bullet points. No markdown headings.

## Important Notes

- Always try loading saved auth state before logging in: `agent-browser state load <name>.json`
- Always save auth state after successful login
- Always check Warehouse color FIRST before deciding to reorder
- A full 4 consecutive weeks of red sales required before blacklisting
- Blacklist lasts 3 months, then item can be retried
- Always suggest Sam's Club/Costco replacements when blacklisting
- If login fails, notify user — do NOT retry more than twice
- The owner manually updates Current Stock counts periodically
- Sales Performance colors may be cell background colors or text values — check both
- For HahaVending, prefer the direct URL method with date parameters to avoid extra navigation

## Browser Reliability for Vending Sites

### General rules for ALL browser navigation
- After EVERY `agent-browser open <url>`, immediately run `agent-browser wait --load networkidle`
- After EVERY `agent-browser click`, wait for the page to settle: `agent-browser wait --load networkidle` or `agent-browser wait 2000`
- Use `agent-browser snapshot -i -c` (compact + interactive) to reduce output size on data-heavy pages
- If a snapshot shows unexpected content (like a loading spinner), wait 3 seconds and retry

### HahaVending specific
- The login page sometimes redirects to `/pages/login/register` — if this happens, look for a "Login" text link and click it
- After login, wait for redirect: `agent-browser wait --url "**/pages/index/index"` or `agent-browser wait 3000`
- The Product Ranking page loads data asynchronously — after opening the direct URL, wait 3-5 seconds: `agent-browser wait 5000` then snapshot
- If "Sales volume" column is not visible in snapshot, try: `agent-browser scroll right 200` then re-snapshot
- Always save auth state after successful login to avoid re-logging in

### Vendera specific
- Dashboard loads multiple cards asynchronously — wait for network idle after login redirect
- Product Sales Ranking has pagination — always check for "Page X of Y" text and click "Next >" until all pages are read
- If the "Past Week" tab does not appear, the page may still be loading — wait and re-snapshot

### Sam's Club specific
- Sam's Club pages are JavaScript-heavy and load slowly — always wait 5 seconds after opening: `agent-browser wait 5000`
- Search results load dynamically — after searching, wait for results: `agent-browser wait --text "results" --timeout 10000`
- If Sam's Club shows a location/zip code prompt, dismiss it or fill in 77084 (Houston TX)
- Product pages may show "member pricing" which requires login — use the visible non-member price
- If the page shows a CAPTCHA or bot detection, stop and note it in the report — do not retry endlessly

### Google Sheets via tool (not browser)
- For reading/writing Google Sheets, use the sheets tool directly — do NOT use browser automation for Sheets
- The sheets tool is faster and more reliable than browsing to sheets.google.com
- Command: `npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Tab Name!A:Z"`
- For writing: `npx tsx /workspace/project/tools/sheets/sheets.ts write --range "Tab!A1" --values [[val1,val2]]`
