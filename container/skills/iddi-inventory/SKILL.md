---
name: iddi-inventory
description: Query the IDDI platform for vending machine performance data — inventory levels, expiring products, redistribution suggestions, customer swipe results, and analytics. Use for IDDI-specific questions about product performance and optimization.
allowed-tools: Bash(npx tsx /workspace/project/tools/iddi/iddi.ts *)
---

# IDDI Platform Tool

IDDI tracks product performance, expiration, and customer preferences across vending machines. It is one of three data sources for inventory management.

## Three Inventory Data Sources

1. **IDDI** (this tool): Performance flags, product expiration tracking, redistribution recommendations, customer swipe poll results. Use for "which products are expiring?", "what should we redistribute?", "what are customers voting for?"
2. **Vendera / HahaVending** (vending-inventory skill): Actual weekly sales data pulled from machine telemetry platforms. Use for "how many units of X sold this week?"
3. **Google Sheets** (google-sheets skill): Warehouse stock counts, manually updated by the owner weekly. Use for "how many units of X do we have in the warehouse?"

## Commands

### Check warehouse inventory levels
```bash
npx tsx /workspace/project/tools/iddi/iddi.ts inventory
```

### Find products near expiration
```bash
npx tsx /workspace/project/tools/iddi/iddi.ts expiring --days 7
```

### Get redistribution recommendations
Move underperforming products from one machine to another where they sell better.
```bash
npx tsx /workspace/project/tools/iddi/iddi.ts redistribution
```

### Generate shopping list
What products need to be purchased based on performance and stock.
```bash
npx tsx /workspace/project/tools/iddi/iddi.ts shopping-list
```

### See top-performing products
```bash
npx tsx /workspace/project/tools/iddi/iddi.ts top-products --limit 20
```

### View customer swipe poll results for a machine
Customers use the app to vote on products they want. Check what they're asking for.
```bash
npx tsx /workspace/project/tools/iddi/iddi.ts swipe-results --machine-id <id>
```

### Business analytics overview
```bash
npx tsx /workspace/project/tools/iddi/iddi.ts analytics
```

## Notes

- All output is JSON
- Auth is handled automatically (JWT cached for 23 hours)
- If auth fails, the tool will report the error — check IDDI credentials
- IDDI data complements but does not replace Vendera/HahaVending sales data or Google Sheets warehouse counts
