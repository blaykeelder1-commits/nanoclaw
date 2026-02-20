---
name: vending-inventory
description: Track vending machine inventory by pulling sales data from HahaVending and Vendera, updating the Google Sheets inventory spreadsheet, and generating shopping lists. Use for any vending-related questions about sales, inventory, or restocking.
allowed-tools: Bash(agent-browser:*), Bash(npx tsx /workspace/project/tools/sheets/sheets.ts *)
---

# Vending Machine Inventory Automation

## Overview

This skill automates daily vending machine inventory management:
1. Log into HahaVending and Vendera to get sales data
2. Update the Google Sheets inventory spreadsheet
3. Generate a shopping list based on par levels
4. Send the shopping list via WhatsApp

## Credentials

Login credentials for vending platforms are stored in the group's CLAUDE.md memory file. Check `/workspace/group/CLAUDE.md` for:
- HahaVending URL and credentials
- Vendera URL and credentials
- Spreadsheet layout details (which columns, sheet names, par levels)

## Step-by-step: Pull Sales Data

### 1. Log into HahaVending

```bash
# Load saved auth state if available
agent-browser state load hahavending-auth.json 2>/dev/null

agent-browser open <HAHAVENDING_URL>
agent-browser snapshot -i
# If login page: fill credentials and submit
# Navigate to sales/transactions report for today
# Extract items sold and quantities
```

### 2. Log into Vendera

```bash
# Load saved auth state if available
agent-browser state load vendera-auth.json 2>/dev/null

agent-browser open <VENDERA_URL>
agent-browser snapshot -i
# If login page: fill credentials and submit
# Navigate to sales report for today
# Extract items sold and quantities
```

### 3. Save auth state after successful login

```bash
agent-browser state save hahavending-auth.json
agent-browser state save vendera-auth.json
```

## Step-by-step: Update Inventory

### 1. Read current inventory from Google Sheets

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Inventory!A:F"
```

### 2. Calculate new quantities

For each item sold today:
- Find the item's row in the spreadsheet
- Subtract the sold quantity from current stock
- Note the par level for the item

### 3. Write updated inventory back

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts write \
  --range "Inventory!C2" \
  --values '[["45"],["30"],["22"]]'
```

### 4. Log today's sales

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts append \
  --range "Sales Log!A:E" \
  --values '[["2026-02-20","Chips","HahaVending","Machine 1",5]]'
```

## Step-by-step: Generate Shopping List

Compare current stock to par levels:
- If current stock <= par level, add to shopping list
- Calculate reorder quantity: par level × 2 - current stock (restock to double par)

Format the shopping list clearly:

```
🛒 Shopping List — Feb 20, 2026

NEED TO BUY:
• Lay's Classic — buy 24 (current: 6, par: 15)
• Snickers — buy 20 (current: 10, par: 15)
• Coca-Cola 20oz — buy 36 (current: 12, par: 24)

WELL STOCKED:
• Doritos — 28 remaining (par: 15) ✓
• Water 16oz — 40 remaining (par: 20) ✓
```

Then send via the `send_message` MCP tool.

## Important Notes

- Always save browser auth state after successful login to avoid re-authenticating each time
- If a login fails, send a message to the user explaining the issue
- The exact spreadsheet layout (column names, sheet names, par level column) should be read from the group's CLAUDE.md
- When in doubt about spreadsheet structure, use the `info` command first, then read the header row
- Sales data extraction depends on the specific UI of each platform — use snapshots to navigate
