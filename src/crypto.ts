import crypto from 'node:crypto';

// At-rest encryption for secret DB columns (ME-065): wa_sessions.creds_json and
// keys_json hold the WhatsApp identity and Signal private keys of every linked
// account. A copy of whatyousay.db (backup, scp, stolen disk) used to be enough to
// impersonate those devices.
//
// Format: "enc:v1:" + base64(iv[12] | tag[16] | ciphertext), AES-256-GCM. The AAD
// names the row and column ("wa_sessions:<userId>:creds"), so a ciphertext copied
// into another user's row or the other column fails authentication instead of
// loading someone else's keys.
//
// Reads accept legacy plaintext (no prefix) so existing rows keep working; the next
// write re-saves them encrypted. Writes always encrypt.

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: { raw: string; key: Buffer } | null = null;

/**
 * The 32-byte key from DB_ENCRYPTION_KEY (64 hex chars). Outside production a
 * missing key falls back to one derived from SESSION_SECRET so local dev and the
 * evals run without extra setup; production refuses to start without a real key
 * (see assertEncryptionKey).
 */
function getKey(): Buffer {
  const raw = (process.env.DB_ENCRYPTION_KEY ?? '').trim();
  if (cachedKey && cachedKey.raw === raw) return cachedKey.key;
  let key: Buffer;
  if (raw) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error('DB_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    key = Buffer.from(raw, 'hex');
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DB_ENCRYPTION_KEY is not set');
    }
    key = Buffer.from(
      crypto.hkdfSync('sha256', process.env.SESSION_SECRET ?? 'dev-secret', 'whatyousay', 'db-encryption-dev', 32)
    );
  }
  cachedKey = { raw, key };
  return key;
}

/** Throws at startup when production has no usable key, before any session loads. */
export function assertEncryptionKey(): void {
  getKey();
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptColumn(plaintext: string, aad: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Decrypts an "enc:v1:" value; returns legacy plaintext unchanged. Throws on a wrong key or tampering. */
export function decryptColumn(value: string, aad: string): string {
  if (!isEncrypted(value)) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('encrypted value too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), buf.subarray(0, IV_LEN));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}

/**
 * A purpose-bound 32-byte key derived from DB_ENCRYPTION_KEY via HKDF. Each `info`
 * string yields an independent key, so e.g. the retention job's JID hashing never
 * reuses the column-encryption key itself (ME-065).
 */
export function deriveSubkey(info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', getKey(), 'whatyousay', info, 32));
}

export function waSessionAad(userId: number, column: 'creds' | 'keys'): string {
  return `wa_sessions:${userId}:${column}`;
}
