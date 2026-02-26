#!/usr/bin/env npx tsx
/**
 * Send Email Tool for NanoClaw
 * Usage: npx tsx tools/email/send-email.ts --to "email" --subject "subject" --body "body" [--html]
 *
 * Environment variables (set in container .env or passed via secrets):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

import { createTransport } from 'nodemailer';
import { checkAndIncrementSendCount } from '../shared/send-rate-limit.js';

interface EmailArgs {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  cc?: string;
  bcc?: string;
  replyTo?: string;
}

function parseArgs(): EmailArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--html') {
      result.html = true;
    } else if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  if (!result.to || !result.subject || !result.body) {
    console.error('Usage: send-email --to "email" --subject "subject" --body "body" [--html] [--cc "email"] [--bcc "email"] [--replyTo "email"]');
    process.exit(1);
  }

  return result as unknown as EmailArgs;
}

async function main() {
  const args = parseArgs();

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing SMTP configuration. Set SMTP_HOST, SMTP_USER, SMTP_PASS environment variables.',
    }));
    process.exit(1);
  }

  const transporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const mailOptions: Record<string, unknown> = {
    from,
    to: args.to,
    subject: args.subject,
  };

  if (args.html) {
    mailOptions.html = args.body;
  } else {
    mailOptions.text = args.body;
  }

  if (args.cc) mailOptions.cc = args.cc;
  if (args.bcc) mailOptions.bcc = args.bcc;
  if (args.replyTo) mailOptions.replyTo = args.replyTo;

  try {
    checkAndIncrementSendCount();
    const info = await transporter.sendMail(mailOptions);
    console.log(JSON.stringify({
      status: 'success',
      messageId: info.messageId,
      to: args.to,
      subject: args.subject,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      to: args.to,
    }));
    process.exit(1);
  }
}

main();
