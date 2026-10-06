import P from 'pino';

/**
 * Shared structured logger.
 *
 * Call sites pass a flat object with an `event` key, e.g.
 *   logger.info({ event: 'pipeline.done', language, totalInputTokens });
 *
 * Privacy: log fields are metadata only. Never pass transcript, summary, or
 * any other message text through here — the same constraint that keeps content
 * out of the `transcriptions` table applies to logs.
 */
export const logger = P({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined, // drop pid/hostname; this is a single-process app
  timestamp: P.stdTimeFunctions.isoTime,
});
