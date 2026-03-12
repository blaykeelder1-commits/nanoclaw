---
name: inventory-reconcile
description: Cross-reference IDDI, Google Sheets, and sales data to reconcile inventory, manage blacklists, and make reorder decisions. Use for any question that needs data from multiple inventory sources combined.
allowed-tools: Bash(npx tsx /workspace/project/tools/inventory/reconcile.ts *), Bash(npx tsx /workspace/project/tools/iddi/iddi.ts *), Bash(npx tsx /workspace/project/tools/sheets/sheets.ts *)
---

# Inventory Reconciliation

Unifies three independent data sources into a single inventory picture:
- **IDDI** — Product performance, expiration, redistribution suggestions
- **Vendera/HahaVending** (via Google Sheets Sales Performance) — Weekly sales data
- **Google Sheets Warehouse Inventory** — Stock on hand

## Commands

### Full Reconciliation (weekly, after sales pull)
```bash
npx tsx /workspace/project/tools/inventory/reconcile.ts full --yo-offset 2
```
Cross-examines all sources. Produces unified product table, reorder list, blacklist warnings, discrepancies. Run this after the weekly vending-inventory sales pull updates Sheets.

### Quick Snapshot (ad-hoc, daily briefings)
```bash
npx tsx /workspace/project/tools/inventory/reconcile.ts snapshot --yo-offset 2
```
Same data pull but for quick queries like "what's our inventory look like?" or "what needs reordering?"

### Blacklist Analysis (focused)
```bash
npx tsx /workspace/project/tools/inventory/reconcile.ts blacklist --yo-offset 2
```
Returns only blacklist-related data: warnings (1-3 weeks red), newly blacklisted (4 weeks red), coming off blacklist (3 months elapsed).

## Output Structure

All commands return JSON with `status: 'success'` and:

| Field | Description |
|-------|-------------|
| `unified_products` | Every product with data from all sources merged |
| `reorder_list` | Products that should be reordered (RED warehouse + GREEN/YELLOW sales) |
| `blacklist_warnings` | Products approaching blacklist (1-3 consecutive red sales weeks) |
| `blacklist_now` | Products that just hit 4 weeks of red sales |
| `coming_off_blacklist` | Products whose 3-month blacklist period has elapsed |
| `discrepancies` | Products found in one source but not another |
| `summary_stats` | Counts, totals, YO machine offset |

## YO Machine Offset

2 YO machines can't be accessed for data. Use `--yo-offset 2` (default) to account for this when interpreting sales vs. expected. The offset is noted in output so the user knows those machines are untracked.

## Decision Framework

**Reorder Matrix:**
| Warehouse | Sales | Action |
|-----------|-------|--------|
| RED | GREEN/YELLOW | REORDER |
| RED | RED | DO NOT REORDER |
| YELLOW/GREEN | Any | DO NOT REORDER |

**Blacklist Timeline:**
- Week 1-3 red sales → Warning
- Week 4 red sales → Blacklisted for 3 months
- After 3 months → Eligible to retry

## State Files

- `groups/snak-group/blacklist-state.json` — Tracks consecutive red weeks and blacklist dates per product
- `groups/snak-group/product-aliases.json` — Manual product name mappings for cross-source matching (optional)

## Notes

- All output is JSON
- Auth for both IDDI and Google Sheets is handled automatically
- Product names are fuzzy-matched across sources (lowercased, suffixes stripped, token overlap)
- Always base reorder/blacklist decisions on reconciled output, not a single source
