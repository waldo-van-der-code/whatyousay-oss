#!/usr/bin/env -S npx tsx
/**
 * WhatYouSay — security evals (ME-065)
 * Run: npx tsx evals/security.ts
 *
 * Needs no running server, no Telegram network access and no secrets: the router is
 * mounted on an ephemeral port against a throwaway DB, and the Telegram bot's API
 * calls are intercepted by a grammY transformer. Part of `npm run check`.
 *
 * What it pins:
 *  - POST /telegram/webhook rejects any update that does not carry the webhook secret
 *    in X-Telegram-Bot-Api-Secret-Token. Before ME-065 anyone could POST a forged
 *    update and drive the bot (for example a /link that stores an attacker-chosen
 *    group title, which the dashboard then rendered as HTML).
 *  - setWebhook registers that same secret with Telegram.
 *  - Telegram link codes are 128-bit, rotate after use, and only chat admins can
 *    /link or /unlink a group.
 *  - POST /auth/login validates the address, creates no user row until the link is
 *    confirmed, is rate limited per email and per IP, and refuses cross-site posts.
 *  - GET /auth/verify only shows a confirm page; the POST it submits logs in (login CSRF).
 *  - Session cookies are Secure without NODE_ENV; /api/settings is allowlisted.
 *  - libsignal's console dumps of Signal session keys never reach the logs.
 *  - wa_sessions columns are AES-256-GCM encrypted at rest; legacy plaintext still reads.
 *  - Throwaway accounts cannot starve linked accounts' WhatsApp reconnects.
 *  - Transcription senders are anonymised after 90 days (salted hash, name dropped).
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { AddressInfo } from 'node:net';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wys-security-'));
process.env.DB_PATH = path.join(TMP_DIR, 'eval.db');
process.env.GROQ_API_KEY = 'stub-key-not-used';
process.env.TELEGRAM_WEBHOOK_SECRET = 'eval-webhook-secret_0123456789abcdef';
process.env.LOG_LEVEL = 'silent';
process.env.RESEND_API_KEY = 're_eval_stub_not_a_key';
delete process.env.NODE_ENV;
delete process.env.ALLOW_INSECURE_COOKIES;
delete process.env.BASE_URL;

// Resend is reached through global fetch: capture outgoing login emails instead of
// sending them, so the magic-link checks can follow the link like a user would.
const sentEmails: { to: string[]; html: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('https://api.resend.com')) {
    const body = JSON.parse(init?.body ?? '{}');
    sentEmails.push({ to: body.to, html: body.html });
    return new Response(JSON.stringify({ id: 'eval' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(id: string, desc: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${id} ${desc}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${id} ${desc}\n      ${msg}`);
    failed++;
    failures.push(`${id}: ${msg}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { router } = await import('../src/routes');
  const { getDb } = await import('../src/db');
  const tg: Record<string, any> = await import('../src/telegram-bot');
  const auth: Record<string, any> = { ...(await import('../src/auth')), ...(await import('../src/validation')) };

  const db = getDb();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser('eval'));
  app.use('/', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET!;
  const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: 'hi' } };
  const postWebhook = (headers: Record<string, string>) =>
    fetch(`${base}/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(update),
    });

  console.log('\nWebhook authentication');

  // Regression ME-065: forged Telegram updates were accepted without any secret.
  await check('W01', 'Regression ME-065: webhook without secret header → 401', async () => {
    const res = await postWebhook({});
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check('W02', 'Regression ME-065: webhook with wrong secret header → 401', async () => {
    const res = await postWebhook({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check('W03', 'Regression ME-065: webhook with secret differing only in last char → 401', async () => {
    const res = await postWebhook({ 'X-Telegram-Bot-Api-Secret-Token': SECRET.slice(0, -1) + 'X' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check('W04', 'Regression ME-065: webhook with correct secret header → 200', async () => {
    const res = await postWebhook({ 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  await check('W05', 'Regression ME-065: without TELEGRAM_WEBHOOK_SECRET the secret derives from the bot token, never empty', () => {
    assert(typeof tg.getWebhookSecret === 'function', 'getWebhookSecret not exported');
    const saved = { s: process.env.TELEGRAM_WEBHOOK_SECRET, t: process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN };
    try {
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
      delete process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN;
      assert(tg.getWebhookSecret() === null, 'no secret and no bot token must yield null (reject all)');
      assert(tg.verifyWebhookSecret('') === false, 'empty header accepted when no secret configured');
      assert(tg.verifyWebhookSecret(undefined) === false, 'missing header accepted when no secret configured');
      process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN = '123:abc';
      const derived = tg.getWebhookSecret();
      assert(typeof derived === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(derived), `derived secret not valid for Telegram: ${derived}`);
      assert(!derived.includes('123:abc'), 'derived secret must not contain the bot token');
    } finally {
      process.env.TELEGRAM_WEBHOOK_SECRET = saved.s;
      if (saved.t === undefined) delete process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN;
      else process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN = saved.t;
    }
  });

  // ── Bot with intercepted API ───────────────────────────────────────────────
  console.log('\nTelegram bot');

  const apiCalls: { method: string; payload: any }[] = [];
  const memberStatus = new Map<number, string>(); // telegram user id → chat member status
  const BOT_ID = 999;

  let bot: any = null;
  if (typeof tg.createTelegramBot === 'function') {
    bot = tg.createTelegramBot('999:eval-token');
    bot.botInfo = { id: BOT_ID, is_bot: true, first_name: 'Eval', username: 'eval_bot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
    bot.api.config.use(async (_prev: unknown, method: string, payload: any) => {
      apiCalls.push({ method, payload });
      let result: unknown = true;
      if (method === 'getChatMember') {
        const status = payload.user_id === BOT_ID ? 'administrator' : (memberStatus.get(payload.user_id) ?? 'member');
        result = { status, user: { id: payload.user_id, is_bot: false, first_name: 'x' } };
      } else if (method === 'getMe') {
        result = bot.botInfo;
      } else if (method === 'sendMessage') {
        result = { message_id: 1, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
      }
      return { ok: true, result } as any;
    });
  }

  let updateId = 100;
  const groupMsg = (chatId: number, fromId: number, text: string, title = 'Eval group') => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'supergroup', title },
      from: { id: fromId, is_bot: false, first_name: 'u' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  });
  const dmMsg = (fromId: number, text: string) => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'u' },
      from: { id: fromId, is_bot: false, first_name: 'u' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  });
  const lastReply = () => [...apiCalls].reverse().find(c => c.method === 'sendMessage')?.payload?.text ?? '';
  const groupRow = (chatId: number) =>
    db.prepare('SELECT * FROM telegram_groups WHERE chat_id = ?').get(String(chatId)) as any;

  // Capture every log line so L09 can prove no link code is ever logged.
  const { logger } = await import('../src/logger');
  const logLines: unknown[] = [];
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    (logger as any)[level] = (...args: unknown[]) => { logLines.push(args); };
  }
  const usedCodes: string[] = [];
  const codeFor = (userId: number) => { const c = tg.getOrCreatePersonalToken(userId); usedCodes.push(c); return c; };

  const ownerA = auth.getOrCreateUser('owner-a@eval.local');
  const ownerB = auth.getOrCreateUser('owner-b@eval.local');

  await check('L01', 'Regression ME-065: link codes are at least 128-bit', () => {
    const code = tg.getOrCreatePersonalToken(ownerA);
    assert(/^[0-9A-F]{32,}$/.test(code), `code too short / wrong format: length ${code.length}`);
  });

  await check('L02', 'Regression ME-065: a legacy 8-char code is upgraded and no longer accepted', () => {
    const legacyUser = auth.getOrCreateUser('legacy@eval.local');
    db.prepare('INSERT OR REPLACE INTO telegram_tokens (user_id, token) VALUES (?, ?)').run(legacyUser, 'ABCDEF12');
    assert(typeof tg.lookupToken === 'function', 'lookupToken not exported');
    assert(tg.lookupToken('ABCDEF12') === null, 'legacy short code still resolves to a user');
    const upgraded = tg.getOrCreatePersonalToken(legacyUser);
    assert(upgraded !== 'ABCDEF12' && upgraded.length >= 32, 'legacy code was not upgraded');
  });

  await check('L03', 'Regression ME-065: non-admin cannot /link a group; the exposed code is burned', async () => {
    assert(bot, 'createTelegramBot not exported');
    const code = codeFor(ownerA);
    memberStatus.set(501, 'member');
    await bot.handleUpdate(groupMsg(-1001, 501, `/link ${code}`));
    assert(!groupRow(-1001), 'group was linked by a non-admin');
    assert(/admin/i.test(lastReply()), `reply did not mention admins: ${lastReply()}`);
    assert(tg.getOrCreatePersonalToken(ownerA) !== code, 'code posted in a group was not rotated');
  });

  await check('L04', 'Regression ME-065: admin /link links the group and rotates the code', async () => {
    assert(bot, 'createTelegramBot not exported');
    const code = codeFor(ownerA);
    memberStatus.set(502, 'administrator');
    await bot.handleUpdate(groupMsg(-1002, 502, `/link ${code}`, '<img src=x onerror=alert(1)>'));
    const row = groupRow(-1002);
    assert(row && row.user_id === ownerA, 'group not linked to owner A');
    assert(tg.getOrCreatePersonalToken(ownerA) !== code, 'code not rotated after successful /link');
    assert(tg.lookupToken(code) === null, 'used code still resolves');
  });

  await check('L05', 'Regression ME-065: non-admin with a valid code cannot take over a linked group', async () => {
    assert(bot, 'createTelegramBot not exported');
    const codeB = codeFor(ownerB);
    memberStatus.set(503, 'member');
    await bot.handleUpdate(groupMsg(-1002, 503, `/link ${codeB}`));
    assert(groupRow(-1002)?.user_id === ownerA, 'non-admin overwrote another user\'s group link');
  });

  await check('L06', 'Regression ME-065: admin relink of a group owned by someone else is announced, not silent', async () => {
    assert(bot, 'createTelegramBot not exported');
    db.prepare('UPDATE telegram_tokens SET telegram_user_id = 502 WHERE user_id = ?').run(ownerA);
    const codeB = codeFor(ownerB);
    memberStatus.set(504, 'creator');
    await bot.handleUpdate(groupMsg(-1002, 504, `/link ${codeB}`));
    assert(groupRow(-1002)?.user_id === ownerB, 'admin relink did not take effect');
    const replies = apiCalls.filter(c => c.method === 'sendMessage' && c.payload.chat_id === -1002).map(c => c.payload.text);
    assert(/previously linked|another/i.test(replies[replies.length - 1] ?? ''), `relink reply did not announce the takeover: ${replies[replies.length - 1]}`);
    // Owner A's Telegram id is 502 (set below as if from their earlier DM /link): they must be told.
    const dm = apiCalls.find(c => c.method === 'sendMessage' && c.payload.chat_id === 502);
    assert(dm && /re-linked/i.test(dm.payload.text), 'previous owner was not notified by DM');
  });

  await check('L07', 'Regression ME-065: non-admin cannot /unlink; admin can', async () => {
    assert(bot, 'createTelegramBot not exported');
    memberStatus.set(505, 'member');
    await bot.handleUpdate(groupMsg(-1002, 505, '/unlink'));
    assert(groupRow(-1002), 'non-admin unlinked the group');
    await bot.handleUpdate(groupMsg(-1002, 504, '/unlink'));
    assert(!groupRow(-1002), 'admin could not unlink the group');
  });

  await check('L08', 'Regression ME-065: DM /link stores the Telegram user and rotates the code', async () => {
    assert(bot, 'createTelegramBot not exported');
    const code = codeFor(ownerA);
    await bot.handleUpdate(dmMsg(777, `/link ${code}`));
    const row = db.prepare('SELECT telegram_user_id FROM telegram_tokens WHERE user_id = ?').get(ownerA) as any;
    assert(row?.telegram_user_id === 777, 'telegram_user_id not stored');
    assert(tg.lookupToken(code) === null, 'code not rotated after DM /link');
  });

  await check('L10', 'Regression ME-065: an anonymous group admin can /link; the service bot id is not stored as the user', async () => {
    assert(bot, 'createTelegramBot not exported');
    const before = db.prepare('SELECT telegram_user_id FROM telegram_tokens WHERE user_id = ?').get(ownerB) as any;
    const code = codeFor(ownerB);
    const msg = groupMsg(-1003, 1087968824, `/link ${code}`, 'Anon group') as any;
    msg.message.from.is_bot = true; // @GroupAnonymousBot
    msg.message.sender_chat = { id: -1003, type: 'supergroup', title: 'Anon group' };
    await bot.handleUpdate(msg);
    assert(groupRow(-1003)?.user_id === ownerB, 'anonymous admin could not link');
    const after = db.prepare('SELECT telegram_user_id FROM telegram_tokens WHERE user_id = ?').get(ownerB) as any;
    assert(after.telegram_user_id === before.telegram_user_id, `telegram_user_id changed to ${after.telegram_user_id}`);
  });

  await check('L11', 'Regression ME-065: group admin using someone else\'s code must not overwrite the code owner\'s telegram_user_id', async () => {
    assert(bot, 'createTelegramBot not exported');
    const ownerC = auth.getOrCreateUser('owner-c@eval.local');
    const code0 = codeFor(ownerC);
    await bot.handleUpdate(dmMsg(601, `/link ${code0}`)); // owner C links their own DM
    const readId = () => (db.prepare('SELECT telegram_user_id FROM telegram_tokens WHERE user_id = ?').get(ownerC) as any)?.telegram_user_id;
    assert(readId() === 601, `DM link did not store the owner's id (got ${readId()})`);
    const code = codeFor(ownerC);
    memberStatus.set(602, 'administrator'); // a different person who administers a group and holds C's code
    await bot.handleUpdate(groupMsg(-1004, 602, `/link ${code}`, 'Shared group'));
    assert(groupRow(-1004)?.user_id === ownerC, 'group was not linked to the code owner');
    assert(readId() === 601, `group /link overwrote telegram_user_id with ${readId()} (expected 601)`);
  });

  await check('L09', 'Regression ME-065: /link never logs the code', () => {
    assert(usedCodes.length >= 4, `expected the /link checks to have used codes, got ${usedCodes.length}`);
    const logged = JSON.stringify(logLines);
    assert(logLines.some(l => JSON.stringify(l).includes('telegram.link_received')), 'link_received not logged at all — spy not wired');
    for (const c of usedCodes) assert(!logged.includes(c), 'a link code appears in the logs');
  });

  await check('W07', 'Regression ME-065: an invalid TELEGRAM_WEBHOOK_SECRET falls back to the derived secret, consistently', async () => {
    const saved = { s: process.env.TELEGRAM_WEBHOOK_SECRET, t: process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN };
    try {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'has spaces and !';
      process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN = '123:abc';
      const s1 = tg.getWebhookSecret();
      assert(s1 && s1 !== 'has spaces and !', 'invalid secret used as-is');
      apiCalls.length = 0;
      await tg.configureWebhook(bot);
      assert(apiCalls.find(c => c.method === 'setWebhook')?.payload.secret_token === s1, 'setWebhook and verify disagree');
      assert(tg.verifyWebhookSecret(s1), 'derived secret not accepted by verify');
    } finally {
      process.env.TELEGRAM_WEBHOOK_SECRET = saved.s;
      if (saved.t === undefined) delete process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN;
      else process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN = saved.t;
    }
  });

  await check('W06', 'Regression ME-065: setWebhook registers the secret_token', async () => {
    assert(bot && typeof tg.configureWebhook === 'function', 'configureWebhook not exported');
    apiCalls.length = 0;
    await tg.configureWebhook(bot);
    const call = apiCalls.find(c => c.method === 'setWebhook');
    assert(call, 'setWebhook not called');
    assert(call.payload.secret_token === SECRET, 'setWebhook called without the configured secret_token');
  });

  console.log('\nLogin validation');

  // Regression ME-065: any string containing "@" created a user row.
  for (const [id, bad] of [
    ['E01', `x'-alert(1)-'@evil`],
    ['E02', '<img src=x onerror=alert(1)>@x.com'],
    ['E03', 'no-at-sign.example.com'],
    ['E04', 'a@b'],
    ['E05', `${'a'.repeat(250)}@example.com`],
  ] as const) {
    await check(id, `Regression ME-065: POST /auth/login rejects ${JSON.stringify(bad.slice(0, 40))} and creates no user`, async () => {
      const before = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n;
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bad }),
      });
      const after = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n;
      assert(res.status === 400, `expected 400, got ${res.status}`);
      assert(after === before, 'a user row was created for an invalid address');
    });
  }

  await check('E06', 'Regression ME-065: isValidEmail accepts ordinary addresses', () => {
    assert(typeof auth.isValidEmail === 'function', 'isValidEmail not exported');
    for (const ok of ['jane.doe@example.org', 'first.last+tag@sub.example.co.uk', "o'brien@example.com"]) {
      assert(auth.isValidEmail(ok), `rejected valid address ${ok}`);
    }
  });

  // ── ME-065 sweep 3: login, cookies, settings, logs, encryption ─────────────
  const routes: Record<string, any> = await import('../src/routes');
  const resetLoginLimits = () => {
    if (routes.loginLimits) for (const l of Object.values(routes.loginLimits) as any[]) l.reset();
  };
  const userCount = (email: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(email) as any).n as number;
  const setCookies = (res: Response): string[] => (res.headers as any).getSetCookie?.() ?? [];
  const cookieValue = (res: Response, name: string) => {
    const c = setCookies(res).find(x => x.startsWith(`${name}=`));
    return c ? c.split(';')[0].slice(name.length + 1) : undefined;
  };
  const login = (email: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ email }),
    });
  const linkFromLastEmail = () => {
    const html = sentEmails[sentEmails.length - 1]?.html ?? '';
    const m = html.match(/\/auth\/verify\?token=([0-9a-f]{64})/);
    return m?.[1];
  };
  const confirm = (token: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/auth/verify`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ token }).toString(),
    });

  console.log('\nMagic links and login CSRF');

  resetLoginLimits();
  const NEW_EMAIL = 'fresh-user@eval.local';
  const firstLogin = await login(NEW_EMAIL);
  const firstToken = linkFromLastEmail();
  const nonce = cookieValue(firstLogin, 'login_nonce');

  await check('U01', 'Regression ME-065: POST /auth/login creates no users row before the link is confirmed', () => {
    assert(firstLogin.status === 200, `expected 200, got ${firstLogin.status}`);
    assert(firstToken, 'no magic link was emailed');
    assert(userCount(NEW_EMAIL) === 0, 'a users row was created at request time');
  });

  await check('V01', 'Regression ME-065: GET /auth/verify shows a confirm page naming the account and does not log in', async () => {
    const res = await fetch(`${base}/auth/verify?token=${firstToken}`, { redirect: 'manual' });
    const html = await res.text();
    assert(res.status === 200, `expected the confirm page (200), got ${res.status}`);
    assert(!cookieValue(res, 'session'), 'GET set a session cookie');
    assert(html.includes(NEW_EMAIL), 'confirm page does not show the account email');
    assert(/<form[^>]+method="POST"[^>]+action="\/auth\/verify"/i.test(html), 'confirm page has no POST form');
    assert(userCount(NEW_EMAIL) === 0, 'GET created the users row');
  });

  await check('V02', 'Regression ME-065: the confirm page warns when the link is opened in a browser that did not request it', async () => {
    const other = await (await fetch(`${base}/auth/verify?token=${firstToken}`)).text();
    const same = await (await fetch(`${base}/auth/verify?token=${firstToken}`, { headers: { Cookie: `login_nonce=${nonce}` } })).text();
    assert(nonce && /^[0-9a-f]{64}$/.test(nonce), 'POST /auth/login set no login_nonce cookie');
    assert(/different browser/i.test(other), 'no warning without the nonce cookie');
    assert(!/different browser/i.test(same), 'warning shown in the browser that requested the link');
  });

  await check('X01', 'Regression ME-065: a cross-site POST /auth/verify is rejected and does not burn the link', async () => {
    const res = await confirm(firstToken!, { Origin: 'https://evil.example' });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    const res2 = await confirm(firstToken!, { 'Sec-Fetch-Site': 'cross-site' });
    assert(res2.status === 403, `Sec-Fetch-Site: cross-site → expected 403, got ${res2.status}`);
    assert(userCount(NEW_EMAIL) === 0, 'a rejected confirm created the user');
  });

  let sessionCookieHeader = '';
  await check('V03', 'Regression ME-065: the same-origin confirm POST logs in and creates the user', async () => {
    const res = await confirm(firstToken!, { Origin: base });
    assert(res.status === 303 && res.headers.get('location') === '/', `expected 303 → /, got ${res.status} ${res.headers.get('location')}`);
    const session = setCookies(res).find(c => c.startsWith('session='));
    assert(session, 'no session cookie set');
    sessionCookieHeader = session.split(';')[0];
    assert(userCount(NEW_EMAIL) === 1, 'users row not created on confirm');
  });

  await check('C01', 'Regression ME-065: the session cookie is Secure and HttpOnly without NODE_ENV', async () => {
    resetLoginLimits();
    await login(NEW_EMAIL);
    const res = await confirm(linkFromLastEmail()!);
    const session = setCookies(res).find(c => c.startsWith('session='));
    assert(session, 'no session cookie set');
    assert(/;\s*Secure/i.test(session), `session cookie is not Secure: ${session.replace(/=[^;]+/, '=…')}`);
    assert(/;\s*HttpOnly/i.test(session), 'session cookie is not HttpOnly');
    assert(/;\s*SameSite=Lax/i.test(session), 'session cookie is not SameSite=Lax');
  });

  await check('C02', 'Regression ME-065: ALLOW_INSECURE_COOKIES only drops Secure outside production', () => {
    assert(typeof routes.cookieSecure === 'function', 'cookieSecure not exported');
    try {
      process.env.ALLOW_INSECURE_COOKIES = 'true';
      assert(routes.cookieSecure() === false, 'opt-out ignored in dev');
      process.env.NODE_ENV = 'production';
      assert(routes.cookieSecure() === true, 'opt-out honoured in production');
    } finally {
      delete process.env.ALLOW_INSECURE_COOKIES;
      delete process.env.NODE_ENV;
    }
  });

  await check('V04', 'Regression ME-065: a magic link is single-use', async () => {
    const res = await confirm(firstToken!);
    assert(res.status === 303 && /error=invalid/.test(res.headers.get('location') ?? ''), `reuse not refused: ${res.status} ${res.headers.get('location')}`);
  });

  await check('V05', 'Regression ME-065: the confirm page HTML-escapes the email', async () => {
    resetLoginLimits();
    const tricky = "o'<b>$`$&{{TOKEN}}x@example.com";
    // Not a valid address, so mint the token directly to prove the template escapes regardless.
    const token = auth.createLoginToken(tricky, null);
    const html = await (await fetch(`${base}/auth/verify?token=${token}`)).text();
    assert(!html.includes('<b>x@'), 'email rendered as HTML');
    assert(html.includes('o&#39;&lt;b&gt;$`$&amp;{{TOKEN}}x@example.com'), 'escaped email missing or $-patterns expanded');
    assert(html.includes(`name="token" value="${token}"`), 'an email containing {{TOKEN}} displaced the real token');
  });

  await check('V06', 'Regression ME-065: cross-device links (POST /auth/link) also go through the confirm page', async () => {
    const res = await fetch(`${base}/auth/link`, { method: 'POST', headers: { Cookie: sessionCookieHeader } });
    const { url } = await res.json() as { url: string };
    const token = new URL(url).searchParams.get('token');
    const page = await fetch(`${base}/auth/verify?token=${token}`, { redirect: 'manual' });
    assert(page.status === 200 && !cookieValue(page, 'session'), 'cross-device GET logged in directly');
  });

  console.log('\nLogin rate limits and cross-site posts');

  await check('R01', 'Regression ME-065: the 4th login request for one email within 15 min → 429', async () => {
    resetLoginLimits();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await login(i % 2 ? 'Rate@Eval.local' : 'rate@eval.local', { 'X-Real-IP': `203.0.113.${i + 1}` })).status);
    }
    assert(codes.join(',') === '200,200,200,429', `got ${codes.join(',')}`);
  });

  await check('R02', 'Regression ME-065: the 11th login request from one IP within 15 min → 429', async () => {
    resetLoginLimits();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await login(`ip-${i}@eval.local`, { 'X-Real-IP': '198.51.100.7' })).status);
    assert(codes.slice(0, 10).every(c => c === 200) && codes[10] === 429, `got ${codes.join(',')}`);
    const other = await login('ip-other@eval.local', { 'X-Real-IP': '198.51.100.8' });
    assert(other.status === 200, `a different IP was blocked too: ${other.status}`);
  });

  await check('X02', 'Regression ME-065: POST /auth/login rejects a form post (non-JSON body)', async () => {
    resetLoginLimits();
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=victim%40eval.local',
    });
    assert(res.status === 415, `expected 415, got ${res.status}`);
  });

  await check('X03', 'Regression ME-065: POST /auth/login from another Origin → 403, from this origin → 200', async () => {
    resetLoginLimits();
    const before = sentEmails.length;
    const evil = await login('victim@eval.local', { Origin: 'https://evil.example' });
    assert(evil.status === 403, `foreign origin: expected 403, got ${evil.status}`);
    assert(sentEmails.length === before, 'an email was sent for a cross-site request');
    const ok = await login('victim@eval.local', { Origin: base });
    assert(ok.status === 200, `same origin: expected 200, got ${ok.status}`);
  });

  await check('M01', 'Regression ME-065: auth.magic_link_sent logs a masked email', () => {
    const lines = logLines.map(l => JSON.stringify(l)).filter(l => l.includes('auth.magic_link_sent'));
    assert(lines.length > 0, 'auth.magic_link_sent not logged — spy not wired');
    assert(!lines.some(l => l.includes('victim@eval.local') || l.includes('fresh-user@eval.local')), 'full email in auth.magic_link_sent');
    assert(lines.some(l => l.includes('v***@eval.local')), 'masked form missing');
  });

  console.log('\nSettings allowlist');

  const settingsPost = (body: unknown) =>
    fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookieHeader },
      body: JSON.stringify(body),
    });

  await check('S01', 'Regression ME-065: POST /api/settings drops unknown keys', async () => {
    const res = await settingsPost({ evil_key: 'x'.repeat(1000), summary_enabled: false });
    const body = await res.json() as Record<string, unknown>;
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(!('evil_key' in body), 'unknown key echoed back');
    assert(body.summary_enabled === false, 'allowed key not saved');
    const userId = auth.verifySession(sessionCookieHeader.split('=')[1]);
    const stored = (db.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(userId) as any)?.settings_json ?? '';
    assert(!stored.includes('evil_key'), 'unknown key stored');
  });

  await check('S02', 'Regression ME-065: POST /api/settings rejects a wrongly typed value', async () => {
    for (const bad of [{ summary_min_words: 'abc' }, { summary_min_words: null }, { transcribe_1on1_sent: 'yes' }, { exclude_contacts: [{}] }, { whisper_context: 'x'.repeat(201) }]) {
      const res = await settingsPost(bad);
      assert(res.status === 400, `${JSON.stringify(bad).slice(0, 60)} → expected 400, got ${res.status}`);
    }
  });

  await check('S03', 'Regression ME-065: posting back the full GET response still saves (dashboard Telegram toggles)', async () => {
    const current = await (await fetch(`${base}/api/settings`, { headers: { Cookie: sessionCookieHeader } })).json() as Record<string, unknown>;
    const res = await settingsPost({ ...current, telegram_transcribe_sent: false, whisper_include_sender_name: true });
    const body = await res.json() as Record<string, unknown>;
    assert(res.status === 200 && body.telegram_transcribe_sent === false, `save failed: ${res.status}`);
    assert(!('whisper_include_sender_name' in body), 'retired key echoed back');
  });

  await check('S04', 'Regression ME-065: a stored value the schema now refuses falls back to its default, so saves keep working', async () => {
    const userId = auth.verifySession(sessionCookieHeader.split('=')[1]);
    db.prepare('UPDATE user_settings SET settings_json = ? WHERE user_id = ?').run(
      JSON.stringify({ summary_min_words: null, whisper_context: 'x'.repeat(300), known_names: 'Mira' }),
      userId
    );
    const current = await (await fetch(`${base}/api/settings`, { headers: { Cookie: sessionCookieHeader } })).json() as Record<string, unknown>;
    assert(current.summary_min_words === 120, `invalid stored summary_min_words returned as ${current.summary_min_words}`);
    assert(current.whisper_context === undefined, 'over-long stored whisper_context returned');
    assert(current.known_names === 'Mira', 'valid stored value lost');
    const res = await settingsPost({ ...current, telegram_transcribe_received: false });
    assert(res.status === 200, `posting the GET response back failed: ${res.status}`);
  });

  await check('R03', 'Regression ME-065: a request refused by the global cap does not use up the per-email budget', async () => {
    resetLoginLimits();
    for (let i = 0; i < 30; i++) routes.loginLimits.global.hit('all');
    const blocked = await login('budget@eval.local', { 'X-Real-IP': '192.0.2.50' });
    assert(blocked.status === 429, `global cap not enforced: ${blocked.status}`);
    routes.loginLimits.global.reset();
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await login('budget@eval.local', { 'X-Real-IP': `192.0.2.${60 + i}` })).status);
    assert(codes.join(',') === '200,200,200', `per-email budget was consumed by the refused request: ${codes.join(',')}`);
  });

  console.log('\nlibsignal console filter');

  const logFilter: Record<string, any> = await import('../src/log-filter').catch(() => ({}));
  // A real SessionEntry, shaped like the ones session_record.js prints.
  const SessionRecord = require('libsignal/src/session_record');
  const entry = SessionRecord.createEntry();
  entry.registrationId = 1;
  entry.currentRatchet = {
    ephemeralKeyPair: { pubKey: Buffer.alloc(33, 1), privKey: Buffer.alloc(32, 2) },
    lastRemoteEphemeralKey: Buffer.alloc(33, 3),
    previousCounter: 0,
    rootKey: Buffer.alloc(32, 4),
  };
  entry.indexInfo = { baseKey: Buffer.alloc(33, 5), baseKeyType: 1, closed: -1, used: 0, created: 0, remoteIdentityKey: Buffer.alloc(33, 6) };

  await check('G01', 'Regression ME-065: SessionEntry / privKey / rootKey console calls are classified sensitive', () => {
    assert(typeof logFilter.isSensitiveLogCall === 'function', 'isSensitiveLogCall not exported');
    const f = logFilter.isSensitiveLogCall;
    const sensitive: unknown[][] = [
      ['Removing old closed session:', entry],
      ['Closing session:', entry],
      ['Opening session:', entry],
      ['Session already closed', entry],
      ['some new libsignal message', entry],
      ['state', { currentRatchet: { rootKey: Buffer.alloc(32) } }],
      ['deep', { a: { b: { privKey: Buffer.alloc(32) } } }],
      [{ sessions: { x: entry } }],
      ['Removing old closed session:'],
    ];
    for (const args of sensitive) assert(f(args), `not filtered: ${String(args[0])}`);
    const harmless: unknown[][] = [
      ['WhatYouSay running on http://127.0.0.1:3000'],
      ['[db] wa_msg_id dedup column ready', { ok: true }],
      ['[uncaughtException]', new Error('boom')],
      ['Session error:Error: Bad MAC', 'stack…'],
    ];
    for (const args of harmless) assert(!f(args), `wrongly filtered: ${String(args[0])}`);
  });

  await check('G02', 'Regression ME-065: installConsoleFilter keeps key material out of every console method', () => {
    assert(typeof logFilter.installConsoleFilter === 'function', 'installConsoleFilter not exported');
    const written: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved = methods.map(m => console[m]);
    try {
      for (const m of methods) (console as any)[m] = (...a: unknown[]) => { written.push(`${m}:${a.map(String).join(' ')}`); };
      logFilter.installConsoleFilter();
      console.info('Removing old closed session:', entry);
      console.info('Closing session:', entry);
      console.warn('Session already closed', entry);
      console.log('dump', { currentRatchet: { rootKey: Buffer.alloc(32) } });
      console.error('fine to print');
      assert(written.length === 1 && written[0] === 'error:fine to print', `unexpected console output: ${written.length} lines`);
    } finally {
      methods.forEach((m, i) => { (console as any)[m] = saved[i]; });
    }
  });

  console.log('\nwa_sessions encryption');

  const cryptoMod: Record<string, any> = await import('../src/crypto').catch(() => ({}));
  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);
  await check('N05', 'Regression ME-065: encryptColumn round-trips with a versioned prefix and hides the plaintext', () => {
    assert(typeof cryptoMod.encryptColumn === 'function', 'encryptColumn not exported');
    process.env.DB_ENCRYPTION_KEY = KEY_A;
    const plain = JSON.stringify({ noiseKey: { private: 'secret-material' } });
    const enc = cryptoMod.encryptColumn(plain, 'wa_sessions:1:creds');
    assert(enc.startsWith('enc:v1:'), 'missing enc:v1: prefix');
    assert(!enc.includes('secret-material'), 'plaintext visible in ciphertext');
    assert(enc !== cryptoMod.encryptColumn(plain, 'wa_sessions:1:creds'), 'IV reused');
    assert(cryptoMod.decryptColumn(enc, 'wa_sessions:1:creds') === plain, 'round-trip mismatch');
  });

  await check('N06', 'Regression ME-065: legacy plaintext values are read unchanged', () => {
    process.env.DB_ENCRYPTION_KEY = KEY_A;
    assert(cryptoMod.decryptColumn('{"noiseKey":1}', 'wa_sessions:1:creds') === '{"noiseKey":1}', 'legacy plaintext altered');
  });

  await check('N07', 'Regression ME-065: a wrong key, another row\'s AAD or a tampered value fails to decrypt', () => {
    process.env.DB_ENCRYPTION_KEY = KEY_A;
    const enc = cryptoMod.encryptColumn('payload', 'wa_sessions:1:keys');
    const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
    assert(throws(() => cryptoMod.decryptColumn(enc, 'wa_sessions:2:keys')), 'ciphertext accepted under another user\'s AAD');
    const flipped = enc.slice(0, -2) + (enc.slice(-2) === 'AA' ? 'BB' : 'AA');
    assert(throws(() => cryptoMod.decryptColumn(flipped, 'wa_sessions:1:keys')), 'tampered ciphertext accepted');
    process.env.DB_ENCRYPTION_KEY = KEY_B;
    assert(throws(() => cryptoMod.decryptColumn(enc, 'wa_sessions:1:keys')), 'decrypted with the wrong key');
  });

  await check('N08', 'Regression ME-065: production refuses to start without DB_ENCRYPTION_KEY', () => {
    assert(typeof cryptoMod.assertEncryptionKey === 'function', 'assertEncryptionKey not exported');
    const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
    try {
      process.env.DB_ENCRYPTION_KEY = KEY_A;
      assert(!throws(() => cryptoMod.assertEncryptionKey()), 'a valid key was refused');
      delete process.env.DB_ENCRYPTION_KEY;
      process.env.NODE_ENV = 'production';
      assert(throws(() => cryptoMod.assertEncryptionKey()), 'no key accepted in production');
      process.env.DB_ENCRYPTION_KEY = 'not-hex';
      assert(throws(() => cryptoMod.assertEncryptionKey()), 'malformed key accepted');
    } finally {
      delete process.env.NODE_ENV;
      delete process.env.DB_ENCRYPTION_KEY;
    }
  });

  await check('N09', 'Regression ME-065: the server exits non-zero at startup in production without a valid key', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, '..', 'src', 'index.ts')], {
      env: { ...process.env, NODE_ENV: 'production', DB_ENCRYPTION_KEY: 'not-a-key', DB_PATH: path.join(TMP_DIR, 'startup.db'), PORT: '0', LOG_LEVEL: 'silent' },
      timeout: 30_000,
      encoding: 'utf8',
    });
    assert(r.status === 1, `expected exit 1, got status ${r.status} signal ${r.signal}`);
  });

  console.log('\nPublic release safety (WAY-58)');

  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  // Regression WAY-58: signup was open to any email, so a stranger who found an
  // instance (its URL ends every reply) could link a WhatsApp and spend the host's Groq quota.
  await check('A01', 'Regression WAY-58: production with no ALLOWED_EMAILS admits only ADMIN_EMAIL', () => withEnv(
    { NODE_ENV: 'production', ALLOWED_EMAILS: undefined, ADMIN_EMAIL: 'Owner@Example.org' }, () => {
      assert(!auth.isEmailAllowed('stranger@example.org'), 'a stranger was allowed with no allowlist');
      assert(auth.isEmailAllowed('owner@example.org'), 'ADMIN_EMAIL (case-insensitive) was refused');
    }));
  await check('A02', 'Regression WAY-58: ALLOWED_EMAILS list is case-insensitive; * opens signup; dev without a list stays open', async () => {
    await withEnv({ NODE_ENV: 'production', ALLOWED_EMAILS: ' A@Example.org , b@example.org', ADMIN_EMAIL: undefined }, () => {
      assert(auth.isEmailAllowed('a@example.org') && auth.isEmailAllowed('B@example.org'), 'listed address refused');
      assert(!auth.isEmailAllowed('c@example.org'), 'unlisted address allowed');
    });
    await withEnv({ NODE_ENV: 'production', ALLOWED_EMAILS: '*' }, () => {
      assert(auth.isEmailAllowed('anyone@example.org'), '* did not open signup');
    });
    await withEnv({ NODE_ENV: undefined, ALLOWED_EMAILS: undefined }, () => {
      assert(auth.isEmailAllowed('dev@example.org'), 'dev without ALLOWED_EMAILS should stay open');
    });
  });
  await check('A03', 'Regression WAY-58: POST /auth/login for an unlisted email in production → 403, no email sent', () => withEnv(
    { NODE_ENV: 'production', ALLOWED_EMAILS: 'listed@eval.local', ADMIN_EMAIL: undefined }, async () => {
      resetLoginLimits();
      const before = sentEmails.length;
      const res = await login('unlisted@eval.local', { 'X-Real-IP': '192.0.2.200' });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      assert(sentEmails.length === before, 'a login email was sent to an unlisted address');
      const ok = await login('listed@eval.local', { 'X-Real-IP': '192.0.2.201' });
      assert(ok.status === 200, `listed address got ${ok.status}`);
      resetLoginLimits();
    }));

  // Regression WAY-58: a forged CF-Connecting-IP header picked the per-IP rate-limit bucket.
  await check('A04', 'Regression WAY-58: CF-Connecting-IP from the client cannot dodge the per-IP limit', async () => {
    resetLoginLimits();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await login(`spoof-${i}@eval.local`, { 'X-Real-IP': '198.51.100.99', 'CF-Connecting-IP': `203.0.113.${i + 1}` })).status);
    }
    assert(codes[10] === 429, `11th request from one X-Real-IP with rotating CF-Connecting-IP got ${codes[10]}`);
    resetLoginLimits();
  });

  await check('A05', 'Regression WAY-58: production without BASE_URL exits at startup', () => {
    const { spawnSync } = require('node:child_process');
    const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'production', DB_ENCRYPTION_KEY: 'a'.repeat(64), DB_PATH: path.join(TMP_DIR, 'startup-baseurl.db'), PORT: '0', LOG_LEVEL: 'silent' };
    delete env.BASE_URL;
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, '..', 'src', 'index.ts')], { env, timeout: 30_000, encoding: 'utf8' });
    assert(r.status === 1, `expected exit 1, got status ${r.status} signal ${r.signal}`);
  });

  // Regression WAY-58: admin delete removed the row but left the WhatsApp socket transcribing.
  await check('A06', 'Regression WAY-58: admin delete disconnects WhatsApp before deleting the user', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes.ts'), 'utf8');
    const route = src.slice(src.indexOf("router.delete('/api/admin/users/:id'"));
    const disconnectAt = route.indexOf('await disconnectWhatsApp(id)');
    const deleteAt = route.indexOf('DELETE FROM users');
    assert(disconnectAt > 0 && disconnectAt < deleteAt, 'disconnectWhatsApp must run before the users row is deleted');
  });

  // Regression WAY-58: the dashboard named one specific operator's bot.
  await check('A07', 'Regression WAY-58: the dashboard names the instance\'s own Telegram bot, never a hardcoded handle', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.html'), 'utf8');
    assert(!/@[A-Za-z0-9_]{5,}_?[Bb]ot\b/.test(html), 'a hardcoded @…bot handle is in dashboard.html');
    assert(html.includes('botUsername'), 'dashboard does not read botUsername from /api/telegram/token');
  });

  console.log('\nWhatsApp connect limits');

  const wa: Record<string, any> = await import('../src/whatsapp');
  await check('P01', 'Regression ME-065: throwaway accounts exhausting new pairings cannot block a linked account\'s reconnect', () => {
    assert(typeof wa.__checkConnectRateLimit === 'function', '__checkConnectRateLimit not exported');
    wa.__resetConnectRateLimits();
    const linked = auth.getOrCreateUser('linked@eval.local');
    db.prepare('INSERT OR REPLACE INTO wa_sessions (user_id, creds_json, keys_json) VALUES (?, ?, ?)').run(
      linked,
      cryptoMod.encryptColumn(JSON.stringify({ me: { id: '31600000001:1@s.whatsapp.net' } }), cryptoMod.waSessionAad(linked, 'creds')),
      null
    );
    for (let i = 0; i < 12; i++) {
      const throwaway = auth.getOrCreateUser(`throwaway-${i}@eval.local`);
      const r = wa.__checkConnectRateLimit(throwaway);
      if (r.ok) wa.__recordConnectAttempt(throwaway, r.bucket);
    }
    const blocked = wa.__checkConnectRateLimit(auth.getOrCreateUser('throwaway-99@eval.local'));
    assert(!blocked.ok && blocked.reason === 'global_limit', 'pairing bucket did not fill up');
    const r = wa.__checkConnectRateLimit(linked);
    assert(r.ok && r.bucket === 'reconnect', `linked account blocked: ${JSON.stringify(r)}`);
  });

  await check('P03', 'Regression ME-065: a legacy plaintext linked row (deploy day) counts as linked → reconnect bucket', () => {
    wa.__resetConnectRateLimits();
    const legacy = auth.getOrCreateUser('legacy-linked@eval.local');
    db.prepare('INSERT OR REPLACE INTO wa_sessions (user_id, creds_json, keys_json) VALUES (?, ?, ?)').run(
      legacy, JSON.stringify({ me: { id: '31600000002:1@s.whatsapp.net' } }), null
    );
    const r = wa.__checkConnectRateLimit(legacy);
    assert(r.ok && r.bucket === 'reconnect', `legacy linked row not treated as linked: ${JSON.stringify(r)}`);
  });

  await check('P02', 'Regression ME-065: one unpaired account is capped on its own (6 attempts per 10 min)', () => {
    wa.__resetConnectRateLimits();
    const u = auth.getOrCreateUser('one-account@eval.local');
    const realNow = Date.now;
    let t = realNow();
    try {
      Date.now = () => t;
      for (let i = 0; i < 6; i++) {
        const r = wa.__checkConnectRateLimit(u);
        assert(r.ok, `attempt ${i + 1} refused: ${JSON.stringify(r)}`);
        wa.__recordConnectAttempt(u, r.bucket);
        t += 61_000; // past the 10 s per-user spacing and the 60 s global window
      }
      const r = wa.__checkConnectRateLimit(u);
      assert(!r.ok && r.reason === 'pairing_limit', `7th pairing attempt within 10 min not refused as pairing_limit: ${JSON.stringify(r)}`);
    } finally {
      Date.now = realNow;
      wa.__resetConnectRateLimits();
    }
  });

  console.log('\nTranscription retention');

  // Regression ME-065: transcription rows kept the sender's JID and display name
  // forever. Approved policy: full rows for 90 days, then from_name → NULL and
  // from_jid → a salted hash; usage fields stay. Runs on an in-memory DB.
  const ret: Record<string, any> = await import('../src/retention').catch(() => ({}));
  const { DatabaseSync } = await import('node:sqlite');
  const dbMod: Record<string, any> = await import('../src/db');
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString().replace('T', ' ').slice(0, 19);
  const freshRetentionDb = () => {
    const mem = new DatabaseSync(':memory:');
    mem.exec('PRAGMA foreign_keys = ON');
    dbMod.initSchema(mem);
    mem.prepare("INSERT INTO users (id, email) VALUES (1, 'a@eval.local'), (2, 'b@eval.local')").run();
    return mem;
  };
  const insertTx = (mem: any, userId: number, jid: string, name: string | null, days: number) =>
    Number(mem.prepare(
      `INSERT INTO transcriptions (user_id, from_jid, from_name, duration_s, language, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, 12.5, 'de', 100, 40, ?)`
    ).run(userId, jid, name, ago(days)).lastInsertRowid);
  const rowOf = (mem: any, id: number) => mem.prepare('SELECT * FROM transcriptions WHERE id = ?').get(id) as any;
  const withRetention = (fn: (mem: any) => void) => {
    assert(typeof ret.anonymizeOldTranscriptions === 'function', 'src/retention.ts anonymizeOldTranscriptions not exported');
    assert(typeof dbMod.initSchema === 'function', 'initSchema not exported from src/db');
    process.env.DB_ENCRYPTION_KEY = KEY_A;
    ret.__resetAnonKey();
    const mem = freshRetentionDb();
    try { fn(mem); } finally { mem.close(); delete process.env.DB_ENCRYPTION_KEY; ret.__resetAnonKey(); }
  };

  await check('T01', 'Regression ME-065: a row 89 days old keeps its JID and name', () => withRetention(mem => {
    const id = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Alice', 89);
    ret.anonymizeOldTranscriptions(mem, { now: NOW });
    const r = rowOf(mem, id);
    assert(r.from_jid === '4915112345678@s.whatsapp.net' && r.from_name === 'Alice', 'row inside the 90-day window was changed');
  }));

  await check('T02', 'Regression ME-065: a row 91 days old is anonymised; duration, language, tokens and timestamp stay', () => withRetention(mem => {
    const id = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Alice', 91);
    const before = rowOf(mem, id);
    const res = ret.anonymizeOldTranscriptions(mem, { now: NOW });
    const r = rowOf(mem, id);
    assert(res.anonymized === 1, `expected 1 anonymised, got ${res.anonymized}`);
    assert(r.from_name === null, 'from_name not cleared');
    assert(/^anon:[0-9a-f]{32}$/.test(r.from_jid), `from_jid not an anon hash`);
    assert(!r.from_jid.includes('4915112345678'), 'raw number survives in from_jid');
    for (const k of ['duration_s', 'language', 'input_tokens', 'output_tokens', 'created_at', 'user_id']) {
      assert(r[k] === before[k], `${k} changed`);
    }
  }));

  await check('T03', 'Regression ME-065: already anonymised rows are not re-hashed or counted', () => withRetention(mem => {
    const id = insertTx(mem, 1, 'anon:0123456789abcdef0123456789abcdef', null, 200);
    const res = ret.anonymizeOldTranscriptions(mem, { now: NOW });
    assert(res.candidates === 0 && res.anonymized === 0, `already anonymised row counted: ${JSON.stringify(res)}`);
    assert(rowOf(mem, id).from_jid === 'anon:0123456789abcdef0123456789abcdef', 'anon value re-hashed');
    assert(ret.anonymizeJid('anon:abc') === 'anon:abc', 'anonymizeJid is not idempotent');
    const second = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Alice', 100);
    ret.anonymizeOldTranscriptions(mem, { now: NOW });
    const once = rowOf(mem, second).from_jid;
    const again = ret.anonymizeOldTranscriptions(mem, { now: NOW });
    assert(again.candidates === 0 && rowOf(mem, second).from_jid === once, 'second run changed an anonymised row');
  }));

  await check('T04', 'Regression ME-065: the same JID always gets the same hash, so per-sender stats still group', () => withRetention(mem => {
    const a = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Alice', 120);
    const b = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Ali', 95);
    const c = insertTx(mem, 1, '4915112345678:12@s.whatsapp.net', null, 95); // same person, linked device
    ret.anonymizeOldTranscriptions(mem, { now: NOW });
    const h = rowOf(mem, a).from_jid;
    assert(rowOf(mem, b).from_jid === h && rowOf(mem, c).from_jid === h, 'same sender produced different hashes');
    const groups = mem.prepare('SELECT COUNT(DISTINCT from_jid) n FROM transcriptions').get() as any;
    assert(groups.n === 1, `expected 1 sender group, got ${groups.n}`);
    ret.__resetAnonKey();
    assert(ret.anonymizeJid('4915112345678@s.whatsapp.net') === h, 'hash not stable across key reloads');
  }));

  await check('T05', 'Regression ME-065: different JIDs get different hashes; the hash is keyed by DB_ENCRYPTION_KEY', () => withRetention(mem => {
    const a = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Alice', 120);
    const b = insertTx(mem, 1, '4915112345679@s.whatsapp.net', 'Bob', 120);
    const g = insertTx(mem, 1, '123456789012345@lid', 'Carol', 120);
    ret.anonymizeOldTranscriptions(mem, { now: NOW });
    const hs = [a, b, g].map(id => rowOf(mem, id).from_jid);
    assert(new Set(hs).size === 3, 'distinct senders collided');
    process.env.DB_ENCRYPTION_KEY = KEY_B;
    ret.__resetAnonKey();
    assert(ret.anonymizeJid('4915112345678@s.whatsapp.net') !== hs[0], 'hash does not depend on the secret (plain SHA-256 is reversible by enumerating numbers)');
  }));

  await check('T06', 'Regression ME-065: a NULL name stays NULL and the row is still anonymised', () => withRetention(mem => {
    const id = insertTx(mem, 1, '4915112345678@s.whatsapp.net', null, 91);
    ret.anonymizeOldTranscriptions(mem, { now: NOW });
    const r = rowOf(mem, id);
    assert(r.from_name === null && r.from_jid.startsWith('anon:'), 'NULL-name row not handled');
  }));

  await check('T07', 'Regression ME-065: dry run counts what it would change and writes nothing', () => withRetention(mem => {
    const old = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Alice', 91);
    insertTx(mem, 1, '4915112345679@s.whatsapp.net', 'Bob', 10);
    const res = ret.anonymizeOldTranscriptions(mem, { now: NOW, dryRun: true });
    assert(res.dryRun && res.candidates === 1 && res.anonymized === 0, `unexpected dry-run result ${JSON.stringify(res)}`);
    assert(rowOf(mem, old).from_name === 'Alice', 'dry run wrote to the DB');
  }));

  await check('T08', 'Regression ME-065: account deletion still cascades over anonymised rows', () => withRetention(mem => {
    insertTx(mem, 2, '4915112345678@s.whatsapp.net', 'Alice', 120);
    insertTx(mem, 2, '4915112345678@s.whatsapp.net', 'Alice', 5);
    ret.anonymizeOldTranscriptions(mem, { now: NOW });
    mem.prepare('DELETE FROM users WHERE id = 2').run();
    const n = (mem.prepare('SELECT COUNT(*) n FROM transcriptions WHERE user_id = 2').get() as any).n;
    assert(n === 0, `${n} rows survived account deletion`);
  }));

  await check('T09', 'Regression ME-065: the daily run fires at 04:15 Berlin in summer and winter time', () => {
    assert(typeof ret.berlinClock === 'function', 'berlinClock not exported');
    const summer = ret.berlinClock(Date.UTC(2026, 9, 6, 2, 15)); // CEST, UTC+2
    const winter = ret.berlinClock(Date.UTC(2026, 11, 1, 3, 15)); // CET, UTC+1
    assert(summer.hour === 4 && summer.minute === 15 && summer.date === '2026-10-06', `summer: ${JSON.stringify(summer)}`);
    assert(winter.hour === 4 && winter.minute === 15 && winter.date === '2026-12-01', `winter: ${JSON.stringify(winter)}`);
    assert(ret.RUN_AT_BERLIN?.hour === 4 && ret.RUN_AT_BERLIN?.minute === 15, 'schedule is not 04:15');
  });

  await check('T10', 'Regression ME-065: the 90-day cutoff is exact to the hour (UTC, SQLite datetime format)', () => withRetention(mem => {
    const inside = insertTx(mem, 1, '4915112345678@s.whatsapp.net', 'Alice', 90 - 1 / 24);
    const outside = insertTx(mem, 1, '4915112345679@s.whatsapp.net', 'Bob', 90 + 1 / 24);
    const res = ret.anonymizeOldTranscriptions(mem, { now: NOW });
    assert(res.anonymized === 1, `expected exactly 1 row past the cutoff, got ${res.anonymized}`);
    assert(rowOf(mem, inside).from_name === 'Alice', 'row 1 h inside the window was anonymised');
    assert(rowOf(mem, outside).from_name === null, 'row 1 h past the window was kept');
  }));

  await check('T11', 'Regression ME-065: an already hashed row that still has a name gets the name cleared, hash unchanged', () => withRetention(mem => {
    const id = insertTx(mem, 1, 'anon:0123456789abcdef0123456789abcdef', 'Leftover', 120);
    ret.anonymizeOldTranscriptions(mem, { now: NOW });
    const r = rowOf(mem, id);
    assert(r.from_name === null, 'name next to a hash survived');
    assert(r.from_jid === 'anon:0123456789abcdef0123456789abcdef', 'hash was re-hashed');
  }));

  await check('T12', 'Regression ME-065: the scheduler fires once at 04:15 Berlin per day, across DST changes', () => {
    assert(typeof ret.shouldRunRetention === 'function', 'shouldRunRetention not exported');
    const at = (iso: string) => Date.parse(iso);
    // 2026-10-06 is CEST (UTC+2): 04:15 Berlin = 02:15Z
    assert(ret.shouldRunRetention(at('2026-10-06T02:15:10Z'), null), 'did not fire at 04:15:10');
    assert(!ret.shouldRunRetention(at('2026-10-06T02:14:59Z'), null), 'fired at 04:14');
    assert(!ret.shouldRunRetention(at('2026-10-06T02:16:00Z'), null), 'fired at 04:16');
    assert(!ret.shouldRunRetention(at('2026-10-06T02:15:40Z'), '2026-10-06'), 'fired twice on one day');
    assert(ret.shouldRunRetention(at('2026-10-07T02:15:00Z'), '2026-10-06'), 'did not fire the next day');
    // Day of the autumn change (2026-10-25, CET from 03:00): 04:15 Berlin = 03:15Z
    assert(ret.shouldRunRetention(at('2026-10-25T03:15:00Z'), '2026-10-24'), 'missed 04:15 on the autumn DST day');
    assert(!ret.shouldRunRetention(at('2026-10-25T02:15:00Z'), '2026-10-24'), 'fired at 03:15 on the autumn DST day');
    // Day of the spring change (2027-03-28, CEST from 03:00): 04:15 Berlin = 02:15Z
    assert(ret.shouldRunRetention(at('2027-03-28T02:15:00Z'), '2027-03-27'), 'missed 04:15 on the spring DST day');
    assert(!ret.shouldRunRetention(at('2027-03-28T03:15:00Z'), '2027-03-27'), 'fired at 05:15 on the spring DST day');
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    assert(/^\s*scheduleDailyRetention\(getDb\);/m.test(indexSrc), 'src/index.ts does not start the daily retention schedule');
  });

  await check('T13', 'Regression ME-065: pseudonymised names and numbers do not linger in the DB file or WAL', () => {
    process.env.DB_ENCRYPTION_KEY = KEY_A;
    ret.__resetAnonKey();
    try {
      // The app's own connection (getDb), file-backed and in WAL mode like production.
      const owner = auth.getOrCreateUser('retention-file@eval.local');
      const ins = db.prepare(
        `INSERT INTO transcriptions (user_id, from_jid, from_name, duration_s, created_at) VALUES (?, ?, ?, 3, ?)`
      );
      for (let i = 0; i < 50; i++) {
        ins.run(owner, `49170000${String(i).padStart(4, '0')}@s.whatsapp.net`, `LingerName${String(i).padStart(3, '0')}`, ago(120));
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const res = ret.anonymizeOldTranscriptions(db, { now: NOW });
      assert(res.anonymized >= 50, `expected ≥50 rows rewritten, got ${res.anonymized}`);
      const dbPath = process.env.DB_PATH!;
      const bytes = Buffer.concat(
        [dbPath, `${dbPath}-wal`].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f))
      ).toString('latin1');
      const names = (bytes.match(/LingerName\d{3}/g) ?? []).length;
      const jids = (bytes.match(/49170000\d{4}@s\.whatsapp\.net/g) ?? []).length;
      assert(names === 0 && jids === 0, `${names} names and ${jids} JIDs still readable in the DB file`);
    } finally {
      delete process.env.DB_ENCRYPTION_KEY;
      ret.__resetAnonKey();
    }
  });

  await check('T14', 'Regression ME-065: the CLI dry-runs by default and --apply refuses without DB_ENCRYPTION_KEY', () => {
    const { spawnSync } = require('node:child_process');
    const cliDb = path.join(TMP_DIR, 'cli.db');
    const cli = path.join(__dirname, '..', 'src', 'retention-cli.ts');
    const env = { ...process.env, DB_PATH: cliDb, DB_ENCRYPTION_KEY: '', LOG_LEVEL: 'silent' };
    delete (env as any).NODE_ENV;
    {
      const mem = new DatabaseSync(cliDb);
      dbMod.initSchema(mem);
      mem.prepare("INSERT INTO users (id, email) VALUES (1, 'cli@eval.local')").run();
      mem.prepare(
        `INSERT INTO transcriptions (user_id, from_jid, from_name, created_at) VALUES (1, '4915112345678@s.whatsapp.net', 'Alice', datetime('now', '-120 days'))`
      ).run();
      mem.close();
    }
    const dry = spawnSync(process.execPath, ['--import', 'tsx', cli], { env, encoding: 'utf8', timeout: 30_000 });
    assert(dry.status === 0, `dry run exited ${dry.status}`);
    const out = JSON.parse(dry.stdout.trim().split('\n').pop()!);
    assert(out.dryRun === true && out.candidates === 1 && out.anonymized === 0, `unexpected dry-run output ${dry.stdout}`);
    assert(!dry.stdout.includes('4915112345678') && !dry.stdout.includes('Alice'), 'CLI printed personal data');
    const refused = spawnSync(process.execPath, ['--import', 'tsx', cli, '--apply'], { env, encoding: 'utf8', timeout: 30_000 });
    assert(refused.status === 1, `--apply without a key exited ${refused.status}`);
    const check = new DatabaseSync(cliDb);
    const row = check.prepare('SELECT from_name FROM transcriptions').get() as any;
    check.close();
    assert(row.from_name === 'Alice', 'a refused or dry run still wrote to the DB');
  });

  server.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.error('\nFailures:\n' + failures.map(f => '  ' + f).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
