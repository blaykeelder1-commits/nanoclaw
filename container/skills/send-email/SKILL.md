---
name: send-email
description: Send emails to contacts for outreach, follow-ups, or notifications. Use when asked to email someone, do outreach, or follow up with leads. Supports HTML templates with variable substitution, file attachments, and inline images.
allowed-tools: Bash(npx tsx /workspace/project/tools/email/send-email.ts *)
---

# Email Sending

## Send a plain text email

```bash
npx tsx /workspace/project/tools/email/send-email.ts \
  --to "recipient@example.com" \
  --subject "Subject line" \
  --body "Email body text"
```

## Send an HTML email using a template

```bash
npx tsx /workspace/project/tools/email/send-email.ts \
  --to "john@acme.com" \
  --subject "Elevate Your Workplace Coffee" \
  --template "/workspace/project/tools/email/templates/coffee-intro.html" \
  --vars '{"first_name":"John","company":"Acme Corp","pain_point":"Your team deserves better than instant coffee.","booking_link":"https://snakgroup.com/book","unsubscribe_link":"https://snakgroup.com/unsub?id=123"}' \
  --inline-images "/workspace/project/groups/main/assets/hero-image.jpg"
```

## Send a case study email with before/after images

```bash
npx tsx /workspace/project/tools/email/send-email.ts \
  --to "jane@example.com" \
  --subject "How We Helped TechCorp Boost Breakroom Usage by 37%" \
  --template "/workspace/project/tools/email/templates/case-study.html" \
  --vars '{"first_name":"Jane","company":"BigCo","case_study_title":"TechCorp Breakroom Transformation","company_name":"TechCorp","industry":"Technology","roi_stat":"37% increase in breakroom usage","testimonial":"Best decision we made this year.","testimonial_author":"Sarah Chen","testimonial_title":"Office Manager","booking_link":"https://snakgroup.com/book","unsubscribe_link":"https://snakgroup.com/unsub?id=456"}' \
  --inline-images "/workspace/project/groups/main/assets/casestudy-techcorp-before.jpg,/workspace/project/groups/main/assets/casestudy-techcorp-after.jpg"
```

## Send with file attachments

```bash
npx tsx /workspace/project/tools/email/send-email.ts \
  --to "recipient@example.com" \
  --subject "Our Coffee Brochure" \
  --body "Please find our brochure attached." \
  --attachments "/workspace/project/groups/main/assets/coffee-brochure.pdf,/workspace/project/groups/main/assets/price-list.pdf"
```

## Send a follow-up email

```bash
npx tsx /workspace/project/tools/email/send-email.ts \
  --to "john@acme.com" \
  --subject "Quick follow-up" \
  --template "/workspace/project/tools/email/templates/follow-up.html" \
  --vars '{"first_name":"John","follow_up_body":"Just wanted to circle back on the coffee tasting we discussed. We have availability next Tuesday or Thursday afternoon.","cta_text":"Pick a time that works","cta_link":"https://snakgroup.com/book","unsubscribe_link":"https://snakgroup.com/unsub?id=123"}'
```

## Options

- `--to` (required): Recipient email address
- `--subject` (required): Email subject line
- `--body` (required unless `--template` is used): Email body content
- `--html`: Flag to send body as HTML instead of plain text
- `--cc`: CC recipients
- `--bcc`: BCC recipients
- `--replyTo`: Reply-to address
- `--template`: Path to an HTML template file. Replaces `--body` and automatically sends as HTML.
- `--vars`: JSON string of template variables. Replaces `{{key}}` patterns in the template HTML.
- `--attachments`: Comma-separated file paths to attach (PDFs, images, etc.)
- `--inline-images`: Comma-separated file paths for inline CID-attached images. Each image's filename becomes its CID (e.g., file `hero-image.jpg` is referenced as `cid:hero-image.jpg` in templates).

## Available Templates

| Template | Use Case |
|----------|----------|
| `coffee-intro.html` | Cold outreach for coffee machine placements |
| `vending-intro.html` | Cold outreach for smart vending solutions |
| `ice-machine-intro.html` | Cold outreach for countertop ice machines |
| `case-study.html` | Sharing client success stories with before/after images |
| `follow-up.html` | Lightweight follow-up that feels personal, not marketing |

Templates are in `/workspace/project/tools/email/templates/`.

## Template Variables

Common variables across templates:
- `{{first_name}}` - Recipient's first name
- `{{company}}` - Recipient's company name
- `{{pain_point}}` - Personalized pain point sentence
- `{{booking_link}}` - CTA destination URL (default: https://snakgroup.com/book)
- `{{unsubscribe_link}}` - Unsubscribe URL

## Output

Returns JSON with `status`, `messageId`, and delivery info.

## Best Practices

- Always personalize the subject line with the recipient's name or company
- Keep cold outreach emails under 150 words
- Include a clear call to action
- Always log the outreach in the CRM after sending (use the CRM query tool)
- Respect daily sending limits: check stats first with `npx tsx /workspace/project/tools/crm/query-contacts.ts stats`
- Never send more than 20 emails per day during warm-up period
- Use templates with `--vars` for consistent branding across campaigns
- Always include `--inline-images` when using templates that reference `cid:` images
- Personalize the `{{pain_point}}` variable based on CRM data or research about the prospect
