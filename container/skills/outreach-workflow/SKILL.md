---
name: outreach-workflow
description: End-to-end outreach workflow for lead generation and email campaigns. Use for morning outreach, follow-ups, weekly reports, and campaign management.
allowed-tools: Bash(npx tsx /workspace/project/tools/crm/query-contacts.ts *), Bash(npx tsx /workspace/project/tools/email/send-email.ts *), Bash(npx tsx /workspace/project/tools/crm/import-apollo.ts *), Bash(npx tsx /workspace/project/tools/crm/unsubscribe.ts *), Bash(npx tsx /workspace/project/tools/crm/pipeline.ts *), Bash(npx tsx /workspace/project/tools/crm/unsubscribe.ts *), Bash(npx tsx /workspace/project/tools/crm/pipeline.ts *)
---

# Outreach Workflow

## Morning Outreach (Daily, 9 AM Weekdays)

1. **Check daily stats first:**
   ```bash
   npx tsx /workspace/project/tools/crm/query-contacts.ts stats
   ```
   Verify sent_today is under the daily limit before proceeding.

2. **Get un-contacted leads:**
   ```bash
   npx tsx /workspace/project/tools/crm/query-contacts.ts uncontacted --limit 10
   ```

3. **For each lead**, craft a personalized email:
   - Research the contact's company and role
   - Write a personalized subject line mentioning their company or a specific pain point
   - Keep the email under 150 words
   - Include one clear call to action
   - Send using the email tool

4. **After sending**, report results via WhatsApp message.

## Follow-Up Check (Daily, 11 AM Weekdays)

1. **Find leads needing follow-up:**
   ```bash
   npx tsx /workspace/project/tools/crm/query-contacts.ts follow-up --days 3 --limit 10
   ```

2. **For each lead**, check outreach history:
   ```bash
   npx tsx /workspace/project/tools/crm/query-contacts.ts history "contact_id"
   ```

3. **Send follow-up** based on touch count:
   - 1st follow-up (day 3): Add new value, reference previous email
   - 2nd follow-up (day 7): Different angle, share relevant resource
   - 3rd follow-up (day 14): Break-up email, leave door open
   - After 3 follow-ups: Stop outreach for this contact

## Weekly Report (Friday, 6 PM)

Generate a summary including:
```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts stats
```

Report should include:
- Emails sent this week
- Reply rate
- Bounces
- New leads added
- Top responding companies
- Recommendations for next week

## Lead List Refresh (Monday, 7 AM)

Check for new CSV files and import:
```bash
npx tsx /workspace/project/tools/crm/import-apollo.ts /workspace/group/apollo-export.csv --tags "week-XX"
```

## Email Templates

### Initial Outreach
Subject: [Personalized - mention their company/role]

Hi {first_name},

[1 sentence about why you're reaching out, referencing something specific about their company]

[1-2 sentences about the value you can provide]

[Clear CTA - suggest a specific time or ask a specific question]

Best,
[Your name]

### Follow-Up 1 (Day 3)
Subject: Re: [original subject]

Hi {first_name},

Quick follow-up on my previous note. [Add new piece of value - article, case study, insight]

[Reiterate CTA briefly]

Best,
[Your name]

### Follow-Up 2 (Day 7)
Subject: [Different angle]

Hi {first_name},

[Different approach - perhaps reference industry trend or competitor]

[New value proposition or different CTA]

Best,
[Your name]

### Break-Up (Day 14)
Subject: Should I close your file?

Hi {first_name},

I've reached out a few times and haven't heard back — no worries at all. I'll assume the timing isn't right.

If things change down the road, feel free to reach out.

Best,
[Your name]

## Reputation Guards

### Pre-Send Check

Before each batch send, check outreach stats:
```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts stats
```

If bounce rate exceeds 5% (total_bounced / total_sent > 0.05), **STOP all outreach** and alert the owner via email. Do not send more emails until the owner reviews.

### Unsubscribe Detection

When someone replies with "unsubscribe", "stop", "remove me", "opt out", or similar:

```bash
npx tsx /workspace/project/tools/crm/unsubscribe.ts --contact-id "id" --reason opted-out
```

When an email bounces:

```bash
npx tsx /workspace/project/tools/crm/unsubscribe.ts --contact-id "id" --reason bounced
```

Tagged contacts are automatically excluded from future `uncontacted` and `follow-up` queries.

### Reply Tracking

When someone replies to outreach (positive or negative):
1. Update the pipeline stage: `pipeline.ts move --deal-id <id> --stage qualified --note "Replied to outreach"`
2. Log the reply in outreach history
3. Stop automated follow-ups — switch to conversational mode

## Warm-Up Schedule

Week 1: 5 emails/day
Week 2: 10 emails/day
Week 3: 15 emails/day
Week 4+: 20 emails/day

Never exceed 20 cold emails per day from a single domain.

## Reputation Protection

### Pre-Send Bounce Check
Before any batch send, check outreach stats. If bounce rate exceeds 5%:
1. STOP all outreach immediately
2. Alert the owner: "Email bounce rate is above 5% — pausing outreach to protect sender reputation"
3. Do NOT send any more emails until the owner responds

### Unsubscribe Detection
When someone replies with any of these phrases: "unsubscribe", "stop", "remove me", "opt out", "don't contact me", "take me off":
1. Immediately mark them as opted-out:
   ```bash
   npx tsx /workspace/project/tools/crm/unsubscribe.ts --contact-id <id> --reason opted-out
   ```
2. Reply politely: "No problem, I've removed you from our list. Sorry for the bother!"

### Bounce Handling
When an email bounces (delivery failure notification):
1. Mark the contact as bounced:
   ```bash
   npx tsx /workspace/project/tools/crm/unsubscribe.ts --contact-id <id> --reason bounced
   ```

### Reply Tracking
When someone replies to outreach (positive or neutral):
1. Update their deal pipeline stage:
   ```bash
   npx tsx /workspace/project/tools/crm/pipeline.ts move --deal-id <id> --stage qualified --note "Replied to outreach"
   ```
2. Log the reply in your conversation notes
