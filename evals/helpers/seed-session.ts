import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'whatyousay.db');

export const TEST_EMAIL = 'test-eval@whatyousay.local';

const DEFAULT_SETTINGS = {
  transcribe_1on1_sent: true,
  transcribe_1on1_received: true,
  transcribe_group_sent: false,
  transcribe_group_received: false,
  translate_to_english: true,
  translate_target_language: 'en',
  translate_language_override: false,
  summary_enabled: true,
  summary_min_words: 120,
  summary_custom_prompt: '',
};

export function seedSession(email = TEST_EMAIL): { token: string; userId: number } {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as
    | { id: number }
    | undefined;

  let userId: number;
  if (existing) {
    userId = existing.id;
  } else {
    const result = db.prepare('INSERT INTO users (email) VALUES (?)').run(email);
    userId = Number(result.lastInsertRowid);
    db.prepare(
      'INSERT OR IGNORE INTO user_settings (user_id, settings_json) VALUES (?, ?)'
    ).run(userId, JSON.stringify(DEFAULT_SETTINGS));
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(
    userId,
    token,
    expiresAt
  );

  db.close();
  return { token, userId };
}

export function cleanupTestUser(email = TEST_EMAIL): void {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare('DELETE FROM users WHERE email = ?').run(email);
  db.close();
}

export function seedTranscriptions(userId: number, count: number): void {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  const stmt = db.prepare(`
    INSERT INTO transcriptions (user_id, from_jid, from_name, duration_s, language, transcript, summary, content_deleted, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 100, 50)
  `);
  for (let i = 0; i < count; i++) {
    stmt.run(userId, `4917600000${String(i).padStart(3, '0')}@s.whatsapp.net`, `Test Contact ${i}`, 12.5, 'en', `Test transcript number ${i}`);
  }
  db.close();
}

export function userIdFor(email: string): number | null {
  const db = new DatabaseSync(DB_PATH);
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  db.close();
  return row?.id ?? null;
}

/** Insert a linked Telegram group the way /link stores it — title raw, as Telegram sent it. */
export function seedTelegramGroup(userId: number, chatId: string, chatTitle: string): void {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare('INSERT OR REPLACE INTO telegram_groups (chat_id, user_id, chat_title) VALUES (?, ?, ?)').run(
    chatId,
    userId,
    chatTitle
  );
  db.close();
}

/** Create a user row directly (bypasses /auth/login validation, as a pre-ME-065 row would). */
export function seedUser(email: string): number {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  const id = existing ? existing.id : Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
  db.close();
  return id;
}

export function deleteSession(token: string): void {
  const db = new DatabaseSync(DB_PATH);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  db.close();
}

/** Simulate the bot rotating a user's link code after a /link. */
export function setLinkCode(userId: number, code: string): void {
  const db = new DatabaseSync(DB_PATH);
  db.prepare('UPDATE telegram_tokens SET token = ? WHERE user_id = ?').run(code, userId);
  db.close();
}

/**
 * Mint a magic-link token the way POST /auth/login does (ME-065: tokens carry the
 * email and are stored hashed). Pass the browser's login_nonce to simulate the
 * browser that requested the link; omit it for "opened on another device".
 */
export function seedLoginToken(email: string, nonce?: string): string {
  const db = new DatabaseSync(DB_PATH);
  const token = crypto.randomBytes(32).toString('hex');
  const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
  db.prepare('INSERT INTO login_tokens (token_hash, email, nonce_hash, expires_at) VALUES (?, ?, ?, ?)').run(
    sha(token),
    email,
    nonce ? sha(nonce) : null,
    new Date(Date.now() + 15 * 60 * 1000).toISOString()
  );
  db.close();
  return token;
}
