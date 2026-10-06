// WHATWG's "valid e-mail address" (what <input type=email> accepts) plus a dotted
// domain and the RFC 5321 length limit. It still admits ' and `, so anything that
// renders an address must escape it for its context (ME-065).
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

/** For logs: keeps the domain and the first character of the local part ("j***@example.com"). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Who may sign in. ALLOWED_EMAILS is a comma-separated list, or "*" for open signup;
 * ADMIN_EMAIL is always allowed. Unset means closed in production (a stranger could
 * otherwise link their own WhatsApp and spend the host's Groq quota) and open in dev.
 */
export function isEmailAllowed(email: string): boolean {
  const raw = (process.env.ALLOWED_EMAILS ?? '').trim();
  if (raw === '*') return true;
  if (!raw && process.env.NODE_ENV !== 'production') return true;
  const allowed = raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const admin = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (admin) allowed.push(admin);
  return allowed.includes(email.trim().toLowerCase());
}
