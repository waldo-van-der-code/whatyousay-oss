/**
 * "Except these people" / "Except these groups" — the dashboard's exclusion lists.
 *
 * The dashboard collects free text ("Type name or number" for contacts, a group
 * name for groups), so an entry has to be matched against whatever identity can
 * be assembled for the chat a voice message arrived in:
 *
 *   • Numbers match digits-to-digits, so "+49 151 2345" matches the JID
 *     "4915123456789@s.whatsapp.net" regardless of how either side is punctuated.
 *   • Names match as a case-insensitive substring, which is what the dashboard
 *     promises ("Partial name or number match").
 *
 * Names are the awkward half. WhatsApp attaches a display name (pushName) only to
 * messages *from* a contact, so a message we sent carries no name for the person
 * we sent it to — a name rule would work in one direction and not the other. The
 * caches below fix that by remembering every name WhatsApp does hand us, from
 * pushName on incoming messages and from Baileys' contacts/groups events, keyed
 * per user because each linked account has its own address book.
 *
 * They are in-memory and start empty on boot (the app runs as a single process). A number rule never depends on them, so a rule that has to hold
 * from a cold start should be written as a number.
 */

import { logger } from './logger';

// Bounded so a long-lived process cannot grow one entry per contact forever.
// Real address books sit far below this; the cap only guards against pathology.
const MAX_ENTRIES_PER_USER = 2000;

// userId → identifier → display name / subject
const contactNames = new Map<number, Map<string, string>>();
const groupSubjects = new Map<number, Map<string, string>>();

/** Strips a JID down to the bare number: "4915123456789:12@s.whatsapp.net" → "4915123456789". */
export function jidNumber(jid: string): string {
  // The ":12" device suffix has to go before non-digits are stripped, or its
  // digits merge into the number and nothing ever matches.
  return digits(jid.split('@')[0].split(':')[0]);
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function remember(
  store: Map<number, Map<string, string>>,
  userId: number,
  key: string | null | undefined,
  value: string | null | undefined
): void {
  if (!key || !value?.trim()) return;
  let forUser = store.get(userId);
  if (!forUser) {
    forUser = new Map();
    store.set(userId, forUser);
  }
  // Re-insert rather than overwrite so the Map's insertion order stays an
  // eviction order — the oldest key is then always the first one out.
  forUser.delete(key);
  forUser.set(key, value.trim());
  while (forUser.size > MAX_ENTRIES_PER_USER) {
    const oldest = forUser.keys().next();
    if (oldest.done) break;
    forUser.delete(oldest.value);
  }
}

export function rememberContactName(userId: number, jid: string | null | undefined, name: string | null | undefined): void {
  remember(contactNames, userId, jid ? jidNumber(jid) : null, name);
}

export function rememberGroupSubject(userId: number, jid: string | null | undefined, subject: string | null | undefined): void {
  remember(groupSubjects, userId, jid, subject);
}

export function getContactName(userId: number, jid: string | null | undefined): string | undefined {
  if (!jid) return undefined;
  return contactNames.get(userId)?.get(jidNumber(jid));
}

export function getGroupSubject(userId: number, jid: string | null | undefined): string | undefined {
  if (!jid) return undefined;
  return groupSubjects.get(userId)?.get(jid);
}

/** Called when a user unlinks, so their address book does not outlive the session. */
export function forgetUserIdentities(userId: number): void {
  contactNames.delete(userId);
  groupSubjects.delete(userId);
}

// A rule needs at least this many digits before it is read as a phone number, so
// that a name which merely contains a digit ("Anna 2", "Flat 3") does not match
// every JID that happens to contain it.
const MIN_NUMBER_DIGITS = 4;

/**
 * Returns the exclusion entry that matched, or undefined if none did.
 *
 * The entry is returned rather than a boolean so callers can tell *which* rule
 * fired when debugging. Do not log it: an exclusion entry is a contact's name or
 * number, and logs here stay metadata-only.
 */
export function findExclusion(
  entries: unknown,
  identity: { jid?: string | null; names?: (string | null | undefined)[] }
): string | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;

  const number = identity.jid ? jidNumber(identity.jid) : '';
  const names = (identity.names ?? [])
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map(name => name.trim().toLowerCase());

  for (const raw of entries) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim();
    if (!entry) continue;

    const entryDigits = digits(entry);
    if (entryDigits.length >= MIN_NUMBER_DIGITS && number.length > 0 && number.includes(entryDigits)) {
      return entry;
    }

    const needle = entry.toLowerCase();
    if (names.some(name => name.includes(needle))) return entry;
  }

  return undefined;
}

/**
 * Whether a 1-on-1 voice message is excluded. `remoteJid` is the other party in
 * both directions — for a message we sent it is the recipient, for one we
 * received it is the sender — so the same rule covers sent and received, which is
 * what the dashboard says it does.
 */
export function isContactExcluded(
  userId: number,
  entries: unknown,
  remoteJid: string,
  pushName?: string | null
): boolean {
  return (
    findExclusion(entries, {
      jid: remoteJid,
      names: [getContactName(userId, remoteJid), pushName],
    }) !== undefined
  );
}

/**
 * Whether a group voice message is excluded, matched on the group's subject as
 * the dashboard promises ("Partial match on group name").
 *
 * `fetchSubject` is only called when the list is non-empty and the subject is not
 * already cached, so an unused exclusion list never costs a round trip. If the
 * subject cannot be resolved the message is *not* excluded: silently dropping
 * every group transcript because a metadata fetch is flaky would be the worse
 * failure, so this logs instead and lets the message through.
 */
export async function isGroupExcluded(
  userId: number,
  entries: unknown,
  groupJid: string,
  fetchSubject: () => Promise<string | undefined>
): Promise<boolean> {
  if (!Array.isArray(entries) || entries.length === 0) return false;

  let subject = getGroupSubject(userId, groupJid);
  if (!subject) {
    try {
      subject = await fetchSubject();
      rememberGroupSubject(userId, groupJid, subject);
    } catch (err) {
      logger.warn({ event: 'wa.group_subject_failed', userId, errName: (err as Error)?.name });
    }
  }

  if (!subject) {
    logger.warn({ event: 'wa.group_exclusion_unresolved', userId });
    return false;
  }

  return findExclusion(entries, { names: [subject] }) !== undefined;
}
