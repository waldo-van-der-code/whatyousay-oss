import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { deriveSubkey } from './crypto';
import { logger } from './logger';

// Transcription metadata retention (ME-065).
//
// Rows in `transcriptions` are kept in full for RETENTION_DAYS. After that the sender
// is pseudonymised: from_name becomes NULL and from_jid becomes ANON_PREFIX + an HMAC
// of the JID. Pseudonymised, not anonymised: whoever holds DB_ENCRYPTION_KEY can
// recover a number by hashing candidates. Duration, language, token counts and timestamps stay for usage stats, and
// the same JID always maps to the same hash, so per-sender counts still group.
// Account deletion still cascades the rows away entirely (ON DELETE CASCADE).
//
// The HMAC key is derived from DB_ENCRYPTION_KEY with its own HKDF context, so it is
// not the column-encryption key itself. Changing DB_ENCRYPTION_KEY changes every
// future hash: rows anonymised before and after a key change no longer group.

export const RETENTION_DAYS = 90;
export const ANON_PREFIX = 'anon:';
const HKDF_INFO = 'transcriptions.from_jid.anon.v1';

let hmacKey: Buffer | null = null;

/** Resets the cached HMAC key — for evals that switch DB_ENCRYPTION_KEY. */
export function __resetAnonKey(): void {
  hmacKey = null;
}

/**
 * The anonymised form of a sender JID. Idempotent: an already anonymised value is
 * returned unchanged. The device suffix (`4917…:12@s.whatsapp.net`) is dropped first,
 * so the same person sending from phone and desktop still groups as one sender.
 */
export function anonymizeJid(jid: string): string {
  if (jid.startsWith(ANON_PREFIX)) return jid;
  const at = jid.indexOf('@');
  const user = (at === -1 ? jid : jid.slice(0, at)).split(':')[0];
  const normalized = at === -1 ? user : `${user}${jid.slice(at)}`;
  hmacKey ??= deriveSubkey(HKDF_INFO);
  return ANON_PREFIX + crypto.createHmac('sha256', hmacKey).update(normalized, 'utf8').digest('hex').slice(0, 32);
}

/** SQLite's datetime('now') format (UTC, "YYYY-MM-DD HH:MM:SS"), so string comparison is chronological. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export interface RetentionResult {
  dryRun: boolean;
  /** Rows older than the cutoff that still carry a raw JID or a name. */
  candidates: number;
  /** Rows actually rewritten (0 on a dry run). */
  anonymized: number;
}

/**
 * Anonymises every transcription row older than `days`. `dryRun` only counts.
 * Never touches a row that is already anonymised and has no name.
 */
export function anonymizeOldTranscriptions(
  db: DatabaseSync,
  opts: { dryRun?: boolean; now?: number; days?: number } = {}
): RetentionResult {
  const dryRun = opts.dryRun ?? false;
  const cutoff = sqliteUtc((opts.now ?? Date.now()) - (opts.days ?? RETENTION_DAYS) * 86_400_000);
  const rows = db
    .prepare(
      `SELECT id, from_jid FROM transcriptions
       WHERE created_at < ? AND (substr(from_jid, 1, ${ANON_PREFIX.length}) <> '${ANON_PREFIX}' OR from_name IS NOT NULL)`
    )
    .all(cutoff) as { id: number; from_jid: string }[];

  let anonymized = 0;
  if (!dryRun && rows.length > 0) {
    const update = db.prepare('UPDATE transcriptions SET from_jid = ?, from_name = NULL WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) anonymized += Number(update.run(anonymizeJid(row.from_jid), row.id).changes);
      db.exec('COMMIT');
    } catch (err) {
      // SQLite may already have rolled back on its own (IOERR, FULL); keep the original error.
      try { db.exec('ROLLBACK'); } catch { /* no transaction left to roll back */ }
      throw err;
    }
    // Move the rewritten pages out of the WAL so the old values do not sit in WAL
    // frames until they happen to be overwritten (secure_delete covers the main file).
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return { dryRun, candidates: rows.length, anonymized };
}

/**
 * A short fingerprint of the HMAC key: compare the server's `retention.anonymized`
 * log line with the CLI output to confirm both hash with the same key.
 */
export function anonKeyId(): string {
  return anonymizeJid('whatyousay:key-id').slice(ANON_PREFIX.length, ANON_PREFIX.length + 8);
}

/** Runs the job and logs counts only — never JIDs, names or hashes. */
export function runRetention(db: DatabaseSync, opts: { dryRun?: boolean } = {}): RetentionResult {
  try {
    const r = anonymizeOldTranscriptions(db, opts);
    logger.info({
      event: 'retention.anonymized',
      count: r.dryRun ? r.candidates : r.anonymized,
      dryRun: r.dryRun,
      retentionDays: RETENTION_DAYS,
      keyId: anonKeyId(),
    });
    return r;
  } catch (err) {
    logger.error({ event: 'retention.failed', errName: (err as Error)?.name, errMsg: (err as Error)?.message });
    throw err;
  }
}

// ── Daily schedule ────────────────────────────────────────────────────────────

export const RUN_AT_BERLIN = { hour: 4, minute: 15 };

const berlinFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Berlin wall-clock date and time for an instant. */
export function berlinClock(ms: number): { date: string; hour: number; minute: number } {
  const p = Object.fromEntries(berlinFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/**
 * True when the daily run is due: Berlin wall clock reads 04:15 and it has not run
 * yet on that Berlin date. Exact-minute rather than "04:15 or later" on purpose, so a
 * deploy in the evening never triggers an unannounced run.
 */
export function shouldRunRetention(nowMs: number, lastRunDate: string | null): boolean {
  const now = berlinClock(nowMs);
  return now.hour === RUN_AT_BERLIN.hour && now.minute === RUN_AT_BERLIN.minute && lastRunDate !== now.date;
}

/**
 * Polls every 30 s, so the 04:15 minute is always seen. A wall-clock poll rather than
 * a computed timeout, so DST changes need no arithmetic (Berlin's switch is at
 * 02:00/03:00 and never skips or repeats 04:15). A process that is down (or stalled
 * for 30 s+) at 04:15 skips that day; the next day's run catches the rows up.
 */
export function scheduleDailyRetention(getDb: () => DatabaseSync): NodeJS.Timeout {
  let lastRunDate: string | null = null;
  const timer = setInterval(() => {
    const nowMs = Date.now();
    if (!shouldRunRetention(nowMs, lastRunDate)) return;
    lastRunDate = berlinClock(nowMs).date;
    try { runRetention(getDb()); } catch { /* logged in runRetention; retried tomorrow */ }
  }, 30_000);
  timer.unref();
  return timer;
}
