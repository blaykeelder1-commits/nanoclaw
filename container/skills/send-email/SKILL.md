---
name: send-email
description: Send emails to contacts for outreach, follow-ups, or notifications. Use when asked to email someone, do outreach, or follow up with leads.
allowed-tools: Bash(npx tsx /workspace/project/tools/email/send-email.ts *)
---

# Email Sending

## Send an email

```bash
npx tsx /workspace/project/tools/email/send-email.ts \
  --to "recipient@example.com" \
  --subject "Subject line" \
  --body "Email body text"
```

## Options

- `--to` (required): Recipient email address
- `--subject` (required): Email subject line
- `--body` (required): Email body content
- `--html`: Flag to send body as HTML instead of plain text
- `--cc`: CC recipients
- `--bcc`: BCC recipients
- `--replyTo`: Reply-to address

## Output

Returns JSON with `status`, `messageId`, and delivery info.

## Best Practices

- Always personalize the subject line with the recipient's name or company
- Keep cold outreach emails under 150 words
- Include a clear call to action
- Always log the outreach in the CRM after sending (use the CRM query tool)
- Respect daily sending limits: check stats first with `npx tsx /workspace/project/tools/crm/query-contacts.ts stats`
- Never send more than 20 emails per day during warm-up period
