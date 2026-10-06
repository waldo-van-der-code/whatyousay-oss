import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  normalizeMessageContent,
  proto,
} from '@whiskeysockets/baileys';
import type { WASocket, AuthenticationState, SignalDataTypeMap, SignalDataSet, BaileysEventMap } from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';
import { getDb, uniqueMsgIdIndexActive } from './db';
import { getUserSettings } from './auth';
import { runPipeline } from './pipeline';
import { emitToUser } from './sse';
import { rememberSentMessage, recallSentMessage, recordRetry, forgetUserMessages } from './msg-cache';
import {
  rememberContactName,
  rememberGroupSubject,
  forgetUserIdentities,
  isContactExcluded,
  isGroupExcluded,
  findExclusion,
  getGroupSubject,
  jidNumber,
} from './exclusions';
import { logger } from './logger';
import { notifyOps, maskJid } from './notify';
import { encryptColumn, decryptColumn, waSessionAad } from './crypto';
import { trackInFlight } from './shutdown';

// Separate silent logger for Baileys internals — never used for app-level logging.
const baileys_logger = P({ level: 'silent' }) as any;

const sockets = new Map<number, WASocket>();
const connectionStatus = new Map<number, { connected: boolean; phone?: string; language?: string; avatarUrl?: string }>();
const connectWatchdogs = new Map<number, NodeJS.Timeout>();
const retryCounts = new Map<number, number>();

const CONNECT_TIMEOUT_MS = 45_000;
// After this many consecutive failed connect attempts (e.g. repeated 408s from
// WhatsApp's own connect layer), stop silently retrying forever and surface an
// error to the dashboard instead — this is the zombie-socket infinite-spinner bug.
const MAX_CONSECUTIVE_RETRIES = 4;

// ── Abuse-prevention rate limiting ──────────────────────────────────────────
// Baileys is an unofficial client emulating WhatsApp Web's linked-device
// protocol against a real personal number — it has no sandbox/test mode, and
// excessive failed connection attempts read to WhatsApp's abuse detection the
// same whether they come from a bug or a real attack. These limits sit below
// MAX_CONSECUTIVE_RETRIES to make sure retries (and manual re-attempts, like
// a user clicking "Get code" repeatedly, or the SSE connection reopening) can
// never turn into an unbounded stream of connection attempts against a single
// number or from this server as a whole.
const userCooldownUntil = new Map<number, number>();
const userLastAttemptAt = new Map<number, number>();
const PER_USER_COOLDOWN_MS = 5 * 60 * 1000; // "give up" period after MAX_CONSECUTIVE_RETRIES is hit
const MIN_ATTEMPT_INTERVAL_MS = 10_000; // never start two attempts for the same user closer than this
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_ATTEMPTS_PER_WINDOW = 10; // per bucket, across all users, per window

// Two global buckets (ME-065). New pairings (no linked device yet — the QR flow)
// and reconnects of already-linked accounts used to share one 10/min budget, so a
// handful of throwaway accounts opening the dashboard could starve real users'
// reconnects and leave their transcription down. Unpaired accounts now only ever
// spend the pairing bucket, and each is capped on its own as well.
const globalAttemptTimestamps = { pairing: [] as number[], reconnect: [] as number[] };
const PAIRING_USER_WINDOW_MS = 10 * 60 * 1000;
// One QR session is the first attempt plus up to MAX_CONSECUTIVE_RETRIES, so 6 lets
// a slow scan finish while keeping any single account from hogging the bucket.
const PAIRING_USER_MAX_ATTEMPTS = 6;
const userPairingAttempts = new Map<number, number[]>();

type Bucket = keyof typeof globalAttemptTimestamps;

function pruneWindow(timestamps: number[], windowMs: number, now: number): void {
  while (timestamps.length && now - timestamps[0] > windowMs) timestamps.shift();
}

function globalRateLimitOk(bucket: Bucket): boolean {
  const list = globalAttemptTimestamps[bucket];
  pruneWindow(list, GLOBAL_WINDOW_MS, Date.now());
  return list.length < GLOBAL_MAX_ATTEMPTS_PER_WINDOW;
}

/** Whether this user has a linked device on record (creds.me is set once a QR scan succeeds). */
function hasLinkedDevice(userId: number): boolean {
  try {
    const row = getDb().prepare('SELECT creds_json FROM wa_sessions WHERE user_id = ?').get(userId) as
      | { creds_json: string | null }
      | undefined;
    if (!row?.creds_json) return false;
    const creds = JSON.parse(decryptColumn(row.creds_json, waSessionAad(userId, 'creds')));
    return !!creds?.me?.id;
  } catch {
    return false;
  }
}

type ThrottleReason = 'cooldown' | 'too_soon' | 'global_limit' | 'pairing_limit';

function checkRateLimit(userId: number): { ok: true; bucket: Bucket } | { ok: false; reason: ThrottleReason } {
  const now = Date.now();
  const cooldown = userCooldownUntil.get(userId);
  if (cooldown && now < cooldown) return { ok: false, reason: 'cooldown' };
  const last = userLastAttemptAt.get(userId);
  if (last && now - last < MIN_ATTEMPT_INTERVAL_MS) return { ok: false, reason: 'too_soon' };
  const bucket: Bucket = hasLinkedDevice(userId) ? 'reconnect' : 'pairing';
  if (bucket === 'pairing') {
    const mine = userPairingAttempts.get(userId) ?? [];
    pruneWindow(mine, PAIRING_USER_WINDOW_MS, now);
    if (mine.length >= PAIRING_USER_MAX_ATTEMPTS) return { ok: false, reason: 'pairing_limit' };
  }
  if (!globalRateLimitOk(bucket)) return { ok: false, reason: 'global_limit' };
  return { ok: true, bucket };
}

function recordAttempt(userId: number, bucket: Bucket): void {
  const now = Date.now();
  userLastAttemptAt.set(userId, now);
  globalAttemptTimestamps[bucket].push(now);
  if (bucket === 'pairing') {
    const mine = userPairingAttempts.get(userId) ?? [];
    mine.push(now);
    userPairingAttempts.set(userId, mine);
  }
}

