/**
 * Web Chat Channel
 * Socket.IO + Express server for website live chat.
 * Serves static widget files and handles real-time messaging.
 * JID format: web:sheridan (one JID per business, multiple concurrent visitors)
 */
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';

import {
  WEB_CHANNEL_PORT,
  WEB_CHANNEL_ORIGINS,
  ASSISTANT_NAME,
} from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ── Rate Limiting ──────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 300_000);

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

// ── Types ──────────────────────────────────────────────────────────

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface VisitorSession {
  socketId: string;
  visitorId: string;
  ip: string;
  connectedAt: string;
}

// ── Channel Implementation ─────────────────────────────────────────

export class WebChannel implements Channel {
  name = 'web';

  private server: http.Server | null = null;
  private io: any = null; // Socket.IO server instance
  private connected = false;
  private opts: WebChannelOpts;

  /** Map visitorId → socket for outbound routing. */
  private visitorSockets = new Map<string, any>();

  /** Map socket.id → visitorId for cleanup on disconnect. */
  private socketToVisitor = new Map<string, string>();

  /** Track last sender per JID for reply routing. */
  private lastSenderByJid = new Map<string, string>();

  /** Dedup processed message IDs. */
  private processedMessageIds = new Set<string>();

  /** Widget static files directory. */
  private widgetDir: string;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
    this.widgetDir = path.resolve(process.cwd(), 'widget');
  }

  async connect(): Promise<void> {
    // Dynamic import of socket.io (ESM)
    const { Server } = await import('socket.io');

    // Parse allowed origins
    const origins = WEB_CHANNEL_ORIGINS
      ? WEB_CHANNEL_ORIGINS.split(',').map((o) => o.trim())
      : ['*'];

    // Create HTTP server for static files + Socket.IO
    this.server = http.createServer((req, res) => {
      const ip =
        req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
        req.socket.remoteAddress ||
        'unknown';

      if (isRateLimited(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":"rate limited"}');
        return;
      }

      // CORS headers
      const origin = req.headers.origin || '';
      if (origins.includes('*') || origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Serve static widget files
      if (req.method === 'GET' && req.url?.startsWith('/widget/')) {
        this.serveStatic(req, res);
        return;
      }

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            visitors: this.visitorSockets.size,
          }),
        );
        return;
      }

      // Square webhook endpoint
      if (req.method === 'POST' && req.url === '/webhook/square') {
        this.handleSquareWebhook(req, res);
        return;
      }

      res.writeHead(200);
      res.end('ok');
    });

    // Create Socket.IO server
    this.io = new Server(this.server, {
      cors: {
        origin: origins.includes('*') ? true : origins,
        methods: ['GET', 'POST'],
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Handle connections
    this.io.on('connection', (socket: any) => {
      const ip =
        socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
        socket.handshake.address ||
        'unknown';

      if (isRateLimited(ip)) {
        socket.disconnect(true);
        return;
      }

      // Generate or restore visitor ID
      const visitorId =
        socket.handshake.auth?.visitorId || crypto.randomUUID();

      logger.info(
        { visitorId, socketId: socket.id, ip },
        'Web chat visitor connected',
      );

      // Track the connection
      this.visitorSockets.set(visitorId, socket);
      this.socketToVisitor.set(socket.id, visitorId);

      // Send visitor their ID (for reconnection)
      socket.emit('session', { visitorId });

      // Handle incoming messages
      socket.on('message', (data: { text?: string }) => {
        if (!data?.text?.trim()) return;

        if (isRateLimited(ip)) {
          socket.emit('error', { message: 'Too many messages, slow down' });
          return;
        }

        this.handleInboundMessage(visitorId, data.text.trim(), ip);
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        logger.debug({ visitorId }, 'Web chat visitor disconnected');
        this.socketToVisitor.delete(socket.id);
        // Keep visitorSockets entry for a while in case they reconnect
        // Clean up after 5 minutes
        setTimeout(() => {
          const current = this.visitorSockets.get(visitorId);
          if (current === socket) {
            this.visitorSockets.delete(visitorId);
          }
        }, 300_000);
      });
    });

    // Start listening
    await new Promise<void>((resolve) => {
      this.server!.listen(WEB_CHANNEL_PORT, () => {
        this.connected = true;
        logger.info(
          { port: WEB_CHANNEL_PORT, origins },
          'Web channel server listening',
        );
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Find the visitor to send to
    const visitorId = this.lastSenderByJid.get(jid);
    if (!visitorId) {
      logger.warn({ jid }, 'No visitor known for web reply');
      return;
    }

    const socket = this.visitorSockets.get(visitorId);
    if (!socket?.connected) {
      logger.warn(
        { jid, visitorId },
        'Visitor socket not connected for reply',
      );
      return;
    }

    // Parse structured content from Andy's response
    // Andy can embed structured data using XML-like tags
    const parsed = this.parseResponse(text);

    socket.emit('message', parsed);

    logger.info(
      { jid, visitorId, length: text.length },
      'Web message sent to visitor',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.io) {
      this.io.close();
    }
    if (this.server) {
      await new Promise<void>((resolve) =>
        this.server!.close(() => resolve()),
      );
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const visitorId = this.lastSenderByJid.get(jid);
    if (!visitorId) return;

    const socket = this.visitorSockets.get(visitorId);
    if (!socket?.connected) return;

    socket.emit('typing', isTyping);
  }

  // ── Inbound Message Handling ─────────────────────────────────────

  private handleInboundMessage(
    visitorId: string,
    text: string,
    ip: string,
  ): void {
    const msgId = `web-${visitorId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Dedup
    if (this.processedMessageIds.has(msgId)) return;
    this.processedMessageIds.add(msgId);

    // Cap dedup set
    if (this.processedMessageIds.size > 5000) {
      const entries = [...this.processedMessageIds];
      this.processedMessageIds = new Set(entries.slice(-2500));
    }

    // Route to the sheridan web JID
    const jid = 'web:sheridan';

    // Track visitor for reply routing
    this.lastSenderByJid.set(jid, visitorId);

    const timestamp = new Date().toISOString();

    // Update chat metadata
    this.opts.onChatMetadata(jid, timestamp, 'Web Chat');

    // Only deliver to registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      logger.warn({ jid }, 'Web JID not registered, message dropped');
      return;
    }

    const newMsg: NewMessage = {
      id: msgId,
      chat_jid: jid,
      sender: `visitor:${visitorId}`,
      sender_name: `Web Visitor`,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onMessage(jid, newMsg);
  }

  // ── Response Parsing ─────────────────────────────────────────────

  /**
   * Parse Andy's response for structured content.
   * Andy can include buttons, cards, and payment links using tags:
   *
   * <buttons>Book Now|Check Availability|Ask a Question</buttons>
   * <payment-link url="https://...">Pay Deposit</payment-link>
   */
  private parseResponse(text: string): {
    content: string;
    buttons?: Array<{ label: string; value: string }>;
    paymentLink?: string;
  } {
    const result: {
      content: string;
      buttons?: Array<{ label: string; value: string }>;
      paymentLink?: string;
    } = { content: text };

    // Extract buttons: <buttons>Label1|Label2|Label3</buttons>
    const buttonsMatch = text.match(/<buttons>(.*?)<\/buttons>/s);
    if (buttonsMatch) {
      result.buttons = buttonsMatch[1]
        .split('|')
        .map((b) => b.trim())
        .filter(Boolean)
        .map((label) => ({ label, value: label }));
      result.content = result.content
        .replace(/<buttons>.*?<\/buttons>/s, '')
        .trim();
    }

    // Extract payment link: <payment-link url="...">Label</payment-link>
    const paymentMatch = text.match(
      /<payment-link\s+url="([^"]+)">(.*?)<\/payment-link>/s,
    );
    if (paymentMatch) {
      result.paymentLink = paymentMatch[1];
      result.content = result.content
        .replace(/<payment-link\s+url="[^"]+">.*?<\/payment-link>/s, '')
        .trim();
    }

    return result;
  }

  // ── Static File Serving ──────────────────────────────────────────

  private serveStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const urlPath = req.url || '';
    // Strip /widget/ prefix and decode
    const fileName = decodeURIComponent(urlPath.replace('/widget/', ''));

    // Security: prevent path traversal
    const safeName = path.basename(fileName);
    const filePath = path.join(this.widgetDir, safeName);

    // Check file exists
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Content type mapping
    const ext = path.extname(safeName).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    // Cache for 1 hour
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    });

    fs.createReadStream(filePath).pipe(res);
  }

  // ── Square Webhook ───────────────────────────────────────────────

  private handleSquareWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    let bodySize = 0;
    const MAX_BODY_SIZE = 1_048_576;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413);
        res.end('{"error":"payload too large"}');
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      res.writeHead(200);
      res.end('{"ok":true}');

      try {
        const payload = JSON.parse(body);
        if (payload.type === 'payment.completed') {
          const payment = payload.data?.object?.payment;
          if (payment) {
            logger.info(
              {
                paymentId: payment.id,
                amount: payment.amount_money?.amount,
                status: payment.status,
              },
              'Square payment completed webhook',
            );
            // Payment confirmation will be picked up by Andy via the
            // check-payment tool when customer says they've paid
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to parse Square webhook');
      }
    });
  }
}
