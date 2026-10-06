#!/usr/bin/env -S npx tsx
/**
 * WhatYouSay — WhatsApp retry-receipt evals
 * Run: npx tsx evals/wa-retry.ts
 *
 * Needs no running server, no WhatsApp pairing and no Groq key. Baileys and the
 * pipeline are stubbed, and everything runs in-process against a throwaway
 * SQLite file, so unlike smoke.ts this is safe to run while the server is up.
 *
 * Regression guard for the bug where a transcript reply sat on the recipient's
 * phone as "Waiting for this message. This may take a while." forever. A device
 * that cannot decrypt a message asks the sender to re-encrypt and re-send it.
 * Baileys answers that retry receipt through the `getMessage` socket option;
 * with the library default in place it finds nothing and sends nothing, so the
 * placeholder never resolves even though the sender's phone shows two ticks.
 *
 * The checks below assert the whole contract: getMessage is wired into the
 * socket, a reply that was just sent can be recovered through it, and the cache
 * behind it stays scoped per user and bounded in size.
 *
 * It has since grown to cover the rest of the voice-message intake path, since
 * that path has no other automated coverage: cross-restart dedup (D), the
 * settings defaults every received message depends on (S), and the message
 * envelopes WhatsApp wraps voice notes in (E).
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';

// Throwaway DB, set before anything pulls in src/db, which reads DB_PATH at
// module load. Keeps this eval clear of the live database.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wys-retry-'));
process.env.DB_PATH = path.join(TMP_DIR, 'eval.db');

const USER_ID = 1;
const CONTACT_JID = '4915100000000@s.whatsapp.net';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(id: string, desc: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${id} ${desc}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${id} ${desc}`);
    console.error(`      ${msg}`);
    failed++;
    failures.push(`${id}: ${msg}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── Stub Baileys before src/whatsapp.ts pulls it in ──────────────────────────

let socketConfig: any = null;
let socketEvents: EventEmitter | null = null;
const sentMessages: { jid: string; text: string; options?: any; from: number }[] = [];

// Every fake socket this run created, in creation order: index 0 is USER_ID's,
// index 1 is the second linked account's. Both ends of a chat being linked to the
// same server is the case the M checks below exercise.
const fakeSockets: { ev: EventEmitter; user: { id: string; name: string }; config: any }[] = [];

// Subject returned by groupMetadata, keyed by group JID.
const groupSubjects: Record<string, string> = {};
let replyCounter = 0;

function makeFakeSocket(config: any) {
  const ev = new EventEmitter();
  const index = fakeSockets.length;
  // Distinct number per account, so the server can tell one linked account from
  // another. Index 0 keeps the original id the earlier checks were written against.
  const user = { id: `3160000000${index}:1@s.whatsapp.net`, name: `Account ${index}` };
  fakeSockets.push({ ev, user, config });
  if (index === 0) {
    socketConfig = config;
    socketEvents = ev;
  }
  return {
    ev,
    user,
    logout: async () => {},
    profilePictureUrl: async () => null,
    updateMediaMessage: async () => undefined,
    groupMetadata: async (jid: string) => ({
      id: jid,
      subject: groupSubjects[jid] ?? 'Unnamed group',
      participants: [],
    }),
    sendMessage: async (jid: string, content: { text: string }, options?: any) => {
      sentMessages.push({ jid, text: content.text, options, from: index });
      // Baileys hands back the message it put on the wire. That object is what
      // has to survive in order to answer a retry receipt later.
      return {
        key: { id: `REPLY_${++replyCounter}`, remoteJid: jid, fromMe: true },
        message: { extendedTextMessage: { text: content.text } },
      };
    },
  };
}

const BAILEYS = require.resolve('@whiskeysockets/baileys');
const realBaileys = require('@whiskeysockets/baileys');
require.cache[BAILEYS] = {
  id: BAILEYS,
  filename: BAILEYS,
  loaded: true,
  exports: {
    ...realBaileys,
    // __esModule is defined non-enumerably upstream, so the spread above drops
    // it. Without it the ESM interop helper wraps this object again and the
    // default import stops being callable.
    __esModule: true,
    default: makeFakeSocket,
    makeWASocket: makeFakeSocket,
    downloadMediaMessage: async () => Buffer.from('fake-ogg-bytes'),
  },
} as any;

// ── Stub the Groq pipeline so no API key or audio file is needed ─────────────

const REPLY_BODY = '🎤 *Transcript*\n\nThis is a voicemail.';
// While set, every pipeline run waits on it: a note held mid-transcription (G checks).
let pipelineGate: Promise<void> | null = null;
const PIPELINE = require.resolve('../src/pipeline');
require.cache[PIPELINE] = {
  id: PIPELINE,
  filename: PIPELINE,
  loaded: true,
  exports: {
    __esModule: true,
    runPipeline: async () => (await pipelineGate, {
      transcript: 'This is a voicemail.',
      language: 'en',
      duration: 3,
      summary: undefined,
      replyText: REPLY_BODY,
      inputTokens: 10,
      outputTokens: 5,
    }),
    PipelineError: class PipelineError extends Error {},
  },
} as any;

// require, not import, so the stubs above are already installed.
const { getDb } = require('../src/db');
const { initWhatsApp } = require('../src/whatsapp');
const { rememberSentMessage, recallSentMessage, forgetUserMessages } = require('../src/msg-cache');

function incomingVoiceMessage(id: string) {
  return {
    key: { id, remoteJid: CONTACT_JID, fromMe: false },
    pushName: 'Test Contact',
    message: { audioMessage: { seconds: 3, ptt: true } },
  };
}

// Tolerates a missing getMessage so that R01 failing does not abort the run
// before the later checks have reported.
async function callGetMessage(id: string): Promise<any> {
  if (typeof socketConfig?.getMessage !== 'function') return undefined;
  return socketConfig.getMessage({ id, remoteJid: CONTACT_JID });
}

// Like waitFor but gives up quietly, leaving the assertion to check() so one
// failing envelope check does not abort the rest of the run.
async function settle(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
}

async function waitFor(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  console.log('WhatYouSay — WhatsApp retry-receipt evals\n');

  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)')
    .run(USER_ID, 'retry-eval@example.com');

  await initWhatsApp(USER_ID);

  console.log('S — Settings defaults');

  check('S01', 'received 1-on-1 voice messages are transcribed by default', () => {
    const { DEFAULT_SETTINGS } = require('../src/auth');
    assert(
      DEFAULT_SETTINGS.transcribe_1on1_received === true,
      'transcribe_1on1_received defaults to false, so any user who has never saved ' +
        'their settings gets silence for every voice note they receive. This is not ' +
        'only a bad default: every check below sends a received message and reads ' +
        'this default, so flipping it turns this whole suite into timeouts.'
    );
  });

  console.log('\nR — Socket wiring');

  check('R01', 'makeWASocket is given a getMessage handler', () => {
    assert(socketConfig, 'the socket was never constructed');
    assert(
      typeof socketConfig.getMessage === 'function',
      'no getMessage in the socket config: retry receipts cannot be answered, ' +
        'so the recipient stays on "Waiting for this message" forever'
    );
  });

  check('R01b', 'the socket never asks the phone to re-send undecryptable messages', () => {
    const cache = socketConfig?.placeholderResendCache;
    assert(
      cache && typeof cache.get === 'function',
      'no placeholderResendCache in the socket config: Baileys will send the phone a ' +
        'PLACEHOLDER_MESSAGE_RESEND request for every message it cannot decrypt, and the ' +
        'phone shows "Finished syncing with WhatsApp on Safari (WhatYouSay)" for each one'
    );
    cache.set('SOME_ID', undefined);
    cache.del('SOME_ID');
    assert(
      cache.get('SOME_ID'),
      'placeholderResendCache.get must always report "already requested" so Baileys ' +
        'skips requestPlaceholderResend'
    );
  });

  console.log('\nR — A sent reply survives long enough to be re-sent');

  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('VOICE_1')],
  });
  await waitFor(() => sentMessages.length >= 1, 'the transcript reply to be sent');

  check('R02', 'an incoming voice message produces one transcript reply', () => {
    assert(sentMessages.length === 1, `expected 1 reply, got ${sentMessages.length}`);
    assert(sentMessages[0].jid === CONTACT_JID, `replied to ${sentMessages[0].jid}`);
    assert(
      sentMessages[0].text.includes('This is a voicemail.'),
      `unexpected reply body: ${sentMessages[0].text}`
    );
  });

  const recovered = await callGetMessage('REPLY_1');
  check('R03', 'getMessage returns the reply that was just sent', () => {
    assert(
      recovered,
      'getMessage returned nothing. This is the exact failure: Baileys logs ' +
        '"recv retry request, but message not available" and sends no retry, ' +
        'leaving the recipient on "Waiting for this message"'
    );
    assert(
      recovered.extendedTextMessage?.text === REPLY_BODY,
      'getMessage returned a different message than the one that was sent'
    );
  });

  const unknown = await callGetMessage('NEVER_SENT');
  check('R04', 'getMessage returns undefined for an unknown id instead of throwing', () => {
    assert(unknown === undefined, 'expected undefined for an id that was never sent');
  });

  console.log('\nR — Cache behaviour');

  check('R05', 'cached replies are scoped per user', () => {
    rememberSentMessage(99, 'SHARED_ID', { conversation: 'other user' });
    assert(
      recallSentMessage(USER_ID, 'SHARED_ID') === undefined,
      "one user could read another user's cached reply"
    );
    assert(recallSentMessage(99, 'SHARED_ID'), 'the owning user lost their own entry');
  });

  check('R06', 'the cache stays bounded so a long-lived process cannot grow forever', () => {
    for (let i = 0; i < 600; i++) {
      rememberSentMessage(42, `BULK_${i}`, { conversation: `m${i}` });
    }
    assert(
      recallSentMessage(42, 'BULK_0') === undefined,
      'the oldest entry was not evicted once the cap was passed'
    );
    assert(recallSentMessage(42, 'BULK_599'), 'the newest entry was evicted');
  });

  check('R07', 'unlinking a user clears their cached replies', () => {
    rememberSentMessage(7, 'GONE', { conversation: 'bye' });
    forgetUserMessages(7);
    assert(recallSentMessage(7, 'GONE') === undefined, 'replies survived an unlink');
  });

  console.log('\nD — Cross-restart duplicate guard');

  // D01: same msgId in the same session → in-memory Set blocks the second pipeline run
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('DUPE_VOICE_1')],
  });
  await waitFor(() => sentMessages.length >= 2, 'first DUPE_VOICE_1 reply');
  const sentBeforeD01 = sentMessages.length;
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('DUPE_VOICE_1')],
  });
  await new Promise(r => setTimeout(r, 300));

  check('D01', 'same msgId in same session → no duplicate reply (in-memory dedup)', () => {
    assert(
      sentMessages.length === sentBeforeD01,
      `expected no new reply, got ${sentMessages.length - sentBeforeD01} extra — in-memory dedup broken`
    );
  });

  // D02: simulate a message processed in a previous session (DB row exists, processedMsgIds cleared)
  // Insert a record as if it was already processed before the last restart.
  const PREV_SESSION_MSG = 'PREV_SESSION_VOICE_ABC';
  getDb()
    .prepare(
      `INSERT INTO transcriptions
       (user_id, from_jid, duration_s, language, content_deleted, input_tokens, output_tokens, wa_msg_id)
       VALUES (?, ?, 3, 'en', 1, 0, 0, ?)`
    )
    .run(USER_ID, CONTACT_JID, PREV_SESSION_MSG);

  const sentBeforeD02 = sentMessages.length;
  // Capture wa.duplicate_skipped log event
  let duplicateSkippedFired = false;
  const { logger } = require('../src/logger');
  const origInfo = logger.info.bind(logger);
  (logger as any).info = (obj: any, ...args: any[]) => {
    if (obj?.event === 'wa.duplicate_skipped') duplicateSkippedFired = true;
    origInfo(obj, ...args);
  };

  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage(PREV_SESSION_MSG)],
  });
  await new Promise(r => setTimeout(r, 300));
  (logger as any).info = origInfo;

  check('D02', 'wa_msg_id in DB → no duplicate reply and wa.duplicate_skipped logged (cross-restart dedup)', () => {
    assert(
      sentMessages.length === sentBeforeD02,
      `expected no new reply after restart re-delivery, got ${sentMessages.length - sentBeforeD02} extra — DB dedup broken`
    );
    assert(duplicateSkippedFired, 'wa.duplicate_skipped event was not logged — dedup fired for wrong reason or not at all');
    const rows = getDb()
      .prepare('SELECT COUNT(*) as count FROM transcriptions WHERE wa_msg_id = ?')
      .get(PREV_SESSION_MSG) as { count: number };
    assert(rows.count === 1, `expected exactly 1 DB row for this msgId, got ${rows.count}`);
  });

  // D03: pipeline failure → msgId removed from processedMsgIds → same-session retry allowed
  // Simulates: download or Groq fails on first delivery (e.g., connection drop), Baileys
  // re-delivers on reconnect. Without the delete(msgId) in the catch block, the second
  // delivery would be silently blocked by the in-memory Set even though no transcript exists.
  //
  // IMPORTANT: must mutate runPipeline in-place on the existing exports object — whatsapp.ts
  // holds a reference to that object and will not see a whole-object replacement.
  const PIPELINE_MODULE = require.resolve('../src/pipeline');
  const origRunPipeline = require.cache[PIPELINE_MODULE]!.exports.runPipeline;
  let pipelineD03Calls = 0;
  require.cache[PIPELINE_MODULE]!.exports.runPipeline = async () => {
    pipelineD03Calls++;
    if (pipelineD03Calls === 1) throw new Error('Simulated Groq timeout');
    return {
      transcript: 'Retry succeeded.',
      language: 'en',
      duration: 3,
      summary: undefined,
      replyText: REPLY_BODY,
      inputTokens: 10,
      outputTokens: 5,
    };
  };

  const sentBeforeD03 = sentMessages.length;
  // First delivery — pipeline fails
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('RETRY_VOICE_1')],
  });
  await new Promise(r => setTimeout(r, 300)); // allow failure to propagate

  // Second delivery — simulates Baileys re-delivery after reconnect
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('RETRY_VOICE_1')],
  });
  await waitFor(() => sentMessages.length > sentBeforeD03, 'retry reply after pipeline failure', 3000);

  // Restore original pipeline stub
  require.cache[PIPELINE_MODULE]!.exports.runPipeline = origRunPipeline;

  check('D03', 'pipeline failure → same-session retry succeeds (msgId removed from Set on error)', () => {
    assert(pipelineD03Calls === 2, `expected 2 pipeline calls, got ${pipelineD03Calls}`);
    assert(
      sentMessages.length === sentBeforeD03 + 1,
      `expected exactly 1 reply from the retry, got ${sentMessages.length - sentBeforeD03}`
    );
  });

  console.log('\nE — Wrapped message envelopes');

  // Regression guard for voice notes that were never transcribed at all.
  // WhatsApp does not always put audioMessage at the top of msg.message: a chat
  // with disappearing messages switched on wraps every message in an
  // ephemeralMessage, a play-once voice note arrives inside viewOnceMessageV2,
  // and an edited message inside editedMessage. Reading msg.message.audioMessage
  // directly saw through none of those, so a contact who keeps disappearing
  // messages on had every single voice note dropped in silence — no reply, no
  // log line, no row. normalizeMessageContent is what unwraps them.

  // 7 days — WhatsApp's default disappearing-messages timer.
  const EPHEMERAL_TTL = 7 * 24 * 60 * 60;

  function wrappedVoiceMessage(id: string, wrap: (audio: any) => any) {
    return {
      key: { id, remoteJid: CONTACT_JID, fromMe: false },
      pushName: 'Test Contact',
      message: wrap({ seconds: 3, ptt: true }),
    };
  }

  const sentBeforeE01 = sentMessages.length;
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [
      wrappedVoiceMessage('EPHEMERAL_VOICE_1', audio => ({
        ephemeralMessage: {
          message: { audioMessage: { ...audio, contextInfo: { expiration: EPHEMERAL_TTL } } },
        },
      })),
    ],
  });
  await settle(() => sentMessages.length > sentBeforeE01);

  check('E01', 'a voice note in a disappearing-messages chat is transcribed', () => {
    assert(
      sentMessages.length === sentBeforeE01 + 1,
      'no reply was sent for a voice note wrapped in ephemeralMessage. Every voice ' +
        'note from a contact who has disappearing messages switched on is dropped ' +
        'in silence — the transcription never happens and nothing is logged'
    );
  });

  check('E02', "the reply inherits the chat's disappearing-message timer", () => {
    const reply = sentMessages[sentMessages.length - 1];
    assert(
      reply?.options?.ephemeralExpiration === EPHEMERAL_TTL,
      `reply was sent with ephemeralExpiration=${reply?.options?.ephemeralExpiration}, ` +
        `expected ${EPHEMERAL_TTL}: a permanent transcript dropped into a disappearing ` +
        'chat outlives the voice note it transcribes'
    );
  });

  const sentBeforeE03 = sentMessages.length;
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [
      wrappedVoiceMessage('VIEWONCE_VOICE_1', audio => ({
        viewOnceMessageV2: { message: { audioMessage: audio } },
      })),
    ],
  });
  await settle(() => sentMessages.length > sentBeforeE03);

  check('E03', 'a play-once voice note is transcribed', () => {
    assert(
      sentMessages.length === sentBeforeE03 + 1,
      'no reply was sent for a voice note wrapped in viewOnceMessageV2'
    );
  });

  check('E04', 'a non-ephemeral voice note still sends a plain reply', () => {
    // sentMessages[0] is the R02 reply to an unwrapped audioMessage. Unwrapping
    // must not start stamping a TTL on replies in ordinary chats.
    assert(
      sentMessages[0]?.options?.ephemeralExpiration === undefined,
      'a reply in a chat with no disappearing-message timer was given one anyway'
    );
  });

  const sentBeforeE05 = sentMessages.length;
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { id: 'TEXT_1', remoteJid: CONTACT_JID, fromMe: false }, message: { conversation: 'hello' } },
      // A message that failed to decrypt: no content, CIPHERTEXT stub.
      {
        key: { id: 'UNDECRYPTABLE_1', remoteJid: CONTACT_JID, fromMe: false },
        message: null,
        messageStubType: realBaileys.proto.WebMessageInfo.StubType.CIPHERTEXT,
      },
    ],
  });
  await new Promise(r => setTimeout(r, 300));

  check('E05', 'text and undecryptable messages are ignored without replying', () => {
    assert(
      sentMessages.length === sentBeforeE05,
      `expected no reply, got ${sentMessages.length - sentBeforeE05} — unwrapping ` +
        'widened the net beyond voice messages'
    );
  });

  console.log('\nK — Signal key store survives undecryptable messages');

  // Regression WAY-056: an "auto-heal" wiped keys_json whenever a few messages
  // failed to decrypt. That deleted the private halves of one-time prekeys the
  // WhatsApp server was still handing to senders, so every new session failed and
  // re-triggered the wipe. Transcription stopped for every user it fired for.
  await socketConfig.auth.keys.set({
    'pre-key': { '42': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } },
  });
  const storm = [];
  for (let i = 0; i < 9; i++) {
    storm.push({
      key: { id: `STORM_${i}`, remoteJid: `49151000000${i % 3}@s.whatsapp.net`, fromMe: false },
      message: null,
      messageStubType: realBaileys.proto.WebMessageInfo.StubType.CIPHERTEXT,
      messageStubParameters: ['Bad MAC'],
    });
  }
  socketEvents!.emit('messages.upsert', { type: 'notify', messages: storm });
  await new Promise(r => setTimeout(r, 300));

  check('K01', 'an undecryptable storm never deletes stored prekeys', () => {
    const row = getDb()
      .prepare('SELECT keys_json FROM wa_sessions WHERE user_id = ?')
      .get(USER_ID) as { keys_json: string } | undefined;
    assert(row, 'no wa_sessions row: the key store never persisted');
    const { decryptColumn, waSessionAad } = require('../src/crypto');
    assert(
      decryptColumn(row.keys_json, waSessionAad(USER_ID, 'keys')).includes('"pre-key-42"'),
      'pre-key-42 was deleted after undecryptable messages: senders holding that ' +
        'prekey can no longer start a session with this device'
    );
  });

  console.log('\nM — Both ends of a chat linked to this server');

  // Regression guard for the bug where a voice note between two WhatYouSay users
  // was transcribed for neither of them. WhatsApp gives a message the same id for
  // every account that receives it, so both sockets saw the same id. The dedup
  // cache was keyed on that id alone and was written *before* the settings were
  // consulted, so whichever socket got there first marked the message handled for
  // everybody — including when its own settings then went on to skip it. Every
  // other chat kept working, which is what made it look like two specific people
  // were broken.

  const { saveUserSettings } = require('../src/auth');
  const USER_2 = 2;
  const GROUP_JID = '120363000000000000@g.us';
  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER_2, 'second-account@example.com');
  await initWhatsApp(USER_2);

  // Both accounts have to report themselves connected before either can recognise
  // the other as a linked account.
  for (const s of fakeSockets) s.ev.emit('connection.update', { connection: 'open' });
  await new Promise(r => setTimeout(r, 100));
  const USER_2_JID = `${fakeSockets[1].user.id.split(':')[0]}@s.whatsapp.net`;

  function groupVoiceMessage(id: string, opts: { fromMe: boolean; participant?: string }) {
    return {
      key: { id, remoteJid: GROUP_JID, fromMe: opts.fromMe, participant: opts.participant },
      pushName: 'Group Sender',
      message: { audioMessage: { seconds: 3, ptt: true } },
    };
  }

  // The reported case: the second account transcribes the voice notes it sends in
  // groups, the first account does not transcribe the ones it receives there.
  saveUserSettings(USER_ID, { transcribe_group_received: false });
  saveUserSettings(USER_2, { transcribe_group_sent: true });

  const sentBeforeM01 = sentMessages.length;
  // The account that will NOT transcribe it sees it first — the ordering that
  // used to mark the message handled for everybody.
  fakeSockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [groupVoiceMessage('GROUP_VOICE_1', { fromMe: false, participant: USER_2_JID })],
  });
  await new Promise(r => setTimeout(r, 200));
  fakeSockets[1].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [groupVoiceMessage('GROUP_VOICE_1', { fromMe: true })],
  });
  await settle(() => sentMessages.length > sentBeforeM01);

  check('M01', "a recipient's disabled setting does not cancel the sender's transcript", () => {
    assert(
      sentMessages.length === sentBeforeM01 + 1,
      'the sending account produced no transcript for its own group voice note. A ' +
        'recipient whose settings skip the message reached the dedup cache first ' +
        'and marked it handled for every account, so nobody transcribed it'
    );
    assert(
      sentMessages[sentMessages.length - 1].from === 1,
      'the transcript came from the wrong account'
    );
  });

  // Sender's rules come first: when both accounts want it, the sender's wins and
  // the chat gets one transcript rather than the same text twice.
  saveUserSettings(USER_ID, { transcribe_group_received: true });
  saveUserSettings(USER_2, { transcribe_group_sent: true });

  const sentBeforeM02 = sentMessages.length;
  fakeSockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [groupVoiceMessage('GROUP_VOICE_2', { fromMe: false, participant: USER_2_JID })],
  });
  await new Promise(r => setTimeout(r, 200));
  fakeSockets[1].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [groupVoiceMessage('GROUP_VOICE_2', { fromMe: true })],
  });
  await settle(() => sentMessages.length > sentBeforeM02);
  await new Promise(r => setTimeout(r, 200));

  check('M02', "when both accounts want it, the sender's rules own the transcript", () => {
    assert(
      sentMessages.length === sentBeforeM02 + 1,
      `${sentMessages.length - sentBeforeM02} transcripts were posted for one voice ` +
        'note — both linked accounts replied into the same chat with the same text'
    );
    assert(
      sentMessages[sentMessages.length - 1].from === 1,
      'the recipient transcribed it even though the sender was going to. The ' +
        'recipient saw the message first, so deferring cannot depend on ordering'
    );
  });

  // ...and when the sender's rules decline, the recipient's rules apply, so a
  // voice note is never lost just because its sender wants no copy of their own.
  saveUserSettings(USER_2, { transcribe_group_sent: false });

  const sentBeforeM03 = sentMessages.length;
  fakeSockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [groupVoiceMessage('GROUP_VOICE_3', { fromMe: false, participant: USER_2_JID })],
  });
  await new Promise(r => setTimeout(r, 200));
  fakeSockets[1].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [groupVoiceMessage('GROUP_VOICE_3', { fromMe: true })],
  });
  await settle(() => sentMessages.length > sentBeforeM03);

  check('M03', "a sender who wants no transcript falls back to the recipient's rules", () => {
    assert(
      sentMessages.length === sentBeforeM03 + 1,
      'nobody transcribed a voice note the recipient asked for, because the ' +
        'recipient deferred to a sender who was never going to transcribe it'
    );
    assert(
      sentMessages[sentMessages.length - 1].from === 0,
      'the transcript came from the wrong account'
    );
  });

  console.log('\nX — Exclusion lists');

  // "Except these people" / "Except these groups" are collected by the dashboard
  // and were read by nothing at all, so both lists silently did nothing.
  saveUserSettings(USER_ID, { transcribe_1on1_received: true, transcribe_group_received: true });

  const sentBeforeX01 = sentMessages.length;
  saveUserSettings(USER_ID, { exclude_contacts: ['test contact'] });
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('EXCLUDED_BY_NAME')],
  });
  await new Promise(r => setTimeout(r, 300));

  check('X01', 'a voice note from an excluded contact name is not transcribed', () => {
    assert(
      sentMessages.length === sentBeforeX01,
      'the exclusion list was ignored — "Except these people" has no effect'
    );
  });

  const sentBeforeX02 = sentMessages.length;
  // Partial, human-punctuated number against the bare digits of the JID.
  saveUserSettings(USER_ID, { exclude_contacts: ['+49 151 0000'] });
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('EXCLUDED_BY_NUMBER')],
  });
  await new Promise(r => setTimeout(r, 300));

  check('X02', 'a partial phone number excludes regardless of punctuation', () => {
    assert(
      sentMessages.length === sentBeforeX02,
      `"+49 151 0000" did not match ${CONTACT_JID} — numbers must be compared digits to digits`
    );
  });

  const sentBeforeX03 = sentMessages.length;
  saveUserSettings(USER_ID, { exclude_contacts: ['someone else entirely'] });
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [incomingVoiceMessage('NOT_EXCLUDED')],
  });
  await settle(() => sentMessages.length > sentBeforeX03);

  check('X03', 'a contact who matches no rule is still transcribed', () => {
    assert(
      sentMessages.length === sentBeforeX03 + 1,
      'an exclusion list suppressed a contact that none of its entries matched'
    );
  });

  const sentBeforeX04 = sentMessages.length;
  const EXCLUDED_GROUP = '120363000000000001@g.us';
  groupSubjects[EXCLUDED_GROUP] = 'Family Chat';
  saveUserSettings(USER_ID, { exclude_contacts: [], exclude_groups: ['family'] });
  socketEvents!.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { id: 'EXCLUDED_GROUP_VOICE', remoteJid: EXCLUDED_GROUP, fromMe: false, participant: '4915199999999@s.whatsapp.net' },
        pushName: 'Someone',
        message: { audioMessage: { seconds: 3, ptt: true } },
      },
    ],
  });
  await new Promise(r => setTimeout(r, 400));

  check('X04', 'a voice note in an excluded group is not transcribed', () => {
    assert(
      sentMessages.length === sentBeforeX04,
      'the group exclusion list was ignored — "Except these groups" has no effect'
    );
  });

  console.log('\nN — wa_sessions encrypted at rest (ME-065)');

  // Regression ME-065: creds_json and keys_json (WhatsApp identity + Signal private
  // keys) were stored as plaintext JSON although DB_ENCRYPTION_KEY was configured.
  {
    const { BufferJSON, initAuthCreds } = realBaileys;
    const { decryptColumn, waSessionAad } = require('../src/crypto');
    const USER_3 = 3;
    const USER_4 = 4;
    const legacyCreds = { ...initAuthCreds(), me: { id: '31600000099:5@s.whatsapp.net', name: 'Legacy' } };
    const legacyKeys = { 'pre-key-7': { public: Buffer.alloc(32, 7), private: Buffer.alloc(32, 8) } };
    const db = getDb();
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER_3, 'legacy-plaintext@example.com');
    db.prepare('INSERT INTO wa_sessions (user_id, creds_json, keys_json) VALUES (?, ?, ?)').run(
      USER_3,
      JSON.stringify(legacyCreds, BufferJSON.replacer),
      JSON.stringify(legacyKeys, BufferJSON.replacer)
    );
    const before = fakeSockets.length;
    await initWhatsApp(USER_3);
    const cfg = fakeSockets[before]?.config;

    {
      check('N01', 'Regression ME-065: a legacy plaintext session row still loads (creds and keys)', () => {
        assert(cfg, 'no socket was created for the legacy row');
        assert(cfg.auth.creds.me?.id === legacyCreds.me.id, 'legacy creds did not load');
      });
      const got = cfg ? await cfg.auth.keys.get('pre-key', ['7']) : {};
      check('N02', 'Regression ME-065: legacy plaintext keys are readable', () => {
        assert(Buffer.isBuffer(got['7']?.private) && got['7'].private.equals(Buffer.alloc(32, 8)), 'legacy pre-key-7 not readable');
      });
      if (cfg) await cfg.auth.keys.set({ 'pre-key': { '8': { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 2) } } });
      const row = db.prepare('SELECT creds_json, keys_json FROM wa_sessions WHERE user_id = ?').get(USER_3) as any;
      check('N03', 'Regression ME-065: the next write re-saves both columns encrypted', () => {
        assert(row.creds_json.startsWith('enc:v1:') && row.keys_json.startsWith('enc:v1:'), 'row still plaintext after a write');
        assert(!row.keys_json.includes('pre-key-7') && !row.creds_json.includes('noiseKey'), 'plaintext visible in the encrypted row');
        const keys = JSON.parse(decryptColumn(row.keys_json, waSessionAad(USER_3, 'keys')));
        assert(keys['pre-key-7'] && keys['pre-key-8'], 'keys lost in the re-save');
      });

      // A row that cannot be decrypted (wrong key, or a ciphertext moved to another
      // user) must fail the connect and leave the row alone. Falling back to fresh
      // creds would overwrite — and so destroy — the stored pairing on first save.
      db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER_4, 'moved-row@example.com');
      db.prepare('INSERT INTO wa_sessions (user_id, creds_json, keys_json) VALUES (?, ?, ?)').run(USER_4, row.creds_json, row.keys_json);
      const socketsBefore = fakeSockets.length;
      let rejected = false;
      try { await initWhatsApp(USER_4); } catch { rejected = true; }
      const after = db.prepare('SELECT creds_json FROM wa_sessions WHERE user_id = ?').get(USER_4) as any;
      check('N04', 'Regression ME-065: an undecryptable row fails the connect and is never overwritten', () => {
        assert(rejected, 'initWhatsApp accepted a row encrypted for another user');
        assert(fakeSockets.length === socketsBefore, 'a socket was started with replacement creds');
        assert(after.creds_json === row.creds_json, 'the undecryptable row was overwritten');
      });
    }
  }

  console.log('\nG — A restart waits for the voice note in flight (WAY-057)');

  // Regression WAY-057: a deploy restarted pm2 two seconds after a voice note came in.
  // Whisper had finished, the reply had not been sent, and the note was lost for good:
  // shutdown closed the WhatsApp sockets straight away and pm2 SIGKILLed after 1.6 s.
  {
    const { drainInFlight, inFlightCount } = require('../src/shutdown');
    const { saveUserSettings } = require('../src/auth');
    saveUserSettings(USER_ID, { transcribe_1on1_received: true, exclude_contacts: [], exclude_groups: [] });
    let openGate!: () => void;
    pipelineGate = new Promise<void>(resolve => { openGate = resolve; });
    const sentBefore = sentMessages.length;

    socketEvents!.emit('messages.upsert', { type: 'notify', messages: [incomingVoiceMessage('VOICE_INFLIGHT')] });
    const drainedWhileHeld = await drainInFlight(200);
    check('G01', 'Regression WAY-057: a voice note mid-pipeline is tracked as in flight', () => {
      assert(inFlightCount() >= 1, 'the upsert handler is not tracked: shutdown would not wait for it');
      assert(!drainedWhileHeld, 'drain finished while the pipeline was still running');
      assert(sentMessages.length === sentBefore, 'a reply went out before the pipeline finished');
    });

    setTimeout(() => openGate(), 100);
    const drained = await drainInFlight(3000);
    pipelineGate = null;
    check('G02', 'Regression WAY-057: draining waits until the reply has been sent', () => {
      assert(drained, 'drain timed out with the pipeline already released');
      assert(sentMessages.length === sentBefore + 1, 'drain returned before the transcript reply was sent');
      assert(inFlightCount() === 0, 'finished work is still counted as in flight');
    });
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`✓ All ${passed} retry checks passed`);
  } else {
    console.log(`✗ ${failed} failed, ${passed} passed`);
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  process.exit(1);
});
