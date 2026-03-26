/**
 * Message formatting utilities.
 * Error suppression has moved to the outbound pipeline (pipeline/stages/error-suppressor.ts).
 */
import { NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function formatConversationHistory(
  messages: NewMessage[],
  assistantName: string,
): string {
  if (messages.length === 0) return '';

  const lines = messages.map((m) => {
    const name = m.is_bot_message ? `${assistantName} (you)` : m.sender_name;
    return `<message sender="${escapeXml(name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });

  return [
    '<conversation-history note="Recent conversation history for context. Do NOT re-answer or repeat these messages — they have already been handled. Only respond to the NEW messages below.">',
    ...lines,
    '</conversation-history>',
  ].join('\n');
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

/** Derive the human-readable channel name from a chat JID. */
export function channelFromJid(jid: string): string {
  if (jid.startsWith('quo:')) return 'sms';
  if (jid.startsWith('web:')) return 'web';
  if (jid.startsWith('email:')) return 'email';
  if (jid.startsWith('messenger:')) return 'messenger';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  return 'unknown';
}
