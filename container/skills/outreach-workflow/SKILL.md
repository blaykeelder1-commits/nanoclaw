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

Automated lead generation pipeline using Google Maps scraping. See the `lead-finder` skill for full command details.

### Pipeline Steps

1. **Google Maps scraping** -- Run searches for all 13 target verticals in Houston:
   - Office buildings, coworking spaces, gyms/fitness, hotels, car dealerships
   - Hospitals/medical centers, universities/colleges, schools
   - Apartment complexes, warehouses, manufacturers, Amazon warehouses, trucking/shipping yards
   - Each search uses `--import --tags "maps,{vertical},2026-W{week}"` with `--limit 60`

2. **Website enrichment** -- Batch scrape new imports for emails and phone numbers:
   ```bash
   npx tsx /workspace/project/tools/leads/website-scraper.ts batch --source google_maps --limit 50
   ```

3. **Lead scoring** -- Score all new contacts:
   ```bash
   npx tsx /workspace/project/tools/crm/lead-score.ts batch --source google_maps --limit 200
   ```

4. **Smart service tagging** -- Apply service-fit tags based on industry:
   - `coffee-primary`: offices 50+ employees, coworking, hotels, hospitals, universities
   - `vending-primary`: gyms, apartments, dealerships, warehouses, manufacturers, trucking, schools
   - `ice-machine-fit`: hotels, hospitals, gyms, restaurants, dealerships
   - A lead can have multiple tags (e.g., hotel = coffee-primary + ice-machine-fit)

5. **WhatsApp report** -- Send summary: new leads, enriched count, score distribution, top 5 hottest

### Legacy Apollo Import

Still available for manual CSV imports:
```bash
npx tsx /workspace/project/tools/crm/import-apollo.ts /workspace/group/apollo-export.csv --tags "apollo,week-XX"
```

## Email Templates

### Initial Outreach (First Touch)
Use the appropriate HTML template based on lead's service tag:
- **coffee-primary leads**: Use `coffee-intro.html` template with hero image + attach PDF one-pager
- **vending-primary leads**: Use `vending-intro.html` template with hero image + attach PDF one-pager
- **ice-machine-fit leads**: Use `ice-machine-intro.html` template with hero image + attach PDF one-pager

Subject: [Personalized - mention their company/role]

Personalize the HTML template by:
- Inserting their company name and first name
- Referencing something specific about their business (location, size, industry)
- Including one clear CTA (schedule a free site survey)

### Follow-Up 1 (Day 3)
Use `case-study.html` template with ROI numbers relevant to their industry.

Subject: Re: [original subject]

Include:
- A case study showing measurable results (e.g., "saved $X/month" or "Y% employee satisfaction increase")
- ROI numbers specific to their vertical
- Reiterate CTA briefly

### Follow-Up 2 (Day 7)
Use `follow-up.html` template with video thumbnail + "see it in action" link.

Subject: [Different angle]

Include:
- Video thumbnail image linking to a demo/walkthrough video
- "See it in action" CTA
- Different value angle (e.g., competitor comparison, industry trend)

### Break-Up (Day 14)
Keep as simple plain text -- stays personal and human.

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
