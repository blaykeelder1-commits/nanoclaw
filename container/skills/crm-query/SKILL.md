---
name: crm-query
description: Query the CRM database for contacts, leads, outreach history, and statistics. Use when asked about leads, contacts, outreach stats, or CRM data.
allowed-tools: Bash(npx tsx /workspace/project/tools/crm/query-contacts.ts *), Bash(npx tsx /workspace/project/tools/crm/import-apollo.ts *)
---

# CRM Query Tool

## Search contacts

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts search "company name or person name"
```

## Get un-contacted leads

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts uncontacted --limit 10
```

## Find leads needing follow-up

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts follow-up --days 3 --limit 10
```

## View outreach statistics

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts stats
```

## Get contact details

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts get "contact_id"
```

## View contact outreach history

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts history "contact_id"
```

## Import Apollo CSV

```bash
npx tsx /workspace/project/tools/crm/import-apollo.ts /path/to/export.csv --tags "apollo,batch1"
```

Add `--dry-run` to preview without importing.

## Notes

- All queries return JSON output
- The `uncontacted` command finds leads with no outreach history — ideal for morning batch sends
- The `follow-up` command finds leads who were emailed but haven't replied within N days
- Always check `stats` before batch sending to avoid exceeding daily limits
