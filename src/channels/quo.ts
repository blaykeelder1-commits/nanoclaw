/**
 * Quo Phone (OpenPhone) SMS Channel
 * Receives inbound SMS via webhook, sends outbound via OpenPhone API.
 * JID format: quo:+1XXXXXXXXXX (the business phone number)
 */
import http from 'http';

import {
  ASSISTANT_NAME,
  QUO_API_KEY,
  QUO_SNAK_NUMBER,
  QUO_SNAK_PHONE_ID,
  QUO_SHERIDAN_NUMBER,
  QUO_SHERIDAN_PHONE_ID,
  QUO_WEBHOOK_PORT,
} from '../config.js';
import { upsertContactFromPhone } from '../db.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface QuoChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/** Map business number → OpenPhone phoneNumberId for outbound sending. */
interface PhoneLine {
  phoneId: string;
  number: string;
}

export class QuoChannel implements Channel {
  name = 'quo';

  private server: http.Server | null = null;
  private connected = false;
  private opts: QuoChannelOpts;

  /**
   * Track last inbound sender per JID so we know who to reply to.
   * Key: quo:+1XXXX (business line JID), Value: customer phone number (+1YYYY)
   */
  private lastSenderByJid = new Map<string, string>();

  /** Map business number → phoneId for outbound routing. */
  private phoneLines: PhoneLine[] = [];

  constructor(opts: QuoChannelOpts) {
    this.opts = opts;

    // Register configured phone lines
    if (QUO_SNAK_PHONE_ID && QUO_SNAK_NUMBER) {
      this.phoneLines.push({ phoneId: QUO_SNAK_PHONE_ID, number: QUO_SNAK_NUMBER });
    }
    if (QUO_SHERIDAN_PHONE_ID && QUO_SHERIDAN_NUMBER) {
      this.phoneLines.push({ phoneId: QUO_SHERIDAN_PHONE_ID, number: QUO_SHERIDAN_NUMBER });
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        logger.info({ method: req.method, url: req.url }, 'Quo HTTP request received');
        if (req.method === 'POST' && req.url === '/webhook/quo') {
          this.handleWebhook(req, res);
        } else if (req.method === 'GET' && req.url === '/webhook/quo') {
          // Some webhook providers do a GET verification check
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });

      this.server.listen(QUO_WEBHOOK_PORT, () => {
        this.connected = true;
        logger.info({ port: QUO_WEBHOOK_PORT }, 'Quo webhook server listening');
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Find the phone line for this JID
    const businessNumber = jid.replace('quo:', '');
    const line = this.phoneLines.find((l) => l.number === businessNumber);
    if (!line) {
      logger.warn({ jid }, 'No Quo phone line configured for JID');
      return;
    }

    // Find the customer number to reply to
    const customerNumber = this.lastSenderByJid.get(jid);
    if (!customerNumber) {
      logger.warn({ jid }, 'No customer number known for Quo reply');
      return;
    }

    // Prefix with assistant name for consistency
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    try {
      const response = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': QUO_API_KEY,
        },
        body: JSON.stringify({
          content: prefixed,
          from: line.phoneId,
          to: [customerNumber],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.error({ jid, status: response.status, body }, 'Quo send failed');
      } else {
        logger.info({ jid, to: customerNumber, length: prefixed.length }, 'Quo message sent');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Quo send error');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('quo:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  // SMS does not support typing indicators
  // setTyping is intentionally not implemented

  private handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');

      try {
        logger.debug({ rawBody: body.slice(0, 500) }, 'Quo webhook raw body');
        const payload = JSON.parse(body);
        this.processInbound(payload);
      } catch (err) {
        logger.error({ err, rawBody: body.slice(0, 200) }, 'Failed to parse Quo webhook payload');
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private processInbound(payload: any): void {
    logger.info({ type: payload.type, hasData: !!payload.data }, 'Quo webhook payload');

    // OpenPhone webhook format: { type: "message.received", data: { object: { ... } } }
    if (payload.type !== 'message.received') return;

    const msg = payload.data?.object;
    if (!msg) return;

    logger.info({
      direction: msg.direction,
      from: msg.from,
      to: msg.to,
      text: msg.text,
      body: msg.body,
      phoneNumberId: msg.phoneNumberId,
    }, 'Quo inbound message details');

    if (msg.direction !== 'incoming') return;

    const customerNumber = msg.from;
    // Quo API: 'to' can be a string or array
    const businessNumber = Array.isArray(msg.to) ? msg.to[0] : msg.to;
    // Quo uses 'text' in API responses but may use 'body' in webhooks — accept both
    const text = msg.text || msg.body || '';
    if (!customerNumber || !businessNumber || !text) return;

    // Determine which business line received this
    const line = this.phoneLines.find((l) => l.phoneId === msg.phoneNumberId);
    const jid = line ? `quo:${line.number}` : `quo:${businessNumber}`;

    // Track the customer number for reply routing
    this.lastSenderByJid.set(jid, customerNumber);

    const timestamp = msg.createdAt || new Date().toISOString();

    // Update chat metadata
    this.opts.onChatMetadata(jid, timestamp, `Quo ${line?.number || businessNumber}`);

    // Only deliver to registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const newMsg: NewMessage = {
      id: msg.id || `quo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: jid,
      sender: customerNumber,
      sender_name: customerNumber,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onMessage(jid, newMsg);

    // Auto-create CRM contact from inbound SMS
    try {
      upsertContactFromPhone(customerNumber, `quo:${line?.number || businessNumber}`, []);
    } catch (err) {
      logger.debug({ err, phone: customerNumber }, 'CRM auto-create failed');
    }
  }
}