/** For evals only: the rate-limit decision for a user, without starting a socket. */
export function __checkConnectRateLimit(userId: number) {
  return checkRateLimit(userId);
}
/** For evals only: record an attempt as initWhatsApp would. */
export function __recordConnectAttempt(userId: number, bucket: Bucket): void {
  recordAttempt(userId, bucket);
}
/** For evals only: forget all connect-rate-limit state. */
export function __resetConnectRateLimits(): void {
  userCooldownUntil.clear();
  userLastAttemptAt.clear();
  userPairingAttempts.clear();
  globalAttemptTimestamps.pairing.length = 0;
  globalAttemptTimestamps.reconnect.length = 0;
}

const RATE_LIMIT_MESSAGES: Record<ThrottleReason, string> = {
  pairing_limit: 'Too many attempts to link WhatsApp. Please wait 10 minutes and try again.',
  cooldown: 'Could not connect to WhatsApp after several attempts. Please wait a few minutes and try again.',
  too_soon: 'Please wait a few seconds before trying again.',
  global_limit: 'Too many connection attempts right now. Please wait a minute and try again.',
};

// After a socket reconnects, Baileys delivers any messages that arrived during the
// disconnect window as type 'append' — the same type used for history sync. The
// handler normally drops all non-'notify' messages to avoid replying to history,
// but that silently discards voice notes sent in a brief disconnect gap (observed
// 2026-09-22: 5-second drop, one voice note lost). Within RECONNECT_GRACE_MS of
// a connect, 'append' messages with a fresh timestamp are treated as 'notify'.
const lastConnectedAt = new Map<number, number>();
const RECONNECT_GRACE_MS = 120_000; // 2 minutes

/** Returns true if an 'append' message should be processed as if it were 'notify'. */
export function __shouldProcessAppend(
  userId: number,
  msgTimestamp: number | null | undefined,
  now = Date.now()
): boolean {
  const connectedAt = lastConnectedAt.get(userId);
  if (!connectedAt || now - connectedAt > RECONNECT_GRACE_MS) return false;
  const msgTimestampMs = Number(msgTimestamp ?? 0) * 1000;
  // Math.abs catches clock-skewed senders whose device time is ahead of the server —
  // a future timestamp would make (now - ts) negative, always < GRACE, and wrongly pass.
  if (!msgTimestampMs || Math.abs(now - msgTimestampMs) > RECONNECT_GRACE_MS) return false;
  return true;
}

/** For evals only — sets the last-connected timestamp for a userId. */
export function __setLastConnectedAt(userId: number, timestamp: number): void {
  lastConnectedAt.set(userId, timestamp);
}

// Dedup: track recently processed message IDs to prevent double-firing on reconnect.
// Keyed per user, not per message id: WhatsApp gives a message the same id for
// every account that receives it, so when both ends of a chat are linked to this
// server the two sockets see the same id. A shared key let whichever socket got
// there first mark the message handled for everybody — including when its own
// settings then went on to skip it, which silently killed transcription for the
// other account in exactly one chat while every other chat kept working.
const processedMsgIds = new Set<string>();
const PROCESSED_MSG_TTL_MS = 5 * 60 * 1000; // 5 minutes

function processedKey(userId: number, msgId: string): string {
  return `${userId}:${msgId}`;
}

// Deliberate cross-account coupling, the one place it is wanted: each linked
// account decides for itself whether it transcribes, but the chat only ever gets
// one transcript. Without this, two linked accounts that both want a voice note
// transcribed each run the pipeline and each post the same text into the same
// chat — a duplicate for both of them and two Groq bills for one message. The
// first account whose own rules say yes claims the message; the rest step aside.
//
// Keyed by message id alone: in a 1-on-1 chat remoteJid is the *other* party, so
// it differs between the two accounts and cannot be part of a shared key.
const replyClaims = new Set<string>();
const REPLY_CLAIM_TTL_MS = 5 * 60 * 1000;

// Own number → userId for every currently connected account, so a recipient can
// recognise that the sender of a voice note is another account linked here.
// Registered on connect and dropped on close: an account whose socket is down
// never receives the message, so it must never be deferred to.
const accountNumbers = new Map<string, number>();

function registerAccountNumbers(userId: number, user: { id?: string; lid?: string; jid?: string } | undefined): void {
  unregisterAccountNumbers(userId);
  for (const id of [user?.id, user?.lid, user?.jid]) {
    if (!id) continue;
    const number = jidNumber(id);
    if (number) accountNumbers.set(number, userId);
  }
}

function unregisterAccountNumbers(userId: number): void {
  for (const [number, owner] of accountNumbers) {
    if (owner === userId) accountNumbers.delete(number);
  }
}

/**
 * Whether the account that sent this voice note is another account linked to this
 * same server that is going to transcribe it itself.
 *
 * The rule: the sender's settings come first. If the sender has WhatYouSay and
 * their own rules say transcribe, their account produces the transcript and every
 * recipient stands down. If the sender's rules say no — or they are not a user
 * here — a recipient's own rules apply instead, so a voice note is never lost
 * just because the person who sent it does not want their own copy.
 *
 * Deliberately conservative: it defers only when the sender's decision can be
 * read with confidence. Anything unreadable from here — their socket is down, an
 * exclusion list whose subject cannot be resolved — answers false, because the
 * cost of not deferring is a claim race between two accounts that still yields
 * exactly one transcript, while the cost of deferring wrongly is a transcript
 * nobody produces.
 */
