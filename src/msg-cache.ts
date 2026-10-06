import type { proto } from '@whiskeysockets/baileys';

/**
 * Recently-sent message store, used to answer WhatsApp retry receipts.
 *
 * When a recipient device fails to decrypt a message it asks the sender to
 * re-encrypt and re-send it. Baileys serves that request from the `getMessage`
 * socket config; if it can't find the original the recipient is stuck showing
 * "Waiting for this message. This may take a while." forever.
 *
 * Also tracks retry counts per message so callers can detect when a mobile
 * device is stuck (Signal session drift) and trigger a Telegram fallback.
 *
 * Privacy: this is in-memory only and never written to the database. The reply
 * text lives here for at most RETRY_WINDOW_MS and dies with the process, the
 * same way transcript text already flows through memory and SSE only.
 */

// Baileys gives up on retries after 1 hour (DEFAULT_CACHE_TTLS.MSG_RETRY), so
// holding a message longer than that can never help anyone.
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

// After this many retry receipts for the same message, the mobile Signal
// session is considered stuck and callers should trigger a fallback delivery.
const STUCK_RETRY_THRESHOLD = 2;

interface Entry {
  message: proto.IMessage;
  expiresAt: number;
  replyText?: string;
  chatJid?: string;
  fromJid?: string;
  retryCount: number;
}

// Module-level in-memory state: the app runs as a single process (see README, Architecture).
const cache = new Map<string, Entry>();

// Background sweep so expired entries don't linger in heap on idle deployments.
// prune() is also called on every insertion, but without this interval a burst of
// messages followed by silence leaves transcript-bearing proto.IMessage objects in
// memory past their RETRY_WINDOW_MS expiry indefinitely.
// .unref() prevents the interval from keeping the process alive during tests.
setInterval(() => prune(Date.now()), 60_000).unref();

function cacheKey(userId: number, msgId: string): string {
  return `${userId}:${msgId}`;
}

function prune(now: number): void {
  for (const [key, entry] of cache) {
    // Invariant: all entries use the same RETRY_WINDOW_MS TTL, so insertion
    // order equals expiry order and break is safe. If variable TTLs are ever
    // introduced, replace break with continue (full scan) or maintain a heap.
    if (entry.expiresAt > now) break;
    cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export interface SentMessageMeta {
  replyText?: string;
  chatJid?: string;
  fromJid?: string;
}

export function rememberSentMessage(
  userId: number,
  msgId: string | null | undefined,
  message: proto.IMessage | null | undefined,
  meta?: SentMessageMeta
): void {
  if (!msgId || !message) return;
  const now = Date.now();
  prune(now);
  const key = cacheKey(userId, msgId);
  // Re-insert rather than overwrite: Map keeps a re-set key at its original
  // position, which would break the insertion-order == expiry-order assumption
  // prune() relies on.
  cache.delete(key);
  cache.set(key, {
    message,
    expiresAt: now + RETRY_WINDOW_MS,
    retryCount: 0,
    ...meta,
  });
}

export function recallSentMessage(
  userId: number,
  msgId: string | null | undefined
): proto.IMessage | undefined {
  if (!msgId) return undefined;
  const entry = cache.get(cacheKey(userId, msgId));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey(userId, msgId));
    return undefined;
  }
  return entry.message;
}

export interface RetryResult {
  isStuck: boolean;
  replyText?: string;
  chatJid?: string;
  fromJid?: string;
}

/**
 * Record a retry receipt for a previously-sent message and return whether
 * the mobile is considered stuck (Signal session drift detected).
 * Only meaningful when the caller already confirmed the message exists (found: true).
 */
export function recordRetry(
  userId: number,
  msgId: string | null | undefined
): RetryResult {
  if (!msgId) return { isStuck: false };
  const key = cacheKey(userId, msgId);
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return { isStuck: false };
  entry.retryCount += 1;
  return {
    isStuck: entry.retryCount >= STUCK_RETRY_THRESHOLD,
    replyText: entry.replyText,
    chatJid: entry.chatJid,
    fromJid: entry.fromJid,
  };
}

export function forgetUserMessages(userId: number): void {
  const prefix = `${userId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
