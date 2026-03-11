---
name: instantly
description: Manage Instantly.ai email campaigns — push CRM leads to campaigns, sync replies, check analytics, manage sending accounts and warmup. Use for all cold email outreach.
allowed-tools: Bash(npx tsx /workspace/project/tools/instantly/instantly.ts *), Bash(npx tsx /workspace/project/tools/crm/query-contacts.ts *)
---

# Instantly.ai Cold Email Integration

## Overview

Instantly.ai handles cold email outreach with proper deliverability (warmup, domain rotation, drip sequences). Andy pushes leads from the CRM to Instantly campaigns and pulls reply data back.

**Important:** Instantly handles SENDING. Andy handles RELATIONSHIPS. Once a lead replies, Andy takes over the conversation directly.

## Tool

```bash
npx tsx /workspace/project/tools/instantly/instantly.ts <command> [options]
```

## Commands

### Campaign Management

```bash
# List all campaigns
npx tsx /workspace/project/tools/instantly/instantly.ts campaigns

# Get analytics for all campaigns (or one specific campaign)
npx tsx /workspace/project/tools/instantly/instantly.ts campaign-analytics
npx tsx /workspace/project/tools/instantly/instantly.ts campaign-analytics --id "campaign-uuid"

# Create a new campaign
npx tsx /workspace/project/tools/instantly/instantly.ts create-campaign --name "Vending — Office Buildings Q1"

# Activate or stop a campaign
npx tsx /workspace/project/tools/instantly/instantly.ts activate-campaign --id "campaign-uuid"
npx tsx /workspace/project/tools/instantly/instantly.ts stop-campaign --id "campaign-uuid"
```

### Lead Management

```bash
# Push CRM leads to an Instantly campaign
# Filters leads from the NanoClaw CRM and adds them to the campaign
npx tsx /workspace/project/tools/instantly/instantly.ts add-leads --campaign-id "uuid" --limit 50

# Filter by source (google_maps, apollo, manual, etc.)
npx tsx /workspace/project/tools/instantly/instantly.ts add-leads --campaign-id "uuid" --source google_maps --limit 100

# Filter by tag
npx tsx /workspace/project/tools/instantly/instantly.ts add-leads --campaign-id "uuid" --tag "vending"

# Filter by minimum lead score
npx tsx /workspace/project/tools/instantly/instantly.ts add-leads --campaign-id "uuid" --min-score 50 --limit 200

# Push to a list instead of campaign
npx tsx /workspace/project/tools/instantly/instantly.ts add-leads --list-id "uuid" --limit 100

# List leads in a campaign (with optional status filter)
npx tsx /workspace/project/tools/instantly/instantly.ts list-leads --campaign-id "uuid"
npx tsx /workspace/project/tools/instantly/instantly.ts list-leads --campaign-id "uuid" --status replied
```

### Reply Sync

```bash
# Pull replies from Instantly and update CRM deal stages
# - Finds leads with status "replied" in Instantly campaigns
# - Matches against CRM contacts by email
# - Moves deals to "qualified" stage (they responded!)
# - Logs outreach in CRM
npx tsx /workspace/project/tools/instantly/instantly.ts sync-replies
```

### Account & Warmup

```bash
# List sending accounts
npx tsx /workspace/project/tools/instantly/instantly.ts accounts

# Test account health (deliverability, authentication)
npx tsx /workspace/project/tools/instantly/instantly.ts account-vitals --id "account-uuid"

# Enable/disable warmup
npx tsx /workspace/project/tools/instantly/instantly.ts warmup --enable --ids "id1,id2"
npx tsx /workspace/project/tools/instantly/instantly.ts warmup --disable --ids "id1,id2"
```

## Workflow: Pushing CRM Leads to Instantly

When the lead scrape scheduled task finds new leads, or when asked to push leads:

1. **Check CRM** — Use `query-contacts.ts stats` to see how many leads are available
2. **Review campaign** — `instantly.ts campaigns` to see active campaigns
3. **Push leads** — `instantly.ts add-leads --campaign-id "..." --min-score 40 --limit 100`
4. **Verify** — `instantly.ts list-leads --campaign-id "..."` to confirm they were added
5. **Activate** — `instantly.ts activate-campaign --id "..."` if campaign was paused

## Workflow: Daily Reply Sync

Run daily to keep CRM in sync with Instantly:

1. `instantly.ts sync-replies` — pulls replied leads, updates CRM
2. `instantly.ts campaign-analytics` — check open/reply rates
3. If reply rate is low (<2%), flag in daily briefing

## Campaign Naming Convention

Use this format: `{Business} — {Segment} {Quarter}`
Examples:
- "Snak Group — Office Buildings Q1 2026"
- "Snak Group — Hotels & Hospitality Q1 2026"
- "Sheridan Rentals — RV Parks Partnership Q1 2026"

## What NOT to Do

- Do NOT send cold emails via SMTP (`send-email.ts`) — use Instantly for all cold outreach
- Do NOT push leads without real email addresses (SMS placeholder emails are auto-filtered)
- Do NOT activate campaigns without warmed-up sending accounts
- Do NOT push the same leads to multiple campaigns without checking `skip_if_in_workspace`

## When to Use SMTP vs Instantly

| Scenario | Tool |
|----------|------|
| Cold outreach to new leads | Instantly |
| Automated drip sequences | Instantly |
| Reply to a warm lead (they responded) | SMTP (send-email.ts) or Gmail |
| Booking confirmations | SMTP (booking service) |
| Owner notifications | SMTP (send-email.ts) |
| Daily briefing emails | SMTP (send-email.ts) |
| Partnership proposal to a specific business | Instantly (track opens/replies) |