function senderWillTranscribe(
  recipientUserId: number,
  senderJid: string | null | undefined,
  isGroup: boolean,
  chatJid: string,
  recipientOwnJid: string | undefined,
  recipientOwnName: string | undefined
): boolean {
  if (!senderJid) return false;
  const senderUserId = accountNumbers.get(jidNumber(senderJid));
  if (senderUserId === undefined || senderUserId === recipientUserId) return false;
  if (!sockets.has(senderUserId)) return false;

  const senderSettings = getUserSettings(senderUserId);
  const sendScopeOn = isGroup ? senderSettings.transcribe_group_sent : senderSettings.transcribe_1on1_sent;
  if (!sendScopeOn) return false;

  const senderExclusions = isGroup ? senderSettings.exclude_groups : senderSettings.exclude_contacts;
  if (Array.isArray(senderExclusions) && senderExclusions.length > 0) {
    if (isGroup) {
      // A group's subject belongs to the group, so either account's cache answers it.
      const subject = getGroupSubject(senderUserId, chatJid) ?? getGroupSubject(recipientUserId, chatJid);
      if (!subject) return false;
      if (findExclusion(senderExclusions, { names: [subject] })) return false;
    } else {
      // Seen from the sender's side, the contact at the other end of this chat is us.
      if (!recipientOwnJid) return false;
      if (findExclusion(senderExclusions, { jid: recipientOwnJid, names: [recipientOwnName] })) return false;
    }
  }

  return true;
}

function claimTranscript(msgId: string | null | undefined): boolean {
  // A message with no id cannot be matched up across accounts, so it is never
  // claimed — better a rare duplicate than a dropped transcript.
  if (!msgId) return true;
  if (replyClaims.has(msgId)) return false;
  replyClaims.add(msgId);
  setTimeout(() => replyClaims.delete(msgId), REPLY_CLAIM_TTL_MS);
  return true;
}

function releaseTranscript(msgId: string | null | undefined): void {
  if (msgId) replyClaims.delete(msgId);
}

// Map phone country code prefix → BCP-47 language code
const COUNTRY_LANG: Record<string, string> = {
  '1': 'en', '44': 'en', '61': 'en', '64': 'en', '353': 'en',
  '49': 'de', '43': 'de', '41': 'de',
  '31': 'nl', '32': 'nl',
  '33': 'fr', '352': 'fr',
  '34': 'es', '52': 'es', '54': 'es', '57': 'es', '56': 'es',
  '55': 'pt', '351': 'pt',
  '39': 'it',
  '81': 'ja', '82': 'ko',
  '86': 'zh', '852': 'zh', '886': 'zh',
  '91': 'hi',
  '7': 'ru', '380': 'uk', '48': 'pl',
  '45': 'da', '46': 'sv', '47': 'no', '358': 'fi',
  '420': 'cs', '36': 'hu', '40': 'ro',
};

function detectLangFromJid(jid: string): string {
  const number = jid.split('@')[0].split(':')[0];
  // Try longest country codes first to avoid prefix collisions (e.g. 358 before 35)
  const sorted = Object.keys(COUNTRY_LANG).sort((a, b) => b.length - a.length);
  for (const code of sorted) {
    if (number.startsWith(code)) return COUNTRY_LANG[code];
  }
  return 'en';
}

// Bumped every time a fresh auth state is built for a user. Each state keeps
// its own in-memory snapshot of keysData and saveToDb rewrites the whole blob,
// so a socket that has been replaced must never write again — doing so restores
// stale Signal session state and leaves the peer unable to decrypt.
const authGeneration = new Map<number, number>();


function makeSQLiteAuthState(userId: number) {
  const db = getDb();
  const generation = (authGeneration.get(userId) ?? 0) + 1;
  authGeneration.set(userId, generation);
  const row = db
    .prepare('SELECT creds_json, keys_json FROM wa_sessions WHERE user_id = ?')
    .get(userId) as { creds_json: string | null; keys_json: string | null } | undefined;

  // Encrypted at rest since ME-065; legacy plaintext rows still load and are
  // re-saved encrypted on the next write. A value that fails to decrypt (wrong
  // DB_ENCRYPTION_KEY, tampering) throws here on purpose: falling back to
  // initAuthCreds() would overwrite the stored pairing on the first save.
  const creds = row?.creds_json
    ? JSON.parse(decryptColumn(row.creds_json, waSessionAad(userId, 'creds')), BufferJSON.reviver)
    : initAuthCreds();

  const keysData: Record<string, unknown> = row?.keys_json
    ? JSON.parse(decryptColumn(row.keys_json, waSessionAad(userId, 'keys')), BufferJSON.reviver)
    : {};

  const saveToDb = () => {
    if (authGeneration.get(userId) !== generation) {
      logger.warn({ event: 'wa.auth_write_dropped', userId });
      return;
    }
    db.prepare(
      'INSERT OR REPLACE INTO wa_sessions (user_id, creds_json, keys_json) VALUES (?, ?, ?)'
    ).run(
      userId,
      encryptColumn(JSON.stringify(creds, BufferJSON.replacer), waSessionAad(userId, 'creds')),
      encryptColumn(JSON.stringify(keysData, BufferJSON.replacer), waSessionAad(userId, 'keys'))
    );
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const val = keysData[`${type}-${id}`];
          if (val !== undefined) result[id] = val as SignalDataTypeMap[T];
        }
        return result;
      },
      set: async (data: SignalDataSet) => {
        for (const category in data) {
          const cat = (data as any)[category] as Record<string, unknown> | undefined;
          if (!cat) continue;
          for (const id in cat) {
            const val = cat[id];
            if (val == null) delete keysData[`${category}-${id}`];
            else keysData[`${category}-${id}`] = val;
          }
        }
        saveToDb();
      },
    },
  };

  return { state, saveCreds: async () => saveToDb() };
}

export function getConnectionStatus(userId: number): { connected: boolean; phone?: string; language?: string; avatarUrl?: string } {
  return connectionStatus.get(userId) ?? { connected: false };
}

export async function disconnectWhatsApp(userId: number): Promise<void> {
  const sock = sockets.get(userId);
  if (sock) {
    try { await sock.logout(); } catch { /* ignore */ }
    sockets.delete(userId);
  }
  connectionStatus.delete(userId);
  unregisterAccountNumbers(userId);
  retryCounts.delete(userId);
  userCooldownUntil.delete(userId);
  forgetUserMessages(userId);
  forgetUserIdentities(userId);
  getDb().prepare('DELETE FROM wa_sessions WHERE user_id = ?').run(userId);
}

