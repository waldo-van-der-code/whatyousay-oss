/**
 * Telegram ops alerts.
 *
 * Exists because the 2026-09-22 outage was silent: Groq retired the only LLM the
 * pipeline used, every voice note past 30 words stopped being transcribed, and the
 * first anyone knew was a person asking whether the server was down. Nothing is
 * wrong with the logs — nobody reads logs they have no reason to open.
 *
 * **Privacy: metadata only.** The same constraint that keeps transcript text out of
 * the database and out of `src/logger.ts` applies here, and harder: this leaves the
 * machine. Never pass transcript text, summary text, contact names or full phone
 * numbers — identify a contact only with maskJid(). That covers the key too: it
 * is written to the log by every notify.* line. Field values are truncated and
 * long digit runs masked as a backstop, not as permission.
 *
 * Alerting must never be able to break transcription, so every function here
 * swallows its own errors and resolves. A broken bot token degrades to silence,
 * never to a failed voice note.
 */

import { logger } from './logger';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Optional: route alerts to a specific topic in a supergroup.
const THREAD_ID = process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined;

const SEND_TIMEOUT_MS = 10_000;

// One alert per key per window. A retired model produces one failure per voice
// message; without this the first hour of an outage is a hundred identical pings
// and the useful one is buried.
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const lastSentAt = new Map<string, number>();
const suppressedSince = new Map<string, number>();

// A field value long enough to be prose is a bug in the caller, not a field.
const MAX_FIELD_CHARS = 120;

// Backstop for full phone numbers and JIDs: any run of 9+ digits is masked in
// the key, the title and every field before anything is logged or sent. Callers
// still pass maskJid() output; this only catches the next caller who forgets.
// 9, not fewer: a JID's user part (country code + number, or a LID) is longer,
// while a date suffix in a model id (`-20250514`) must stay readable and keep
// its own dedupe key.
const LONG_DIGITS = /\d{9,}/g;
function scrubDigits(s: string): string {
  return s.replace(LONG_DIGITS, '#');
}

/**
 * The only form in which a WhatsApp contact may appear in an alert or a log:
 * the last four digits of the JID's user part (device suffix dropped), e.g.
 * `…5678`. Enough to tell senders apart, not enough to identify one.
 */
export function maskJid(jid: string | null | undefined): string {
  const digits = (jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : 'unknown';
}

export function notifyEnabled(): boolean {
  return !!BOT_TOKEN && !!CHAT_ID;
}

/** Exposed for evals; resets the dedupe state between checks. */
export function __resetNotifyState(): void {
  lastSentAt.clear();
  suppressedSince.clear();
}

function renderFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const raw = scrubDigits(String(v));
      const value = raw.length > MAX_FIELD_CHARS ? `${raw.slice(0, MAX_FIELD_CHARS)}…` : raw;
      return `${k}: ${value}`;
    })
    .join('\n');
}

/**
 * Sends an operational alert, at most once per `key` per 15 minutes.
 *
 * `key` groups alerts that mean the same thing — include the failing step or model
 * in it so different failures stay separate while a storm of one failure collapses
 * into a single message.
 */
export async function notifyOps(
  rawKey: string,
  rawTitle: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  const key = scrubDigits(rawKey);
  const title = scrubDigits(rawTitle);
  try {
    const now = Date.now();
    const last = lastSentAt.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      suppressedSince.set(key, (suppressedSince.get(key) ?? 0) + 1);
      return;
    }

    const suppressed = suppressedSince.get(key) ?? 0;
    suppressedSince.delete(key);
    lastSentAt.set(key, now);

    const body = [
      `⚠️ WhatYouSay — ${title}`,
      renderFields(fields),
      suppressed > 0 ? `(${suppressed} identical alert(s) suppressed since the last one)` : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (!notifyEnabled()) {
      // Unconfigured is a valid state — local dev and anyone who has not set up a
      // bot. The alert still reaches the log so nothing is lost silently.
      logger.warn({ event: 'notify.skipped_unconfigured', key, title });
      return;
    }

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: body, disable_web_page_preview: true, ...(THREAD_ID ? { message_thread_id: THREAD_ID } : {}) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Do not log the response body: a Telegram error echoes the message back,
      // and the message is the thing we are being careful about.
      logger.error({ event: 'notify.send_failed', key, status: res.status });
      return;
    }

    logger.info({ event: 'notify.sent', key });
  } catch (err) {
    logger.error({ event: 'notify.error', key, errName: (err as Error)?.name });
  }
}
