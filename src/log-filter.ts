// libsignal (pulled in by Baileys) prints Signal session state straight to the
// console from session_record.js — "Closing session:", "Opening session:",
// "Removing old closed session:", "Session already closed" — each with a full
// SessionEntry whose currentRatchet holds privKey and rootKey. That bypasses pino
// and lands in the pm2 logs. On 2026-10-04 one day's log held 740 such entries.
// Only "Closing session:" was filtered until ME-065.
//
// The filter drops any console call that carries Signal key material, by shape
// rather than by message text alone, so a new libsignal call site is covered too.

const SESSION_MESSAGES = /^(Closing session|Opening session|Removing old closed session|Session already closed|Session already open)\b/;
const SECRET_KEYS = new Set(['privKey', 'rootKey', 'chainKey', 'ephemeralKeyPair', 'currentRatchet', 'messageKeys']);
const MAX_DEPTH = 4;

function carriesKeyMaterial(value: unknown, depth: number, seen: Set<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if ((value as object).constructor?.name === 'SessionEntry') return true;
  if (depth >= MAX_DEPTH || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return false;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return false;
  }
  for (const key of keys) {
    if (SECRET_KEYS.has(key)) return true;
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (carriesKeyMaterial(child, depth + 1, seen)) return true;
  }
  return false;
}

/** True when a console call's arguments must not reach the logs. */
export function isSensitiveLogCall(args: unknown[]): boolean {
  if (typeof args[0] === 'string' && SESSION_MESSAGES.test(args[0])) return true;
  const seen = new Set<object>();
  return args.some(a => carriesKeyMaterial(a, 0, seen));
}

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
let installed = false;

/** Wraps the console methods once. Call before anything can log Signal state. */
export function installConsoleFilter(): void {
  if (installed) return;
  installed = true;
  for (const method of METHODS) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (isSensitiveLogCall(args)) return;
      original(...args);
    };
  }
}

/**
 * What the process-level crash handlers may print: the stack (and a Boom status),
 * never the error object. Baileys errors carry the offending stanza in `data`,
 * with JIDs and display names, and console.error(err) would print all of it
 * (ME-065). Runs of 9+ digits (phone numbers, JIDs) are masked too.
 */
export function describeCrash(e: unknown): string {
  const scrub = (s: string) => s.replace(/\d{9,}/g, '#');
  if (typeof e === 'string') return scrub(e).slice(0, 300);
  if (e === null || typeof e !== 'object') return `non-Error ${typeof e}`;
  const o = e as any;
  const status = o.output?.statusCode ?? o.status;
  const head = status ? `[status ${status}] ` : '';
  // Duck-typed so errors from another realm still print their stack.
  if (typeof o.stack === 'string' || typeof o.message === 'string') {
    return scrub(head + (typeof o.stack === 'string' ? o.stack : `${o.name ?? 'Error'}: ${o.message}`));
  }
  // A plain object: its type and error code only, never its contents.
  return scrub(`${head}non-Error ${o.constructor?.name ?? 'object'}${o.code ? ` code=${String(o.code).slice(0, 40)}` : ''}`);
}