// Dedup guard: fire the fallback at most once per stuck message across all retry
// receipts. The msgIdSuffix is enough; collisions are acceptable (1 in 4 billion).
const handledStuckIds = new Set<string>();

async function handleDeliveryStuck(
  userId: number,
  replyText: string | undefined,
  chatJid: string | undefined,
  fromJid: string | undefined
): Promise<void> {
  const dedupKey = `${userId}:${chatJid ?? fromJid ?? ''}`;
  if (handledStuckIds.has(dedupKey)) return;
  handledStuckIds.add(dedupKey);
  setTimeout(() => handledStuckIds.delete(dedupKey), 10 * 60 * 1000);

  // Masked: the alert leaves the machine and its key is logged (src/notify.ts).
  // Never the sender's display name or full number (ME-065).
  const sender = maskJid(fromJid);
  const chat = chatJid?.endsWith('@g.us') ? 'group' : '1-on-1';
  logger.warn({ event: 'wa.session_resync', userId, reason: 'delivery_stuck' });

  // Force the socket to reconnect so WhatsApp renegotiates Signal keys.
  // After reconnect, send the transcript as a fresh message — new keys mean
  // the mobile can decrypt it even though the original was stuck.
  const currentSock = sockets.get(userId);
  if (currentSock) {
    try { await currentSock.end(undefined); } catch { /* ignore — disconnect handler fires */ }
  }

  if (replyText && chatJid) {
    // Wait for the reconnect to complete before re-sending. The reconnect
    // takes ~3s on a good connection; 8s gives a comfortable margin.
    setTimeout(async () => {
      const sock = sockets.get(userId);
      if (!sock) {
        logger.warn({ event: 'wa.fallback_resend_skipped', userId, reason: 'not_connected' });
        return;
      }
      try {
        const prefix = `_(Transcript re-sent — your phone couldn't decrypt the original)_\n\n`;
        await sock.sendMessage(chatJid, { text: prefix + replyText });
        logger.info({ event: 'wa.fallback_resend', userId });
      } catch (err) {
        logger.error({ event: 'wa.fallback_resend_error', userId, errName: (err as Error)?.name });
      }
    }, 8000);
  }

  await notifyOps(
    // Two contacts sharing the last 4 digits within 15 min share one alert; the
    // re-send is unaffected (handledStuckIds keys on the full chat in memory).
    `delivery_stuck:${userId}:${chat}:${sender}`,
    `WhatsApp mobile delivery stuck for user ${userId} — session resynced, re-sending transcript`,
    { sender, chat }
  );
}

export async function initWhatsApp(userId: number): Promise<void> {
  if (sockets.has(userId)) return;
  const rateCheck = checkRateLimit(userId);
  if (!rateCheck.ok) {
    logger.warn({ event: 'wa.connect_throttled', userId, reason: rateCheck.reason });
    emitToUser(userId, 'connect_failed', { message: RATE_LIMIT_MESSAGES[rateCheck.reason] });
    return;
  }
  recordAttempt(userId, rateCheck.bucket);
  try {
    createSocket(userId);
  } catch (err) {
    // Typically a wa_sessions row that cannot be decrypted. errName only: a JSON
    // parse error message quotes the input, which here is key material.
    logger.error({ event: 'wa.auth_state_load_failed', userId, errName: (err as Error)?.name });
    emitToUser(userId, 'connect_failed', { message: 'Could not load your WhatsApp session. Please contact support.' });
    throw err;
  }
}

// There is deliberately no "auto-heal" that wipes keys_json on undecryptable
// messages (WAY-056). keys_json holds the private halves of the one-time prekeys
// WhatsApp's server is still handing out to senders; deleting them made every new
// session with this device undecryptable, which looked like stale state and fired
// the wipe again. Signal recovers from a broken session through Baileys' retry
// receipts, which carry fresh keys from the second retry on.

// Baileys answers every message it cannot decrypt — and every "unavailable"
// stanza — by sending the user's *phone* a peer-data-operation request
// (PLACEHOLDER_MESSAGE_RESEND) asking it to re-send the plaintext. The phone
// serves that as a companion sync and posts "Finished syncing with WhatsApp on
// Safari (WhatYouSay)" each time. During an undecryptable storm (WAY-052) that
// is one notification per message. The earlier WAY-052 fixes (markOnlineOnConnect,
// fireInitQueries) did not touch this path, which is why the spam continued.
//
// requestPlaceholderResend returns early when this cache says the id was already
// requested, so a cache that always answers "yes" turns it off. Nothing is lost
// for voice notes: the normal retry receipt to the *sender* still goes out, and
// that is what makes the sender re-encrypt. There is no config flag for this in
// Baileys 6.7.x; re-check this after upgrading Baileys.
// Baileys also reads this cache for every incoming message, so it must stay
// silent and cheap — no logging here.
export function noPhoneResendCache() {
  return {
    get<T>(_key: string): T | undefined {
      return true as unknown as T;
    },
    set<T>(_key: string, _value: T): void { /* never store: requests stay suppressed */ },
    del(_key: string): void { /* nothing stored */ },
    flushAll(): void { /* nothing stored */ },
  };
}

