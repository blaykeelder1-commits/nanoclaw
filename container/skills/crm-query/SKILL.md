---
name: crm-query
description: Query the CRM database for contacts, leads, outreach history, and statistics. Use when asked about leads, contacts, outreach stats, or CRM data.
allowed-tools: Bash(npx tsx /workspace/project/tools/crm/query-contacts.ts *), Bash(npx tsx /workspace/project/tools/crm/import-apollo.ts *), Bash(npx tsx /workspace/project/tools/crm/pipeline.ts *), Bash(npx tsx /workspace/project/tools/crm/unsubscribe.ts *), Bash(npx tsx /workspace/project/tools/crm/lead-score.ts *)
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

## Import Apollo Data

### From CSV file
```bash
npx tsx /workspace/project/tools/crm/import-apollo.ts /path/to/export.csv --tags "apollo,batch1"
```

### Directly from Google Sheets
```bash
npx tsx /workspace/project/tools/crm/import-apollo.ts --sheet "14xhjN63ey_kok8EUyawy63nP8Cvt5IlP" --tags "apollo,2026-02"
npx tsx /workspace/project/tools/crm/import-apollo.ts --sheet "spreadsheet_id" --range "Sheet2" --tags "apollo,batch2"
```

Add `--dry-run` to preview without importing.

## Deal Pipeline

### Create a deal

```bash
npx tsx /workspace/project/tools/crm/pipeline.ts create --contact-id "id" --group "snak-group" --source whatsapp
```

### Move deal to next stage

```bash
npx tsx /workspace/project/tools/crm/pipeline.ts move --deal-id "deal-abc123" --stage qualified --note "Has 200+ employees"
```

Stages: `new` → `qualified` → `appointment_booked` → `proposal` → `closed_won` | `closed_lost`

### List deals

```bash
npx tsx /workspace/project/tools/crm/pipeline.ts list --group "snak-group" --stage qualified
```

### Pipeline health

```bash
npx tsx /workspace/project/tools/crm/pipeline.ts health --group "snak-group"
```

### Get deal for a contact

```bash
npx tsx /workspace/project/tools/crm/pipeline.ts get --contact-id "id"
```

### Deal stage history

```bash
npx tsx /workspace/project/tools/crm/pipeline.ts history --deal-id "deal-abc123"
```

## Deal Pipeline

### Create a deal for a contact
```bash
npx tsx /workspace/project/tools/crm/pipeline.ts create --contact-id <id> --group snak-group --source whatsapp
```

### Move a deal to a new stage
Stages: `new → qualified → appointment_booked → proposal → closed_won | closed_lost`
```bash
npx tsx /workspace/project/tools/crm/pipeline.ts move --deal-id <id> --stage qualified --note "Confirmed 80+ employees"
```

### List deals for a group
```bash
npx tsx /workspace/project/tools/crm/pipeline.ts list --group snak-group
npx tsx /workspace/project/tools/crm/pipeline.ts list --group snak-group --stage qualified
```

### Pipeline health summary
```bash
npx tsx /workspace/project/tools/crm/pipeline.ts health --group snak-group
```

### Get deal + stage history for a contact
```bash
npx tsx /workspace/project/tools/crm/pipeline.ts get --contact-id <id>
```

## Unsubscribe / Bounce Handler

### Mark contact as bounced
```bash
npx tsx /workspace/project/tools/crm/unsubscribe.ts --contact-id <id> --reason bounced
```

### Mark contact as opted-out
```bash
npx tsx /workspace/project/tools/crm/unsubscribe.ts --contact-id <id> --reason opted-out
```

Contacts marked `do-not-contact` are excluded from follow-up and uncontacted queries.

## Lead Scoring

### Score a single contact
```bash
npx tsx /workspace/project/tools/crm/lead-score.ts score --contact-id <id>
```

### Batch score contacts
```bash
npx tsx /workspace/project/tools/crm/lead-score.ts batch --source apollo --limit 100
```

### Show top uncontacted leads (highest score first)
```bash
npx tsx /workspace/project/tools/crm/lead-score.ts top --limit 20
```

Scores: 80+ = hot, 50-79 = warm, 20-49 = cool, <20 = cold

## Notes

- All queries return JSON output
- The `uncontacted` command finds leads with no outreach history — ideal for morning batch sends
- The `follow-up` command finds leads who were emailed but haven't replied within N days
- Always check `stats` before batch sending to avoid exceeding daily limits
- Create a deal on first contact, then move it through stages as the conversation progresses
