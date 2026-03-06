#!/usr/bin/env npx tsx
/**
 * LinkedIn Warm Outreach Tool for NanoClaw
 * Usage:
 *   npx tsx tools/social/linkedin-connect.ts connect --linkedin-url "https://linkedin.com/in/johndoe" --note "Hi John, I noticed..." [--contact-id <id>]
 *   npx tsx tools/social/linkedin-connect.ts message --linkedin-url "https://linkedin.com/in/johndoe" --text "Thanks for connecting..."
 *   npx tsx tools/social/linkedin-connect.ts batch --limit 15
 *
 * Uses LinkedIn API v2
 * Environment: LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN (format: urn:li:person:XXXXX)
 */

import https from 'https';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

interface ConnectArgs {
  action: string;
  'linkedin-url'?: string;
  note?: string;
  'contact-id'?: string;
  text?: string;
  limit?: string;
}

function parseArgs(): ConnectArgs {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || !['connect', 'message', 'batch'].includes(action)) {
    console.error('Usage:\n  linkedin-connect connect --linkedin-url <url> --note "..." [--contact-id <id>]\n  linkedin-connect message --linkedin-url <url> --text "..."\n  linkedin-connect batch [--limit 15]');
    process.exit(1);
  }

  const result: Record<string, string> = { action };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  return result as unknown as ConnectArgs;
}

function getCredentials(): { accessToken: string; personUrn: string } {
  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  const personUrn = process.env.LINKEDIN_PERSON_URN;

  if (!accessToken || !personUrn) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing LinkedIn credentials. Set LINKEDIN_ACCESS_TOKEN and LINKEDIN_PERSON_URN.',
    }));
    process.exit(1);
  }

  return { accessToken, personUrn };
}

function getDb(readonly = false): Database.Database {
  const dbPath = path.join(process.cwd(), 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath, { readonly });
}

function extractProfileId(linkedinUrl: string): string {
  // Extract profile ID from URLs like:
  //   https://linkedin.com/in/johndoe
  //   https://www.linkedin.com/in/johndoe/
  const match = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (!match) {
    console.error(JSON.stringify({ status: 'error', error: `Could not extract profile ID from URL: ${linkedinUrl}` }));
    process.exit(1);
  }
  return match[1];
}

