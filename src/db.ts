import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'whatyousay.db');

let _db: DatabaseSync | null = null;

// Set to true only after the UNIQUE index on (user_id, wa_msg_id) is confirmed present.
// When false, the sentinel INSERT OR IGNORE has no constraint and doesn't prevent duplicates —
// the whatsapp.ts dedup path checks this flag and falls back to SELECT-then-insert.
export let uniqueMsgIdIndexActive = false;

export function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA foreign_keys = ON');
    // Overwrite freed cell bytes with zeros, so a value removed by UPDATE or DELETE
    // (retention anonymisation, account deletion) does not linger in free page space
    // and from there in every .backup copy (ME-065).
    _db.exec('PRAGMA secure_delete = ON');
    // Wait briefly for another process's write lock (a CLI run, an eval) instead of
    // failing at once with SQLITE_BUSY.
    _db.exec('PRAGMA busy_timeout = 5000');
    initSchema(_db);
  }
  return _db;
}

export function initSchema(db: DatabaseSync): void {
  // Privacy migration: drop old transcriptions table if it stored content (no content_deleted col)
  const cols = db.prepare("PRAGMA table_info(transcriptions)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some(c => c.name === 'content_deleted')) {
    db.exec('DROP TABLE IF EXISTS transcriptions');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- Magic-link tokens (ME-065). Carries the email, not a user id: the users row
    -- is created only when the link is confirmed. auth_tokens above is unused
    -- since then and kept only so old rows are not dropped without a decision.
    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      nonce_hash TEXT,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wa_sessions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      creds_json TEXT,
      keys_json TEXT
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_jid TEXT NOT NULL,
      from_name TEXT,
      duration_s REAL,
      language TEXT,
      transcript TEXT,
      summary TEXT,
      content_deleted INTEGER NOT NULL DEFAULT 1,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      wa_msg_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Additive migration: add wa_msg_id to existing installs (fresh installs get it via CREATE TABLE above).
  // Logs success/failure on startup so degraded dedup mode is visible in pm2 logs.
  // The CREATE INDEX is here rather than in the main exec block so that it only runs after
  // the column is guaranteed to exist — the main CREATE TABLE is a no-op for existing DBs.
  // Non-fatal: a migration failure falls back to the in-memory Set dedup for this session.
  try {
    const trCols = db.prepare("PRAGMA table_info(transcriptions)").all() as { name: string }[];
    if (!trCols.some(c => c.name === 'wa_msg_id')) {
      db.exec('ALTER TABLE transcriptions ADD COLUMN wa_msg_id TEXT');
    }
    // CREATE INDEX is idempotent (IF NOT EXISTS) and safe to run for both fresh and existing installs
    // once the column is confirmed to exist.
    db.exec('CREATE INDEX IF NOT EXISTS idx_transcriptions_wa_msg_id ON transcriptions(user_id, wa_msg_id)');
    // UNIQUE index (WAY-40): enables INSERT OR IGNORE as an atomic sentinel, so a restart between
    // sendMessage and the DB write cannot cause a duplicate transcript. WHERE clause excludes NULLs
    // (no-msgId messages can't be deduped anyway, and SQLite treats NULL != NULL for uniqueness).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transcriptions_wa_msg_id_unique
             ON transcriptions(user_id, wa_msg_id) WHERE wa_msg_id IS NOT NULL`);
    uniqueMsgIdIndexActive = true;
    console.log('[db] wa_msg_id dedup column ready — cross-restart duplicate guard active');
  } catch (err) {
    console.error('[db] wa_msg_id migration failed — cross-restart duplicate guard is in-memory only:', err);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_groups (
      chat_id    TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS telegram_tokens (
      user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token            TEXT NOT NULL UNIQUE,
      telegram_user_id INTEGER
    );
  `);

  // Additive migration: add telegram_user_id to existing installs
  try {
    const tgCols = db.prepare("PRAGMA table_info(telegram_tokens)").all() as { name: string }[];
    if (!tgCols.some(c => c.name === 'telegram_user_id')) {
      db.exec('ALTER TABLE telegram_tokens ADD COLUMN telegram_user_id INTEGER');
    }
  } catch { /* non-fatal */ }
}

export interface Transcription {
  id: number;
  user_id: number;
  from_jid: string;
  from_name: string | null;
  duration_s: number | null;
  language: string | null;
  transcript: string | null;
  summary: string | null;
  content_deleted: number;
  input_tokens: number;
  output_tokens: number;
  wa_msg_id: string | null;
  created_at: string;
}
