---
name: gbp
description: Manage Google Business Profile — create posts, respond to reviews, monitor insights, update business info, and answer Q&A. Use for local SEO, review management, and GBP posting.
allowed-tools: Bash(npx tsx /workspace/project/tools/gbp/gbp.ts *)
---

# Google Business Profile Management

## Post to GBP

```bash
npx tsx /workspace/project/tools/gbp/gbp.ts post \
  --summary "Post text here" \
  [--url "https://snakgroup.biz"] \
  [--photo-url "https://public-image-url.jpg"] \
  [--topic-type "STANDARD"] \
  [--dry-run]
```

Options:
- `--summary` (required): Post text (max 1,500 chars)
- `--url` (optional): CTA button link
- `--photo-url` (optional): Public image URL for the post
- `--topic-type` (optional): STANDARD (default), EVENT, or OFFER
- `--dry-run` (optional): Preview without posting

## Fetch Reviews

```bash
npx tsx /workspace/project/tools/gbp/gbp.ts reviews \
  [--limit 10] \
  [--unreplied-only]
```

Returns: reviewer name, star rating, comment, date, reply status.

## Reply to a Review

```bash
npx tsx /workspace/project/tools/gbp/gbp.ts reply-review \
  --review-id "review_id_here" \
  --comment "Thank you for the kind words!"
```

## Fetch Insights

```bash
npx tsx /workspace/project/tools/gbp/gbp.ts insights \
  [--days 30]
```

Returns: search views, map views, website clicks, phone calls, direction requests over the period.

## Update Business Info

```bash
npx tsx /workspace/project/tools/gbp/gbp.ts update-info \
  [--description "Updated business description"] \
  [--hours '{"monday":"8:00-17:00","tuesday":"8:00-17:00"}'] \
  [--category "Vending machine supplier"]
```

Only updates fields that are provided.

## Q&A Management

```bash
# List recent questions
npx tsx /workspace/project/tools/gbp/gbp.ts questions [--limit 10]

# Answer the latest unanswered question
npx tsx /workspace/project/tools/gbp/gbp.ts questions --answer "Yes, all our machines are free to place."
```

---

## GBP Posting Schedule

Post 2-3 times per week per business. Stagger across the week:

### Snak Group
- **Tuesday**: What's New post — highlight a service, product, or recent install
- **Thursday**: Offer or Event post — seasonal promotion, coffee tasting, IDDI feature
- **Saturday** (optional): Behind-the-scenes, team photo, or customer spotlight

### Sheridan Rentals
- **Monday**: Fleet spotlight — feature a specific rental unit with photo
- **Wednesday**: Seasonal/promo post — camping season, holiday hauling, landscaping deals
- **Friday** (optional): Customer use case or local Tomball content

### Post Guidelines
- Keep under 300 words — GBP truncates long posts
- Always include a photo when possible (2-3x more engagement)
- Include a CTA button link (website, booking page, or call)
- Use keywords naturally: "vending machine Houston", "trailer rental Tomball TX"
- GBP posts expire after 7 days — posting 2-3x/week keeps the profile active

---

## Review Response Workflow

### Positive Reviews (4-5 stars)
Auto-reply to 5-star reviews. Draft replies for 4-star reviews for owner approval.

Templates:
- "Thank you so much, [name]! We're glad you're enjoying [specific thing they mentioned]. We appreciate your support!"
- "Thanks for the kind words! Our team works hard to keep everything fresh and stocked. Let us know if you ever need anything!"
- "[Name], we really appreciate you taking the time to leave a review. It means a lot to the team!"

### Negative Reviews (1-3 stars)
ALWAYS send to owner for approval before replying. Draft a response following this pattern:

1. Thank them for the feedback
2. Apologize for the experience
3. Take responsibility (don't make excuses)
4. Offer to make it right — provide a contact method to take it offline
5. Keep it brief (3-4 sentences)

Template:
- "Thank you for your feedback, [name]. We're sorry to hear about your experience — that's not the standard we hold ourselves to. We'd love the opportunity to make it right. Please reach out to us at [email/phone] so we can address this directly."

### Review Response Rules
- Respond within 24-48 hours (faster = better for SEO)
- NEVER argue with a reviewer
- NEVER reveal private customer details in a public reply
- NEVER offer compensation in a public reply — take it offline
- Reference specific details from their review to show you read it
- Keep replies under 4 sentences

---

## Insights Monitoring

Check GBP insights monthly (aligned with SEO audit). Key metrics:
- **Search views** — How many people found you via Google Search
- **Map views** — How many found you via Google Maps
- **Website clicks** — Clicks to your website from GBP
- **Phone calls** — Calls initiated from GBP
- **Direction requests** — People who asked for directions

Track month-over-month trends. If any metric drops >20%, investigate:
- Are posts being made regularly?
- Have reviews slowed down?
- Is business info accurate and complete?
- Are photos up to date?
