#!/usr/bin/env -S npx tsx
/**
 * WhatYouSay — contact identity stays out of ops alerts and logs
 * Run: npx tsx evals/privacy-alerts.ts
 *
 * Needs no server, no pairing, no Groq key and no real Telegram bot: Baileys and
 * the pipeline are stubbed, global fetch is intercepted, and the DB is a
 * throwaway file. Part of `npm run check`.
 *
 * Regression ME-065: when a recipient's phone could not decrypt a transcript,
 * handleDeliveryStuck sent the sender's WhatsApp display name (or, without one,
 * the full phone number) to the Telegram ops chat, and put the full JID into
 * the notify key, which every notify.* log line records. src/notify.ts promises
 * metadata only: no contact names, no full numbers. A group voice note also
 * logged up to eight participants' display names (wa.group_meta_sample).
 *
 * The checks drive the real intake and retry-receipt path with a fake contact
 * and assert that neither the number nor the name appears in any outgoing
 * Telegram text, notify key or log line.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wys-privacy-'));
process.env.DB_PATH = path.join(TMP_DIR, 'eval.db');
// Alerts must look configured so the text is actually rendered and "sent";
// fetch is intercepted below, so nothing leaves the machine.
process.env.TELEGRAM_BOT_TOKEN = 'dummy-eval-token';
process.env.TELEGRAM_CHAT_ID = '-100';
delete process.env.TELEGRAM_THREAD_ID;

const USER_ID = 1;
// Fake contacts. The needles are everything that identifies them; only the
// last four digits may appear anywhere.
const DM_NUMBER = '4915550123478';
const DM_JID = `${DM_NUMBER}@s.whatsapp.net`;
const DM_NAME = 'Zelda Quarrington';
// A contact with no WhatsApp display name: the old code fell back to the full number.
const NONAME_NUMBER = '4915550246813';
const NONAME_JID = `${NONAME_NUMBER}@s.whatsapp.net`;
const GROUP_JID = '120363555000111222@g.us';
const GROUP_NUMBER = '4915550987612';
const GROUP_SENDER_JID = `${GROUP_NUMBER}:7@s.whatsapp.net`;
const GROUP_NAME = 'Bartholomew Ostrander';
const OTHER_MEMBER_NAME = 'Philippa Vandermolen';

const NEEDLES = [
  DM_NUMBER, DM_NUMBER.slice(-7), DM_JID, DM_NAME, 'Zelda', 'Quarrington',
  NONAME_NUMBER, NONAME_NUMBER.slice(-7),
  GROUP_NUMBER, GROUP_NUMBER.slice(-7), GROUP_NAME, 'Bartholomew', 'Ostrander',
  OTHER_MEMBER_NAME, 'Philippa', 'Vandermolen',
];

function leaks(text: string): string[] {
  return NEEDLES.filter(n => text.includes(n));
}

const out = console.log.bind(console);
const err = console.error.bind(console);
let passed = 0;
let failed = 0;

function check(id: string, desc: string, fn: () => void): void {
  try {
    fn();
    out(`  ✓ ${id} ${desc}`);
    passed++;
  } catch (e: unknown) {
    err(`  ✗ ${id} ${desc}`);
    err(`      ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── Capture everything that could leave the process ─────────────────────────

const telegramTexts: string[] = [];
(globalThis as any).fetch = async (url: string, init?: { body?: string }) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    telegramTexts.push(JSON.parse(init?.body ?? '{}').text ?? '');
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const logLines: string[] = [];
const logObjects: any[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  (console as any)[level] = (...args: unknown[]) => { logLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
}

// ── Stub Baileys and the pipeline ────────────────────────────────────────────

let socketConfig: any = null;
let socketEvents: EventEmitter | null = null;
const sent: { jid: string; text: string }[] = [];
let replyCounter = 0;

function makeFakeSocket(config: any) {
  const ev = new EventEmitter();
  socketConfig = config;
  socketEvents = ev;
  return {
    ev,
    user: { id: '31600000009:1@s.whatsapp.net', name: 'Operator' },
    end: async () => {},
    logout: async () => {},
    profilePictureUrl: async () => null,
    updateMediaMessage: async () => undefined,
    groupMetadata: async (jid: string) => ({
      id: jid,
      subject: 'Eval group',
      participants: [
        { id: GROUP_SENDER_JID.replace(':7', ''), notify: GROUP_NAME },
        { id: '4915550333444@s.whatsapp.net', notify: OTHER_MEMBER_NAME },
      ],
    }),
    sendMessage: async (jid: string, content: { text: string }) => {
      sent.push({ jid, text: content.text });
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
  id: BAILEYS, filename: BAILEYS, loaded: true,
  exports: {
    ...realBaileys,
    __esModule: true,
    default: makeFakeSocket,
    makeWASocket: makeFakeSocket,
    downloadMediaMessage: async () => Buffer.from('fake-ogg-bytes'),
  },
} as any;

const PIPELINE = require.resolve('../src/pipeline');
require.cache[PIPELINE] = {
  id: PIPELINE, filename: PIPELINE, loaded: true,
  exports: {
    __esModule: true,
    runPipeline: async () => ({
      transcript: 'Hello.', language: 'en', duration: 2, summary: undefined,
      replyText: '🎤 *Transcript*\n\nHello.', inputTokens: 1, outputTokens: 1,
    }),
    PipelineError: class PipelineError extends Error {},
  },
} as any;

// pino writes straight to fd 1, past console, so wrap the shared logger too.
const { logger } = require('../src/logger');
for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
  (logger as any)[level] = (...args: unknown[]) => {
    logObjects.push(args[0]);
    logLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  };
}

const { getDb } = require('../src/db');
const { saveUserSettings } = require('../src/auth');
const { initWhatsApp } = require('../src/whatsapp');

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return cond();
}

const voice = (id: string, remoteJid: string, pushName: string | undefined, participant?: string) => ({
  key: { id, remoteJid, fromMe: false, ...(participant ? { participant } : {}) },
  ...(pushName ? { pushName } : {}),
  message: { audioMessage: { seconds: 2, ptt: true } },
});

async function main(): Promise<void> {
  out('WhatYouSay — privacy of ops alerts and logs (Regression ME-065)\n');

  getDb().prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(USER_ID, 'privacy-eval@example.com');
  saveUserSettings(USER_ID, { transcribe_group_received: true });
  await initWhatsApp(USER_ID);
  socketEvents!.emit('connection.update', { connection: 'open' });

  // A 1-on-1 note and a group note from the fake contacts, each answered.
  socketEvents!.emit('messages.upsert', { type: 'notify', messages: [voice('VOICE_DM', DM_JID, DM_NAME)] });
  await waitFor(() => sent.length >= 1, 5000);
  socketEvents!.emit('messages.upsert', { type: 'notify', messages: [voice('VOICE_GRP', GROUP_JID, GROUP_NAME, GROUP_SENDER_JID)] });
  await waitFor(() => sent.length >= 2, 5000);
  socketEvents!.emit('messages.upsert', { type: 'notify', messages: [voice('VOICE_NONAME', NONAME_JID, undefined)] });
  await waitFor(() => sent.length >= 3, 5000);

  // Two retry receipts per reply mark the recipient's phone as stuck, which
  // runs handleDeliveryStuck: socket resync, ops alert, re-send after 8 s.
  const stuckReplies = sent.slice(0, 3).map((s, i) => ({ id: `REPLY_${i + 1}`, remoteJid: s.jid }));
  for (const key of stuckReplies) {
    await socketConfig.getMessage(key);
    await socketConfig.getMessage(key);
  }
  await waitFor(() => telegramTexts.length >= 3, 3000);
  // Let the delayed re-sends run so their log lines are captured too.
  await waitFor(() => sent.length >= 6, 10_000);

  const stuckAlerts = telegramTexts.filter(t => /delivery stuck/i.test(t));
  const notifyKeys: string[] = logObjects
    .filter(o => o && typeof o === 'object' && String(o.event ?? '').startsWith('notify.'))
    .map(o => String(o.key ?? ''));

  out('P — the path under test actually ran');
  check('P01', 'all three stuck replies raised a delivery-stuck alert and were re-sent', () => {
    assert(sent.length >= 3, `only ${sent.length} transcript reply/replies were sent`);
    assert(stuckAlerts.length === 3, `expected 3 delivery-stuck alerts, got ${stuckAlerts.length}`);
    assert(sent.length >= 6, `expected 3 fallback re-sends, got ${sent.length - 3}`);
    assert(notifyKeys.some(k => k.startsWith('delivery_stuck:')), 'no notify.* log line carried a delivery_stuck key');
  });

  out('\nP — Regression ME-065: no names or full numbers leave the process');
  check('P02', 'delivery-stuck alert text names no contact and no full number', () => {
    const found = [...new Set(stuckAlerts.flatMap(leaks))];
    assert(found.length === 0, `alert text contains ${found.map(f => JSON.stringify(f)).join(', ')}`);
  });
  check('P03', 'the notify key carries no full JID, number or name', () => {
    const found = [...new Set(notifyKeys.flatMap(leaks))];
    assert(found.length === 0, `notify keys contain ${found.map(f => JSON.stringify(f)).join(', ')}`);
  });
  check('P04', 'no log line names a contact or carries a full number', () => {
    const bad = logLines.filter(l => leaks(l).length > 0);
    assert(bad.length === 0, `${bad.length} log line(s) leak, e.g. events ${[...new Set(bad.map(l => (l.match(/"event":"([^"]+)"/) ?? [])[1] ?? '?'))].join(', ')}`);
  });
  check('P05', 'alerts still tell senders apart by a masked suffix (last 4 digits)', () => {
    assert(stuckAlerts.some(t => t.includes(DM_NUMBER.slice(-4))), 'the 1-on-1 alert lost the masked sender suffix');
    assert(stuckAlerts.some(t => t.includes(GROUP_NUMBER.slice(-4))), 'the group alert lost the masked sender suffix');
    assert(stuckAlerts.some(t => t.includes(NONAME_NUMBER.slice(-4))), 'the nameless-contact alert lost the masked sender suffix');
  });

  out('\nP — backstops for the next caller');
  const { notifyOps } = require('../src/notify');
  const before = telegramTexts.length;
  await notifyOps(`eval_backstop:${DM_JID}`, `Eval alert for ${DM_NUMBER}`, { contact: DM_JID });
  check('P06', 'notifyOps masks long digit runs in key, title and fields', () => {
    const text = telegramTexts.slice(before).join('\n');
    assert(telegramTexts.length === before + 1, 'the backstop alert was not sent');
    const keys = logObjects.filter(o => o?.event === 'notify.sent' && String(o.key).startsWith('eval_backstop:')).map(o => String(o.key));
    assert(keys.length === 1, `expected 1 notify.sent line for the backstop key, got ${keys.length}`);
    const found = [...new Set([text, ...keys].flatMap(leaks))];
    assert(found.length === 0, `backstop let through ${found.map(f => JSON.stringify(f)).join(', ')}`);
  });
  check('P07', 'crash handlers print the stack, not a Baileys error\'s stanza data', () => {
    const { describeCrash } = require('../src/log-filter');
    const boom: any = new Error(`Bad MAC for ${DM_NUMBER}`);
    boom.output = { statusCode: 500 };
    boom.data = { tag: 'message', attrs: { from: DM_JID, notify: DM_NAME } };
    const line = describeCrash(boom);
    const found = leaks(line);
    assert(found.length === 0, `crash line contains ${found.map(f => JSON.stringify(f)).join(', ')}`);
    assert(line.includes('Bad MAC') && line.includes('500'), 'crash line lost the error message or status');
    const str = describeCrash(`rejected for ${DM_JID}`);
    assert(str.includes('rejected for') && leaks(str).length === 0, 'a string rejection lost its text or kept the number');
    const obj = describeCrash({ code: 'ETIMEDOUT', from: DM_JID, notify: DM_NAME });
    assert(obj.includes('ETIMEDOUT') && leaks(obj).length === 0, 'a plain-object rejection lost its code or leaked its contents');
  });

  out(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  err('privacy-alerts eval crashed:', e);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  process.exit(1);
});