function linkedInRequest(urlPath: string, body: unknown, accessToken: string): Promise<{ statusCode: number; data: string; headers: Record<string, string> }> {
  const postData = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.linkedin.com${urlPath}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          data,
          headers: res.headers as Record<string, string>,
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendConnectionRequest(linkedinUrl: string, note: string, accessToken: string): Promise<{ success: boolean; profileId: string; error?: string }> {
  const profileId = extractProfileId(linkedinUrl);

  if (note.length > 300) {
    return { success: false, profileId, error: `Note exceeds 300 character limit (${note.length} chars)` };
  }

  const body = {
    invitee: {
      'com.linkedin.voyager.growth.invitation.InviteeProfile': {
        profileId,
      },
    },
    message: {
      'com.linkedin.voyager.growth.invitation.FormattedInvitation': {
        inviteeMessage: note,
      },
    },
  };

  try {
    const res = await linkedInRequest('/v2/invitations', body, accessToken);

    if (res.statusCode === 201 || res.statusCode === 200) {
      return { success: true, profileId };
    } else {
      return { success: false, profileId, error: `HTTP ${res.statusCode}: ${res.data}` };
    }
  } catch (err) {
    return { success: false, profileId, error: (err as Error).message };
  }
}

async function sendMessage(linkedinUrl: string, text: string, accessToken: string, personUrn: string): Promise<void> {
  const profileId = extractProfileId(linkedinUrl);
  const recipientUrn = `urn:li:person:${profileId}`;

  const body = {
    recipients: [recipientUrn],
    subject: 'Message',
    body: text,
    messageType: 'MEMBER_TO_MEMBER',
    'com.linkedin.voyager.messaging.MessageCreate': {
      attributedBody: {
        text,
        attributes: [],
      },
    },
  };

  try {
    const res = await linkedInRequest('/v2/messages', body, accessToken);

    if (res.statusCode === 201 || res.statusCode === 200) {
      console.log(JSON.stringify({
        status: 'success',
        action: 'message',
        recipient: profileId,
        text: text.slice(0, 100),
      }));
    } else {
      console.error(JSON.stringify({
        status: 'error',
        action: 'message',
        statusCode: res.statusCode,
        error: res.data,
      }));
      process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({ status: 'error', error: (err as Error).message }));
    process.exit(1);
  }
}

function updateContactNotes(contactId: string, message: string): void {
  const db = getDb(false);
  const contact = db.prepare('SELECT notes FROM contacts WHERE id = ?').get(contactId) as { notes: string | null } | undefined;

  if (!contact) {
    db.close();
    console.error(JSON.stringify({ status: 'warning', message: `Contact ${contactId} not found in CRM` }));
    return;
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const newNote = `${message}: ${timestamp}`;
  const updatedNotes = contact.notes ? `${contact.notes}\n${newNote}` : newNote;

  db.prepare('UPDATE contacts SET notes = ?, updated_at = ? WHERE id = ?')
    .run(updatedNotes, new Date().toISOString(), contactId);
  db.close();
}

async function handleConnect(args: ConnectArgs): Promise<void> {
  const { accessToken } = getCredentials();
  const linkedinUrl = args['linkedin-url'];
  const note = args.note || '';

  if (!linkedinUrl) {
    console.error(JSON.stringify({ status: 'error', error: 'Missing --linkedin-url' }));
    process.exit(1);
  }

  if (!note) {
    console.error(JSON.stringify({ status: 'error', error: 'Missing --note (connection request message)' }));
    process.exit(1);
  }

  const result = await sendConnectionRequest(linkedinUrl, note, accessToken);

  if (result.success) {
    if (args['contact-id']) {
      updateContactNotes(args['contact-id'], 'LinkedIn connection sent');
    }

    console.log(JSON.stringify({
      status: 'success',
      action: 'connect',
      profileId: result.profileId,
      linkedin_url: linkedinUrl,
      note: note.slice(0, 100),
      contact_updated: !!args['contact-id'],
    }));
  } else {
    console.error(JSON.stringify({
      status: 'error',
      action: 'connect',
      profileId: result.profileId,
      error: result.error,
    }));
    process.exit(1);
  }
}

async function handleMessage(args: ConnectArgs): Promise<void> {
  const { accessToken, personUrn } = getCredentials();
  const linkedinUrl = args['linkedin-url'];
  const text = args.text;

  if (!linkedinUrl) {
    console.error(JSON.stringify({ status: 'error', error: 'Missing --linkedin-url' }));
    process.exit(1);
  }

  if (!text) {
    console.error(JSON.stringify({ status: 'error', error: 'Missing --text (message content)' }));
    process.exit(1);
  }

  await sendMessage(linkedinUrl, text, accessToken, personUrn);
}

interface ContactRow {
  id: string;
  first_name: string;
  last_name: string;
  company: string | null;
  linkedin_url: string;
  lead_score: number | null;
  notes: string | null;
}

async function handleBatch(args: ConnectArgs): Promise<void> {
  const { accessToken } = getCredentials();
  const limit = parseInt(args.limit || '15', 10);
  const db = getDb(true);

  const contacts = db.prepare(
    `SELECT id, first_name, last_name, company, linkedin_url, lead_score, notes
     FROM contacts
     WHERE linkedin_url IS NOT NULL
       AND linkedin_url != ''
       AND (notes IS NULL OR notes NOT LIKE '%LinkedIn connection sent%')
       AND (tags IS NULL OR tags NOT LIKE '%do-not-contact%')
     ORDER BY lead_score DESC
     LIMIT ?`,
  ).all(limit) as ContactRow[];

  db.close();

  if (contacts.length === 0) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'batch',
      message: 'No eligible contacts found for LinkedIn outreach',
      sent: 0,
    }));
    return;
  }

  const results: Array<{ id: string; name: string; profileId: string; success: boolean; error?: string }> = [];

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const firstName = contact.first_name;
    const companyPart = contact.company
      ? `I noticed ${contact.company} in the Houston area. `
      : '';

    const note = `Hi ${firstName}, ${companyPart}We help businesses like yours with premium vending and coffee solutions. Would love to connect!`;

    // Truncate to 300 chars if needed
    const truncatedNote = note.length > 300 ? note.slice(0, 297) + '...' : note;

    const result = await sendConnectionRequest(contact.linkedin_url, truncatedNote, accessToken);

    results.push({
      id: contact.id,
      name: `${firstName} ${contact.last_name}`,
      profileId: result.profileId,
      success: result.success,
      error: result.error,
    });

    if (result.success) {
      updateContactNotes(contact.id, 'LinkedIn connection sent');
    }

    // 30-second delay between requests to avoid rate limits (skip after last)
    if (i < contacts.length - 1) {
      await sleep(30000);
    }
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(JSON.stringify({
    status: 'success',
    action: 'batch',
    sent,
    failed,
    total: contacts.length,
    results,
  }));
}

async function main(): Promise<void> {
  const args = parseArgs();

  switch (args.action) {
    case 'connect':
      await handleConnect(args);
      break;
    case 'message':
      await handleMessage(args);
      break;
    case 'batch':
      await handleBatch(args);
      break;
  }
}

main();
