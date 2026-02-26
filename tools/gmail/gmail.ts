#!/usr/bin/env npx tsx
/**
 * Gmail API Tool for NanoClaw
 *
 * Uses a Google service account with domain-wide delegation to access Gmail.
 * The service account impersonates the user specified by GMAIL_USER_EMAIL.
 *
 * Usage:
 *   npx tsx tools/gmail/gmail.ts list [--max-results 10] [--label INBOX]
 *   npx tsx tools/gmail/gmail.ts search --query "from:alice subject:invoice"
 *   npx tsx tools/gmail/gmail.ts read --id <messageId>
 *   npx tsx tools/gmail/gmail.ts send --to "a@b.com" --subject "Hi" --body "Hello"
 *   npx tsx tools/gmail/gmail.ts reply --id <messageId> --body "Thanks"
 *   npx tsx tools/gmail/gmail.ts labels
 *
 * Environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — JSON string of the service account key
 *   GMAIL_USER_EMAIL            — The email address to impersonate (e.g. user@domain.com)
 *
 * Setup requirements:
 *   1. Enable Gmail API in Google Cloud Console
 *   2. Grant domain-wide delegation to the service account in Google Workspace Admin:
 *      Admin Console → Security → API Controls → Domain-wide delegation
 *      Client ID: (from service account key JSON, field "client_id")
 *      Scopes: https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send
 */

import { google, gmail_v1 } from 'googleapis';

type Action = 'list' | 'search' | 'read' | 'send' | 'reply' | 'labels';

interface Args {
  action: Action;
  flags: Record<string, string>;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;

  const validActions: Action[] = ['list', 'search', 'read', 'send', 'reply', 'labels'];
  if (!validActions.includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: ${validActions.join(', ')}`,
      usage: [
        'npx tsx tools/gmail/gmail.ts list [--max-results 10] [--label INBOX]',
        'npx tsx tools/gmail/gmail.ts search --query "from:alice subject:invoice"',
        'npx tsx tools/gmail/gmail.ts read --id <messageId>',
        'npx tsx tools/gmail/gmail.ts send --to "a@b.com" --subject "Hi" --body "Hello"',
        'npx tsx tools/gmail/gmail.ts reply --id <messageId> --body "Thanks"',
        'npx tsx tools/gmail/gmail.ts labels',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return { action, flags };
}

function getAuth(): { gmail: gmail_v1.Gmail; userEmail: string } {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const userEmail = process.env.GMAIL_USER_EMAIL;

  if (!keyJson) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable.',
    }));
    process.exit(1);
  }
  if (!userEmail) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GMAIL_USER_EMAIL environment variable. Set it to the email address to impersonate.',
    }));
    process.exit(1);
  }

  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    console.error(JSON.stringify({
      status: 'error',
      error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.',
    }));
    process.exit(1);
  }

  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    subject: userEmail, // Impersonate this user via domain-wide delegation
  });

  const gmail = google.gmail({ version: 'v1', auth });
  return { gmail, userEmail };
}

function decodeBody(body: gmail_v1.Schema$MessagePartBody | undefined): string {
  if (!body?.data) return '';
  return Buffer.from(body.data, 'base64url').toString('utf-8');
}

function extractTextFromParts(parts: gmail_v1.Schema$MessagePart[] | undefined): string {
  if (!parts) return '';
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return decodeBody(part.body);
    }
  }
  // Fallback to HTML if no plain text
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return decodeBody(part.body);
    }
  }
  // Recurse into nested parts
  for (const part of parts) {
    if (part.parts) {
      const text = extractTextFromParts(part.parts);
      if (text) return text;
    }
  }
  return '';
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

// Default Gmail search filter: exclude marketing categories, newsletters, and noreply senders.
// Only returns real person-to-person business emails by default.
const DEFAULT_INBOX_FILTER = '-category:promotions -category:social -category:updates -category:forums -from:noreply -from:no-reply -from:newsletter -from:notifications -from:mailer -from:marketing';

async function listMessages(gmail: gmail_v1.Gmail, flags: Record<string, string>) {
  const maxResults = parseInt(flags['max-results'] || '10', 10);
  // Use search query to filter out junk by default; --no-filter to get everything
  const useFilter = flags['no-filter'] !== 'true';
  const baseQuery = useFilter ? DEFAULT_INBOX_FILTER : '';
  const userQuery = flags.query ? `${flags.query} ${baseQuery}`.trim() : baseQuery;

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    labelIds: flags.label ? [flags.label] : ['INBOX'],
    q: userQuery || undefined,
  });

  const messages = [];
  for (const msg of res.data.messages || []) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    messages.push({
      id: detail.data.id,
      threadId: detail.data.threadId,
      snippet: detail.data.snippet,
      from: getHeader(detail.data.payload?.headers, 'From'),
      to: getHeader(detail.data.payload?.headers, 'To'),
      subject: getHeader(detail.data.payload?.headers, 'Subject'),
      date: getHeader(detail.data.payload?.headers, 'Date'),
      labelIds: detail.data.labelIds,
    });
  }

  console.log(JSON.stringify({
    status: 'success',
    action: 'list',
    messageCount: messages.length,
    messages,
  }));
}

async function searchMessages(gmail: gmail_v1.Gmail, flags: Record<string, string>) {
  if (!flags.query) {
    console.error(JSON.stringify({ status: 'error', error: 'search requires --query' }));
    process.exit(1);
  }

  const maxResults = parseInt(flags['max-results'] || '20', 10);
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: flags.query,
    maxResults,
  });

  const messages = [];
  for (const msg of res.data.messages || []) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    messages.push({
      id: detail.data.id,
      threadId: detail.data.threadId,
      snippet: detail.data.snippet,
      from: getHeader(detail.data.payload?.headers, 'From'),
      to: getHeader(detail.data.payload?.headers, 'To'),
      subject: getHeader(detail.data.payload?.headers, 'Subject'),
      date: getHeader(detail.data.payload?.headers, 'Date'),
    });
  }

  console.log(JSON.stringify({
    status: 'success',
    action: 'search',
    query: flags.query,
    messageCount: messages.length,
    messages,
  }));
}

async function readMessage(gmail: gmail_v1.Gmail, flags: Record<string, string>) {
  if (!flags.id) {
    console.error(JSON.stringify({ status: 'error', error: 'read requires --id' }));
    process.exit(1);
  }

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: flags.id,
    format: 'full',
  });

  const headers = res.data.payload?.headers;
  const body = res.data.payload?.body?.data
    ? decodeBody(res.data.payload.body)
    : extractTextFromParts(res.data.payload?.parts);

  const attachments = (res.data.payload?.parts || [])
    .filter(p => p.filename && p.body?.attachmentId)
    .map(p => ({
      filename: p.filename,
      mimeType: p.mimeType,
      size: p.body?.size,
      attachmentId: p.body?.attachmentId,
    }));

  console.log(JSON.stringify({
    status: 'success',
    action: 'read',
    message: {
      id: res.data.id,
      threadId: res.data.threadId,
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      cc: getHeader(headers, 'Cc'),
      subject: getHeader(headers, 'Subject'),
      date: getHeader(headers, 'Date'),
      body: body.slice(0, 10000), // Truncate very long bodies
      labelIds: res.data.labelIds,
      attachments,
    },
  }));
}

function buildRawEmail(opts: {
  to: string;
  from: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  cc?: string;
}): string {
  const lines = [
    `To: ${opts.to}`,
    `From: ${opts.from}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ];
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push('', opts.body);

  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function sendMessage(gmail: gmail_v1.Gmail, userEmail: string, flags: Record<string, string>) {
  if (!flags.to || !flags.subject || !flags.body) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'send requires --to, --subject, and --body',
    }));
    process.exit(1);
  }

  const raw = buildRawEmail({
    to: flags.to,
    from: userEmail,
    subject: flags.subject,
    body: flags.body,
    cc: flags.cc,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  console.log(JSON.stringify({
    status: 'success',
    action: 'send',
    messageId: res.data.id,
    threadId: res.data.threadId,
  }));
}

async function replyToMessage(gmail: gmail_v1.Gmail, userEmail: string, flags: Record<string, string>) {
  if (!flags.id || !flags.body) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'reply requires --id and --body',
    }));
    process.exit(1);
  }

  // Get the original message to extract headers for threading
  const original = await gmail.users.messages.get({
    userId: 'me',
    id: flags.id,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Message-ID', 'References'],
  });

  const origHeaders = original.data.payload?.headers;
  const origFrom = getHeader(origHeaders, 'From');
  const origSubject = getHeader(origHeaders, 'Subject');
  const messageId = getHeader(origHeaders, 'Message-ID');
  const references = getHeader(origHeaders, 'References');

  const replySubject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

  const raw = buildRawEmail({
    to: origFrom,
    from: userEmail,
    subject: replySubject,
    body: flags.body,
    inReplyTo: messageId,
    references: references ? `${references} ${messageId}` : messageId,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: original.data.threadId || undefined,
    },
  });

  console.log(JSON.stringify({
    status: 'success',
    action: 'reply',
    messageId: res.data.id,
    threadId: res.data.threadId,
    inReplyTo: flags.id,
  }));
}