function createSocket(userId: number): WASocket {

  const { state, saveCreds } = makeSQLiteAuthState(userId);

  const sock = makeWASocket({
    auth: state,
    logger: baileys_logger,
    printQRInTerminal: false,
    browser: ['WhatYouSay', 'Safari', '1.0.0'],
    syncFullHistory: false,
    // Don't broadcast "available" presence on every reconnect — reduces activity
    // that causes WhatsApp to treat reconnects as new sessions (which fires the
    // "Syncing with WhatsApp" phone notification). WhatYouSay is a background
    // service; it doesn't need to appear online to contacts.
    markOnlineOnConnect: false,
    // Skip fetchProps / fetchBlocklist / fetchPrivacySettings on every connect.
    // These IQ queries signal "active sync" to WhatsApp's backend, which is what
    // triggers the "Syncing with WhatsApp on Safari (WhatYouSay)" push notification
    // on the user's phone. WhatYouSay does not use any of these — they are for
    // UI features (privacy toggles, blocked contacts, server feature flags) that a
    // background transcription service has no need for.
    fireInitQueries: false,
    // Never ask the phone to re-send a message we could not decrypt. See
    // noPhoneResendCache — this is what spammed "Finished syncing with WhatsApp
    // on Safari (WhatYouSay)" onto the linked phone.
    placeholderResendCache: noPhoneResendCache(),
    // A recipient device that cannot decrypt a message asks us to re-encrypt
    // and re-send it. Baileys answers that retry receipt only if it can look
    // the original message back up here; the library default returns undefined,
    // which leaves the recipient on "Waiting for this message" permanently.
    getMessage: async key => {
      const message = recallSentMessage(userId, key.id);
      logger.info({ event: 'wa.retry_request', userId, found: !!message, msgIdSuffix: key.id?.slice(-8) });
      if (message) {
        const retry = recordRetry(userId, key.id);
        if (retry.isStuck) {
          logger.warn({ event: 'wa.delivery_stuck', userId, msgIdSuffix: key.id?.slice(-8) });
          handleDeliveryStuck(userId, retry.replyText, retry.chatJid, retry.fromJid);
        }
      }
      return message;
    },
  });

  sockets.set(userId, sock);

  // Watchdog: if the socket neither generates a QR nor opens within 45s it is
  // stuck (zombie). Tear it down and retry so the dashboard doesn't spin forever.
  const watchdog = setTimeout(() => {
    if (sockets.get(userId) !== sock) return;
    logger.warn({ event: 'wa.connect_timeout', userId });
    try { sock.ev.removeAllListeners('creds.update'); } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('messages.upsert'); } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('connection.update'); } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('contacts.upsert'); } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('contacts.update'); } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('groups.upsert'); } catch { /* ignore */ }
    try { sock.ev.removeAllListeners('groups.update'); } catch { /* ignore */ }
    sockets.delete(userId);
    connectionStatus.set(userId, { connected: false });
    connectWatchdogs.delete(userId);
    setTimeout(() => initWhatsApp(userId).catch(() => { /* logged in initWhatsApp */ }), 1000);
  }, CONNECT_TIMEOUT_MS);
  connectWatchdogs.set(userId, watchdog);

  sock.ev.on('creds.update', saveCreds);

  // Names and subjects for the exclusion lists. WhatsApp syncs these on connect,
  // which is what lets a name rule ("Except these people: Alex") hold for a
  // message we send before that contact has sent us anything this boot.
  sock.ev.on('contacts.upsert', contacts => {
    for (const c of contacts) rememberContactName(userId, c.id, c.notify ?? c.name);
  });
  sock.ev.on('contacts.update', contacts => {
    for (const c of contacts) rememberContactName(userId, c.id, c.notify ?? c.name);
  });
  sock.ev.on('groups.upsert', groups => {
    for (const g of groups) rememberGroupSubject(userId, g.id, g.subject);
  });
  sock.ev.on('groups.update', groups => {
    for (const g of groups) rememberGroupSubject(userId, g.id, g.subject);
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      clearTimeout(connectWatchdogs.get(userId));
      connectWatchdogs.delete(userId);
      try {
        const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
        emitToUser(userId, 'qr', { dataUrl });
      } catch (err) {
        logger.error({ event: 'wa.qr_failed', userId, errName: (err as Error)?.name });
      }
    }

    if (connection === 'open') {
      clearTimeout(connectWatchdogs.get(userId));
      connectWatchdogs.delete(userId);
      const jid = sock.user?.id ?? '';
      // No key wipe on connect (WAY-056): by now Baileys has uploaded prekeys, so a
      // wipe would orphan them. A genuine re-pair starts from a deleted row anyway.
      const phone = jid.split(':')[0];
      const phoneFormatted = phone ? `+${phone}` : 'connected';
      // Phone country code → language for flag display only; never override translate_target_language
      const language = detectLangFromJid(jid);

      // Try to fetch the user's WhatsApp profile photo for the nav avatar
      let avatarUrl: string | undefined;
      try {
        avatarUrl = await sock.profilePictureUrl(jid, 'image') ?? undefined;
      } catch { /* private/unavailable */ }

      retryCounts.delete(userId);
      userCooldownUntil.delete(userId);
      // Only open a new grace window if the previous one has already expired.
      // A flaky network can fire connection:open repeatedly within 120s; sliding
      // lastConnectedAt forward each time would keep the window open indefinitely.
      const prevConnect = lastConnectedAt.get(userId);
      if (!prevConnect || Date.now() - prevConnect > RECONNECT_GRACE_MS) {
        lastConnectedAt.set(userId, Date.now());
      }
      registerAccountNumbers(userId, sock.user);
      connectionStatus.set(userId, { connected: true, phone: phoneFormatted, language, avatarUrl });
      emitToUser(userId, 'connected', { connected: true, phone: phoneFormatted, language, avatarUrl });
      logger.info({ event: 'wa.connected', userId, language });
    }

    if (connection === 'close') {
      // Guard against a second close event on a dead socket (Baileys can emit
      // multiple connection.update{close} events during teardown). Without this
      // check a stale event fires after a new socket has been installed, deletes
      // the new socket from the map, and creates an orphaned duplicate session.
      if (sockets.get(userId) !== sock) return;

      clearTimeout(connectWatchdogs.get(userId));
      connectWatchdogs.delete(userId);

      // Detach all listeners from the dead socket before replacing it.
      try { sock.ev.removeAllListeners('creds.update'); } catch { /* ignore */ }
      try { sock.ev.removeAllListeners('messages.upsert'); } catch { /* ignore */ }
      try { sock.ev.removeAllListeners('connection.update'); } catch { /* ignore */ }
      try { sock.ev.removeAllListeners('contacts.upsert'); } catch { /* ignore */ }
      try { sock.ev.removeAllListeners('contacts.update'); } catch { /* ignore */ }
      try { sock.ev.removeAllListeners('groups.upsert'); } catch { /* ignore */ }
      try { sock.ev.removeAllListeners('groups.update'); } catch { /* ignore */ }
      sockets.delete(userId);
      unregisterAccountNumbers(userId);
      connectionStatus.set(userId, { connected: false });
      emitToUser(userId, 'disconnected', { connected: false });

      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        logger.info({ event: 'wa.logged_out', userId });
        retryCounts.delete(userId);
        userCooldownUntil.delete(userId);
        forgetUserMessages(userId);
        forgetUserIdentities(userId);
        getDb().prepare('DELETE FROM wa_sessions WHERE user_id = ?').run(userId);
      } else {
        const attempts = (retryCounts.get(userId) ?? 0) + 1;
        if (attempts > MAX_CONSECUTIVE_RETRIES) {
          logger.warn({ event: 'wa.connect_failed', userId, statusCode, attempts });
          retryCounts.delete(userId);
          userCooldownUntil.set(userId, Date.now() + PER_USER_COOLDOWN_MS);
          emitToUser(userId, 'connect_failed', { message: RATE_LIMIT_MESSAGES.cooldown });
        } else {
          retryCounts.set(userId, attempts);
          logger.info({ event: 'wa.disconnected', userId, statusCode, attempts });
          setTimeout(() => initWhatsApp(userId).catch(() => { /* logged in initWhatsApp */ }), 3000 * attempts);
        }
      }
    }
  });

  const handleUpsert = async ({ messages, type }: BaileysEventMap['messages.upsert']) => {
    // 'append' = history sync on reconnect; 'notify' = genuinely new incoming message.
    // Exception: within RECONNECT_GRACE_MS of a socket reconnect, 'append' messages
    // with a fresh timestamp were almost certainly sent during the disconnect window
    // and would otherwise be silently lost (observed 2026-09-22, WAY-39).
    const connectedAt = lastConnectedAt.get(userId);
    const isAppendInGrace = type === 'append' &&
      connectedAt !== undefined &&
      Date.now() - connectedAt <= RECONNECT_GRACE_MS;
    if (type !== 'notify' && !isAppendInGrace) return;

    for (const msg of messages) {
      if (!msg.key.remoteJid || msg.key.remoteJid === 'status@broadcast') continue;

      // Log only the last 4 digits of the phone number — enough for debugging,
      // not enough to reconstruct the full contact identity.
      const jidSuffix = msg.key.remoteJid.split('@')[0].slice(-4);
      const isGroup = msg.key.remoteJid.endsWith('@g.us');
      const isSent = msg.key.fromMe ?? false;

      // Learn display names from every message that carries one, not just voice
      // notes. WhatsApp only attaches pushName to messages *from* a contact, so
      // this is the only chance to learn the name of someone we later send to —
      // without it a name-based exclusion rule would work in one direction only.
      if (!isSent) {
        rememberContactName(userId, isGroup ? msg.key.participant : msg.key.remoteJid, msg.pushName);
      }

      // WhatsApp wraps the real content in a container message whenever the chat has
      // disappearing messages switched on (ephemeralMessage), the voice note was sent
      // as play-once (viewOnceMessage*), or the message was later edited. Reading
      // msg.message.audioMessage sees through none of those, so every voice note from
      // a contact who keeps disappearing messages on was dropped here in silence.
      // normalizeMessageContent unwraps all of them — it is the same helper
      // downloadMediaMessage applies internally to find the media it fetches, so
      // whatever comes back out of it can be downloaded below.
      const content = normalizeMessageContent(msg.message ?? undefined);
      const audio = content?.audioMessage;
      if (!audio) {
        // A message that failed to decrypt carries a CIPHERTEXT stub instead of
        // content, so there is nothing to transcribe either way. It still earns a
        // log line: a broken Signal session with one contact shows up as every
        // message from them landing here, which is otherwise indistinguishable
        // from them never having sent one. Checked after unwrapping rather than
        // before, so a message where only one of several encrypted payloads
        // failed still gets transcribed from the payload that did decrypt.
        if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
          // The libsignal error text ("Bad MAC", "Invalid PreKey ID", ...) says which
          // key is missing; Baileys' own logger is silent, so this is the only record.
          logger.warn({ event: 'wa.msg_undecryptable', userId, jidSuffix, reason: String(msg.messageStubParameters?.[0] ?? '').replace(/\d{5,}/g, '#').slice(0, 80) });
        }
        continue;
      }

      // For append-in-grace messages, also check this specific message is fresh.
      // History sync and live delivery can arrive in the same append batch — the
      // message timestamp separates them.
      if (isAppendInGrace) {
        const msgTimestampMs = Number(msg.messageTimestamp ?? 0) * 1000;
        if (!msgTimestampMs || !__shouldProcessAppend(userId, msgTimestampMs / 1000)) {
          logger.debug({ event: 'wa.append_dropped_stale', userId, jidSuffix });
          continue;
        }
        logger.info({ event: 'wa.append_processed_as_fresh', userId, jidSuffix });
      }

      // This user's own rules decide, before anything is marked as handled. A
      // message this account declines must leave no trace behind: marking it
      // first is what let one account's "no" cancel another account's "yes".
      const settings = getUserSettings(userId);

      const scope = isGroup
        ? (isSent ? 'group_sent' : 'group_received')
        : (isSent ? '1on1_sent' : '1on1_received');
      const scopeEnabled = isGroup
        ? (isSent ? settings.transcribe_group_sent : settings.transcribe_group_received)
        : (isSent ? settings.transcribe_1on1_sent : settings.transcribe_1on1_received);
      if (!scopeEnabled) {
        // Logged so "why was this one never transcribed?" can be answered from the
        // logs instead of by guessing at the settings.
        logger.info({ event: 'wa.voice_skipped', userId, jidSuffix, reason: `${scope}_disabled` });
        continue;
      }

      // "Except these people / groups". Contacts are matched in 1-on-1 chats and
      // group names in groups, mirroring where the dashboard puts each field.
      const excluded = isGroup
        ? await isGroupExcluded(userId, settings.exclude_groups, msg.key.remoteJid, async () => {
            const meta = await sock.groupMetadata(msg.key.remoteJid!);
            return meta.subject;
          })
        : isContactExcluded(userId, settings.exclude_contacts, msg.key.remoteJid, msg.pushName);
      if (excluded) {
        // The matching rule is a contact's name or number, so it stays out of the log.
        logger.info({
          event: 'wa.voice_skipped',
          userId,
          jidSuffix,
          reason: isGroup ? 'excluded_group' : 'excluded_contact',
        });
        continue;
      }

      // The sender's rules come first. If this voice note came from another account
      // linked to this server and their own settings will transcribe it, stand down
      // so the chat gets their transcript instead of a second identical one.
      if (
        !isSent &&
        senderWillTranscribe(
          userId,
          isGroup ? msg.key.participant : msg.key.remoteJid,
          isGroup,
          msg.key.remoteJid,
          sock.user?.id,
          sock.user?.name
        )
      ) {
        logger.info({ event: 'wa.voice_skipped', userId, jidSuffix, reason: 'sender_account_owns' });
        continue;
      }

      // Two-tier dedup: prevents duplicate transcripts when Baileys re-delivers an
      // already-processed voice message (most commonly triggered by a process restart).
      const msgId = msg.key.id;

      // Tier 1 — in-memory Set (fast path; handles same-session re-delivery without a DB hit)
      if (msgId && processedMsgIds.has(processedKey(userId, msgId))) continue;

      // sentinelRowId is the rowid of the row we INSERT before starting the pipeline.
      // Writing before the pipeline (not after) closes the restart-race gap: if the
      // process crashes between sendMessage and the INSERT, the row already exists, so
      // a re-delivery after restart is correctly skipped rather than re-transcribed.
      // On pipeline failure the sentinel is deleted (see catch below) so a retry can reclaim it.
      let sentinelRowId: number | undefined;

      if (!msgId) {
        // No message ID: cannot dedup — processing unconditionally. Rare in practice.
        logger.warn({ event: 'wa.voice_no_msgid', userId });
      } else {
        // Tier 2 — atomic sentinel INSERT: survives process restarts that clear the in-memory Set.
        // INSERT OR IGNORE relies on the UNIQUE index on (user_id, wa_msg_id WHERE wa_msg_id IS NOT NULL).
        // from_jid uses msg.key.remoteJid as a placeholder (NOT NULL constraint); updated after pipeline.
        //
        // If the UNIQUE index failed to create at startup (e.g. duplicate rows in an existing DB),
        // uniqueMsgIdIndexActive is false and INSERT OR IGNORE has no constraint to enforce.
        // In that case, fall back to an explicit SELECT check before inserting — less atomic
        // but still correct: Tier 1 (Set) handles same-session races; the SELECT covers restarts.
        if (!uniqueMsgIdIndexActive) {
          const existing = getDb()
            .prepare('SELECT 1 FROM transcriptions WHERE user_id = ? AND wa_msg_id = ?')
            .get(userId, msgId);
          if (existing) {
            logger.info({ event: 'wa.duplicate_skipped', userId, msgIdSuffix: msgId.slice(-8) });
            continue;
          }
        }
        const claim = getDb()
          .prepare(
            `INSERT OR IGNORE INTO transcriptions (user_id, wa_msg_id, content_deleted, from_jid)
             VALUES (?, ?, 1, ?)`
          )
          .run(userId, msgId, msg.key.remoteJid);
        if (uniqueMsgIdIndexActive && claim.changes === 0) {
          logger.info({ event: 'wa.duplicate_skipped', userId, msgIdSuffix: msgId.slice(-8) });
          continue;
        }
        sentinelRowId = Number(claim.lastInsertRowid);
        processedMsgIds.add(processedKey(userId, msgId));
        setTimeout(() => processedMsgIds.delete(processedKey(userId, msgId)), PROCESSED_MSG_TTL_MS);
      }

      // Last gate: if another linked account already took this voice note, the
      // chat has its transcript and a second copy helps nobody.
      if (!claimTranscript(msgId)) {
        // Undo the sentinel and Set entry written above — this account is standing down.
        // Without cleanup, a re-delivery after restart would hit the orphaned sentinel and
        // emit duplicate_skipped, permanently locking this account out of being a fallback
        // if the claiming account later fails.
        if (sentinelRowId !== undefined) {
          getDb().prepare('DELETE FROM transcriptions WHERE rowid = ?').run(sentinelRowId);
        }
        if (msgId) processedMsgIds.delete(processedKey(userId, msgId));
        logger.info({ event: 'wa.voice_skipped', userId, jidSuffix, reason: 'claimed_by_other_account' });
        continue;
      }

      logger.info({ event: 'wa.voice_received', userId, jidSuffix, scope });
      let sendSucceeded = false;
      try {
        const buffer = (await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        )) as Buffer;

        // Diagnostic for WAY-22 (could knownNames be auto-filled from group metadata?):
        // how many participants carry a display name. Counts only, never the names (ME-065).
        if (isGroup) {
          try {
            const meta = await sock.groupMetadata(msg.key.remoteJid);
            logger.info({
              event: 'wa.group_meta_sample',
              participantCount: meta.participants.length,
              namedCount: meta.participants.filter(p => !!(p as any).notify).length,
            });
          } catch (e) {
            logger.info({ event: 'wa.group_meta_failed', errName: (e as Error)?.name });
          }
        }

        // Only pass user-configured known_names as Whisper prompt — do NOT inject the
        // sender's display name. Whisper's prompt is preceding context, not a speaker label:
        // when a name like "Alex Example" is in the prompt, Whisper aligns it phonetically
        // against the audio and stops transcribing the moment it "finds" the name, producing
        // severe truncation. The sender name had no measurable benefit for transcription quality.
        const pipelineSettings = settings;

        const result = await runPipeline(buffer, pipelineSettings as any);

        // A disappearing-messages chat stamps its TTL onto every message in it.
        // Mirror it onto the reply so the transcript cannot outlive the voice note
        // it transcribes — a plain reply would sit in that chat forever.
        const ephemeralExpiration = audio.contextInfo?.expiration ?? undefined;

        // For own group messages, Baileys participant may be a LID — use the socket's own JID instead
        const fromJid = isGroup
          ? (isSent ? (sock.user?.id ?? msg.key.remoteJid) : (msg.key.participant ?? msg.key.remoteJid))
          : msg.key.remoteJid;
        const pushName = (msg as any).pushName as string | undefined;

        // Update the sentinel row with pipeline results BEFORE sending the reply.
        // Writing first closes the restart-race gap (WAY-40): a crash between this UPDATE and
        // sendMessage leaves a complete row, so a re-delivery is correctly skipped on restart.
        // For the no-msgId path sentinelRowId is undefined — fall back to a fresh INSERT.
        if (sentinelRowId !== undefined) {
          getDb()
            .prepare(
              `UPDATE transcriptions
               SET from_jid=?, from_name=?, duration_s=?, language=?, input_tokens=?, output_tokens=?
               WHERE rowid=?`
            )
            .run(fromJid, pushName ?? null, result.duration ?? null, result.language ?? null,
                 result.inputTokens, result.outputTokens, sentinelRowId);
        } else {
          // No msgId path: no sentinel was written, insert a complete row now.
          const ins = getDb()
            .prepare(
              `INSERT INTO transcriptions
               (user_id, from_jid, from_name, duration_s, language, transcript, summary, content_deleted, input_tokens, output_tokens)
               VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`
            )
            .run(userId, fromJid, pushName ?? null, result.duration ?? null, result.language ?? null,
                 result.inputTokens, result.outputTokens);
          sentinelRowId = Number(ins.lastInsertRowid);
        }

        const sent = await sock.sendMessage(
          msg.key.remoteJid,
          { text: result.replyText },
          { quoted: msg, ...(ephemeralExpiration ? { ephemeralExpiration } : {}) }
        );
        sendSucceeded = true;
        // Keep the reply in memory so a retry receipt from the recipient can be
        // answered. Never persisted — see msg-cache.ts.
        rememberSentMessage(userId, sent?.key?.id, sent?.message, {
          replyText: result.replyText,
          chatJid: msg.key.remoteJid ?? undefined,
          fromJid,
        });

        // Include text in SSE for real-time display (in-memory only, never stored)
        emitToUser(userId, 'transcription', {
          id: sentinelRowId,
          transcript: result.transcript,
          summary: result.summary ?? null,
        });
        logger.info({ event: 'wa.transcription_saved', userId, language: result.language, durationS: result.duration });
        if (result.degraded.length > 0) {
          await notifyOps(
            `pipeline_degraded:${result.degraded.join(',')}`,
            'Pipeline degraded — transcript may be unclean',
            { steps: result.degraded.join(', '), lang: result.language }
          );
        }
      } catch (err) {
        // Remove from in-memory Set on failure so a same-session reconnect can retry.
        // The claim goes back too, otherwise a failure here would leave the chat
        // with no transcript and every other linked account locked out of retrying.
        if (msgId) processedMsgIds.delete(processedKey(userId, msgId));
        // Delete the sentinel if sendMessage never fired — pipeline failed or send itself failed.
        // Deleting allows same-session and post-restart retry.
        // If sendMessage already succeeded (sendSucceeded=true) but something downstream threw
        // (emitToUser, notifyOps), the transcript was delivered — keep the sentinel so a
        // re-delivery is correctly skipped rather than sending a duplicate.
        if (sentinelRowId !== undefined && !sendSucceeded) {
          getDb()
            .prepare('DELETE FROM transcriptions WHERE rowid = ?')
            .run(sentinelRowId);
        }
        releaseTranscript(msgId);
        // A PipelineError names the step that failed and wraps the underlying Groq
        // error, which carries the HTTP status. Both are needed: without them this
        // line said only "Error", which cannot tell a 429 (rate limit) from a 404
        // (model retired) from a 401 (bad key) — and every one of those presents
        // identically as a voice note that is silently never transcribed.
        // The error *message* stays out on purpose: it can echo request content,
        // and logs here are metadata-only.
        const cause = (err as any)?.cause;
        const step: string = (err as any)?.step ?? 'unknown';
        const status: number | null = cause?.status ?? (err as any)?.status ?? null;
        const errCode: string | null = cause?.code ?? (err as any)?.code ?? null;
        logger.error({
          event: 'wa.pipeline_error',
          userId,
          step,
          status,
          errName: (err as Error)?.name,
          errCode,
          errType: cause?.type ?? null,
        });
        await notifyOps(
          `pipeline_error:${step}`,
          'Transcription failed — no reply sent',
          { step, status: status ?? 'n/a', errCode: errCode ?? 'n/a' }
        );
      }
    }
  };
  // Tracked so a restart waits for the reply instead of killing it mid-pipeline (WAY-057).
  sock.ev.on('messages.upsert', upsert => trackInFlight(handleUpsert(upsert)));

  return sock;
}

export async function closeAllSessions(): Promise<void> {
  const userIds = [...sockets.keys()];
  await Promise.allSettled(
    userIds.map(async userId => {
      const sock = sockets.get(userId);
      if (!sock) return;
      sockets.delete(userId);
      try { await sock.end(undefined); } catch { /* ignore */ }
    })
  );
}

export function reconnectAllSessions(): void {
  const rows = getDb()
    .prepare('SELECT DISTINCT user_id FROM wa_sessions WHERE creds_json IS NOT NULL')
    .all() as { user_id: number }[];

  for (const { user_id } of rows) {
    initWhatsApp(user_id).catch(err =>
      logger.error({ event: 'wa.reconnect_failed', userId: user_id, errName: (err as Error)?.name })
    );
  }
}
