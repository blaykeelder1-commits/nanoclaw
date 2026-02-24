---
name: google-drive
description: Browse and download files from Google Drive. Use to find Apollo CSV exports, documents, and shared files.
allowed-tools: Bash(npx tsx /workspace/project/tools/drive/drive.ts *)
---

# Google Drive Tool

## List files

```bash
npx tsx /workspace/project/tools/drive/drive.ts list
npx tsx /workspace/project/tools/drive/drive.ts list --folder-id "folder_id_here"
```

## Search for files

```bash
npx tsx /workspace/project/tools/drive/drive.ts search --name "apollo"
npx tsx /workspace/project/tools/drive/drive.ts search --name "apollo" --mime "text/csv"
```

## Download a file

```bash
npx tsx /workspace/project/tools/drive/drive.ts download --file-id "file_id" --output /tmp/apollo.csv
```

Google Sheets are automatically exported as CSV. Google Docs are exported as plain text.

## Get file info

```bash
npx tsx /workspace/project/tools/drive/drive.ts info --file-id "file_id"
```

## Workflow: Import Apollo List

```bash
# 1. Find the file
npx tsx /workspace/project/tools/drive/drive.ts search --name "apollo" --mime "text/csv"
# 2. Download it
npx tsx /workspace/project/tools/drive/drive.ts download --file-id <id> --output /tmp/apollo.csv
# 3. Import into CRM
npx tsx /workspace/project/tools/crm/import-apollo.ts /tmp/apollo.csv --tags "apollo,2026-02"
```

## Notes

- Reuses the same service account as Google Sheets — no extra credentials needed
- The "snak group" Drive folder must be shared with the service account email (Viewer access)
- All output is JSON