async function listLabels(gmail: gmail_v1.Gmail) {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const labels = (res.data.labels || []).map(l => ({
    id: l.id,
    name: l.name,
    type: l.type,
    messagesTotal: l.messagesTotal,
    messagesUnread: l.messagesUnread,
  }));

  console.log(JSON.stringify({
    status: 'success',
    action: 'labels',
    labelCount: labels.length,
    labels,
  }));
}

async function main() {
  const { action, flags } = parseArgs();
  const { gmail, userEmail } = getAuth();

  try {
    switch (action) {
      case 'list':
        await listMessages(gmail, flags);
        break;
      case 'search':
        await searchMessages(gmail, flags);
        break;
      case 'read':
        await readMessage(gmail, flags);
        break;
      case 'send':
        await sendMessage(gmail, userEmail, flags);
        break;
      case 'reply':
        await replyToMessage(gmail, userEmail, flags);
        break;
      case 'labels':
        await listLabels(gmail);
        break;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    // Provide actionable guidance for common auth errors
    if (error.includes('401') || error.includes('403') || error.includes('unauthorized') || error.includes('Delegation denied')) {
      console.error(JSON.stringify({
        status: 'error',
        error,
        hint: 'Gmail API authorization failed. Verify: (1) Gmail API is enabled in Google Cloud Console, (2) Domain-wide delegation is configured in Google Workspace Admin Console > Security > API Controls > Domain-wide delegation with scopes: https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send, (3) GMAIL_USER_EMAIL is a valid mailbox in the Workspace domain.',
      }));
    } else {
      console.error(JSON.stringify({ status: 'error', error }));
    }
    process.exit(1);
  }
}

main();
