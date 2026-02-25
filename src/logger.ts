import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

/**
 * Log a security-relevant event with a consistent `audit: true` tag.
 * Filterable via: grep '"audit":true' or pino query.
 */
export function audit(event: string, data: Record<string, unknown> = {}): void {
  logger.info({ audit: true, event, ...data }, `[AUDIT] ${event}`);
}

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason, stack: reason instanceof Error ? reason.stack : undefined },
    'Unhandled rejection — this may indicate a missing await or uncaught promise error',
  );
});
