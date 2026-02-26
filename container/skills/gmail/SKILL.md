---
name: gmail
description: Read, search, send, and reply to emails via Gmail API. Use when asked to check email, read inbox, send emails via Gmail, or reply to messages.
allowed-tools: Bash(npx tsx /workspace/project/tools/gmail/gmail.ts *)
---

# Gmail

## IMPORTANT: Email triage rules

The inbox gets heavy marketing/newsletter traffic. To avoid wasting time and credits:

1. **`list` auto-filters junk** — promotions, social, updates, forums, noreply/newsletter senders are excluded by default. Only real person-to-person emails show up.
2. **Only read emails relevant to Snak Group business** — customer inquiries, vendor communications, partnership requests, invoices, scheduling. Skip anything that looks automated or mass-sent.
3. **Do NOT read or respond to**: newsletters, marketing emails, subscription notifications, automated alerts, spam, job board blasts, social media notifications, or promotional offers.
4. **When scanning inbox for briefings**, use `list --max-results 5` to keep it tight. Only `read` a message if the subject/snippet looks like it needs a response.
5. **Pass `--no-filter true`** only if the owner explicitly asks to see everything.

## Commands

### List inbox messages (filtered)

```bash
npx tsx /workspace/project/tools/gmail/gmail.ts list [--max-results 10] [--label INBOX]
```

Returns recent **real business emails** only (marketing/newsletters auto-excluded).

To see everything including junk: `list --no-filter true`

### Search emails

```bash
npx tsx /workspace/project/tools/gmail/gmail.ts search --query "from:alice subject:invoice"
```

Uses Gmail search syntax (same as the Gmail search bar). Examples:
- `from:john@example.com` — from a specific sender
- `subject:invoice` — subject contains "invoice"
- `after:2026/02/01 before:2026/02/28` — date range
- `is:unread` — unread messages
- `has:attachment` — messages with attachments

### Read a specific email

```bash
npx tsx /workspace/project/tools/gmail/gmail.ts read --id <messageId>
```

Returns full message body, headers, and attachment list.

### Send an email

```bash
npx tsx /workspace/project/tools/gmail/gmail.ts send \
  --to "recipient@example.com" \
  --subject "Subject line" \
  --body "Email body text" \
  [--cc "cc@example.com"]
```

### Reply to an email

```bash
npx tsx /workspace/project/tools/gmail/gmail.ts reply \
  --id <messageId> \
  --body "Reply text"
```

Automatically threads the reply with the original message.

### List labels

```bash
npx tsx /workspace/project/tools/gmail/gmail.ts labels
```

## Output

All commands return JSON with a `status` field (`"success"` or `"error"`).

## Notes

- Uses domain-wide delegation — the service account impersonates GMAIL_USER_EMAIL
- Body text is truncated at 10,000 characters for very long emails
- For sending, emails come from the GMAIL_USER_EMAIL address
