---
name: google-sheets
description: Read and write Google Sheets data — update inventory, read ranges, append rows. Use when working with spreadsheets, inventory tracking, or structured data in Google Sheets.
allowed-tools: Bash(npx tsx /workspace/project/tools/sheets/sheets.ts *)
---

# Google Sheets

## Commands

### Read a range

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts read --range "Sheet1!A1:D10"
```

Returns JSON with `values` (2D array) and `rowCount`.

### Write to cells

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts write \
  --range "Sheet1!A1" \
  --values '[["Item","Qty","Price"],["Chips",10,2.50]]'
```

Values are written starting at the top-left cell of the range. Use `USER_ENTERED` format by default (numbers, dates, formulas are parsed).

### Append rows

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts append \
  --range "Sheet1!A:D" \
  --values '[["2026-02-20","Chips","Sold",5]]'
```

Appends rows after the last row with data in the specified range.

### Get spreadsheet info

```bash
npx tsx /workspace/project/tools/sheets/sheets.ts info
```

Returns sheet names, dimensions, and spreadsheet title.

## Output

All commands return JSON with a `status` field (`"success"` or `"error"`).

## Notes

- The `--values` flag takes a JSON 2D array: `[["row1col1","row1col2"],["row2col1","row2col2"]]`
- All values should be strings in the JSON (they'll be parsed by Sheets due to `USER_ENTERED` mode)
- The spreadsheet ID and credentials are configured via environment variables
