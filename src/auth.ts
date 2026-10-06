import crypto from 'node:crypto';
import { getDb } from './db';

export const DEFAULT_SETTINGS = {
  transcribe_1on1_sent: true,
  // Received 1-on-1 voice messages are the reason this tool exists, so this
  // defaults on. It was flipped to false in 83b8e14 alongside unrelated pipeline
  // work, which silences every received voice note for any user whose stored
  // settings blob does not override it. evals/wa-retry.ts check S01 pins this
  // default so the next flip fails CI rather than the inbox.
  transcribe_1on1_received: true,
  transcribe_group_sent: false,
  transcribe_group_received: false,
  translate_to_english: true,
  translate_target_language: 'en',
  translate_language_override: false,
  summary_enabled: true,
  summary_min_words: 120,
  summary_custom_prompt: '',
  known_names: '',
  // "Except these people / groups" — free-text names or numbers from the
  // dashboard, read by src/exclusions.ts. Declared here so getUserSettings always
  // hands back arrays and Settings carries the fields.
  exclude_contacts: [] as string[],
  exclude_groups: [] as string[],
};

export type Settings = typeof DEFAULT_SETTINGS;

export function getOrCreateUser(email: string): number {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = db.prepare('INSERT INTO users (email) VALUES (?)').run(email);
  const userId = Number(result.lastInsertRowid);

  db.prepare('INSERT OR IGNORE INTO user_settings (user_id, settings_json) VALUES (?, ?)').run(
    userId,
    JSON.stringify(DEFAULT_SETTINGS)
  );

  return userId;
}

// ── Magic links (ME-065) ─────────────────────────────────────────────────────
// A login token carries the *email*, not a user id: the users row is created only
// when the link is confirmed, so POST /auth/login can no longer fill the users
// table with addresses nobody controls. Tokens and nonces are stored as SHA-256
// hashes, so a DB copy cannot be replayed into a login.

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const CROSS_DEVICE_TTL_MS = 10 * 60 * 1000;

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const isTokenFormat = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/**
 * `nonce` binds the link to the browser that asked for it (a cookie set by
 * POST /auth/login). null for cross-device links, which are opened elsewhere by design.
 */
export function createLoginToken(email: string, nonce: string | null, ttlMs = MAGIC_LINK_TTL_MS): string {
  const db = getDb();
  db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(new Date().toISOString());
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO login_tokens (token_hash, email, nonce_hash, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    email,
    nonce ? sha256(nonce) : null,
    expiresAt
  );
  return token;
}

/** Cross-device login link for an existing, logged-in user. */
export function createAuthLink(userId: number): string | null {
  const email = getUserEmail(userId);
  return email ? createLoginToken(email, null, CROSS_DEVICE_TTL_MS) : null;
}

/**
 * Reads a token without consuming it — GET /auth/verify only shows the confirm
 * page, so mail scanners that prefetch links cannot burn or use them.
 * `sameBrowser` is true when the nonce cookie matches the one the link was requested with.
 */
export function peekLoginToken(token: string, nonce: string | undefined): { email: string; sameBrowser: boolean } | null {
  if (!isTokenFormat(token)) return null;
  const row = getDb()
    .prepare('SELECT email, nonce_hash, expires_at FROM login_tokens WHERE token_hash = ?')
    .get(sha256(token)) as { email: string; nonce_hash: string | null; expires_at: string } | undefined;
  if (!row || new Date(row.expires_at) < new Date()) return null;
  const sameBrowser =
    !!row.nonce_hash && typeof nonce === 'string' && nonce.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(row.nonce_hash), Buffer.from(sha256(nonce)));
  return { email: row.email, sameBrowser };
}

/** Single use: deletes the token and returns the user id, creating the user on first login. */
export function consumeLoginToken(token: string): number | null {
  if (!isTokenFormat(token)) return null;
  const db = getDb();
  const hash = sha256(token);
  const row = db.prepare('SELECT email, expires_at FROM login_tokens WHERE token_hash = ?').get(hash) as
    | { email: string; expires_at: string }
    | undefined;
  if (!row) return null;
  const deleted = db.prepare('DELETE FROM login_tokens WHERE token_hash = ?').run(hash);
  if (Number(deleted.changes) !== 1) return null; // a concurrent confirm got there first
  if (new Date(row.expires_at) < new Date()) return null;
  return getOrCreateUser(row.email);
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
  return token;
}

export function verifySession(token: string): number | null {
  const db = getDb();
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token) as {
    user_id: number;
    expires_at: string;
  } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row.user_id;
}

export function deleteSession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function getUserEmail(userId: number): string | null {
  const row = getDb().prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  return row?.email ?? null;
}

// ── Settings (ME-065: allowlisted) ───────────────────────────────────────────
// POST /api/settings used to merge any JSON into the stored blob. Only these keys
// are stored or returned; each has a type and size limit. Unknown keys are dropped
// silently because the dashboard's Telegram toggles post back the whole GET
// response, which may still carry retired keys (whisper_include_sender_name).

type Validator = (v: unknown) => boolean;
const bool: Validator = v => typeof v === 'boolean';
const str = (max: number): Validator => v => typeof v === 'string' && v.length <= max;
const strList: Validator = v =>
  Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === 'string' && x.length <= 200);

const SETTINGS_SCHEMA: Record<string, Validator> = {
  transcribe_1on1_sent: bool,
  transcribe_1on1_received: bool,
  transcribe_group_sent: bool,
  transcribe_group_received: bool,
  translate_to_english: bool,
  translate_target_language: v => typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v),
  translate_language_override: bool,
  summary_enabled: bool,
  summary_min_words: v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100_000,
  summary_custom_prompt: str(2000),
  known_names: str(1000),
  whisper_context: str(200),
  exclude_contacts: strList,
  exclude_groups: strList,
  telegram_transcribe_sent: bool,
  telegram_transcribe_received: bool,
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA);

function pickAllowed(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

// Stored blobs predate the schema: a value that would now be refused (e.g. a null
// summary_min_words from a cleared number field) falls back to the default on read,
// so posting the GET response back — which the dashboard does — keeps working.
function pickValid(obj: Record<string, unknown>): Record<string, unknown> {
  const out = pickAllowed(obj);
  for (const key of Object.keys(out)) {
    if (!SETTINGS_SCHEMA[key](out[key])) delete out[key];
  }
  return out;
}

/** Validates a settings patch: unknown keys are dropped, a known key with a bad value fails the whole patch. */
export function sanitizeSettingsPatch(input: unknown): { ok: true; patch: Partial<Settings> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Expected a JSON object' };
  const patch = pickAllowed(input as Record<string, unknown>);
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTINGS_SCHEMA[key](value)) return { ok: false, error: `Invalid value for ${key}` };
  }
  return { ok: true, patch: patch as Partial<Settings> };
}

export function getUserSettings(userId: number): Settings {
  const row = getDb().prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(userId) as {
    settings_json: string;
  } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const stored = JSON.parse(row.settings_json);
    return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? pickValid(stored) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Callers must pass a patch from sanitizeSettingsPatch. */
export function saveUserSettings(userId: number, partial: Partial<Settings>): Settings {
  const current = getUserSettings(userId);
  const merged: Settings = { ...current, ...partial };
  getDb()
    .prepare('INSERT OR REPLACE INTO user_settings (user_id, settings_json) VALUES (?, ?)')
    .run(userId, JSON.stringify(merged));
  return merged;
}
