---
name: outreach-workflow
description: End-to-end outreach workflow for lead generation and email campaigns. Use for morning outreach, follow-ups, weekly reports, and campaign management.
allowed-tools: Bash(npx tsx /workspace/project/tools/crm/query-contacts.ts *), Bash(npx tsx /workspace/project/tools/email/send-email.ts *), Bash(npx tsx /workspace/project/tools/crm/import-apollo.ts *)
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

## Warm-Up Schedule

Week 1: 5 emails/day
Week 2: 10 emails/day
Week 3: 15 emails/day
Week 4+: 20 emails/day

Never exceed 20 cold emails per day from a single domain.
