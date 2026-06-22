/**
 * Outbound pipeline — runs all outbound stages in order.
 * Stages can reject (suppress send) or transform (modify text).
 */
import { logger } from '../logger.js';
import { OutboundStage, OutboundMessage, OutboundVerdict } from './types.js';

export class OutboundPipeline {
  private stages: OutboundStage[] = [];

  add(stage: OutboundStage): this {
    this.stages.push(stage);
    return this;
  }

  /** Returns the final text to send, or null if suppressed. */
  process(msg: OutboundMessage): string | null {
    return this.processDetailed(msg).text;
  }

  /**
   * Like process(), but reports WHICH stage suppressed the message. Callers use
   * this to distinguish an intentional drop (dedup/error-suppressor) from a
   * genuine loss (rate-limit) that should be dead-lettered, not silently dropped.
   */
  processDetailed(msg: OutboundMessage): { text: string | null; rejectedBy?: string; reason?: string } {
    let text = msg.text;

    for (const stage of this.stages) {
      const verdict = stage.process({ ...msg, text });
      if (verdict.action === 'reject') {
        logger.debug(
          { stage: stage.name, jid: msg.chatJid, reason: verdict.reason },
          'Outbound message rejected by pipeline',
        );
        return { text: null, rejectedBy: stage.name, reason: verdict.reason };
      }
      if (verdict.action === 'transform') {
        text = verdict.text;
      }
    }

    return { text };
  }
}
