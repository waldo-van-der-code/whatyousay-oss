import crypto from 'node:crypto';
import { Bot, Context } from 'grammy';
import { runPipeline, PipelineError } from './pipeline';
import { getUserSettings } from './auth';
import { getDb } from './db';
import { logger } from './logger';
import { emitToUser } from './sse';

const APP_URL = process.env.BASE_URL ?? 'http://localhost:3000';

interface TelegramGroup {
  chat_id: string;
  user_id: number;
  chat_title: string | null;
  created_at: string;
}

// ── Webhook secret (ME-065) ───────────────────────────────────────────────────
//
// Telegram echoes the secret_token given to setWebhook in the
// X-Telegram-Bot-Api-Secret-Token header of every update. Without it the webhook URL
// is the only credential, and the URL is public: anyone could POST a forged update.

const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/; // Telegram allows 1-256 of these

/**
 * TELEGRAM_WEBHOOK_SECRET if set and valid; otherwise derived from the bot token, so a
 * deploy that forgets the env var still authenticates instead of failing open or
 * rejecting every real update. null only when there is no bot at all.
 */
let _secretCache: { key: string; secret: string | null; source: 'env' | 'derived' | 'none' } | null = null;

function resolveWebhookSecret(): { secret: string | null; source: 'env' | 'derived' | 'none' } {
  const configured = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  const botToken = process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN ?? '';
  // Runs on every webhook request: cache per (env, token) so a bad value logs once.
  const key = `${configured}\0${botToken}`; // in-memory only, never logged
  if (_secretCache?.key === key) return _secretCache;
  let resolved: { secret: string | null; source: 'env' | 'derived' | 'none' };
  if (configured && WEBHOOK_SECRET_RE.test(configured)) {
    resolved = { secret: configured, source: 'env' };
  } else {
    if (configured) {
      logger.error({ event: 'telegram.webhook_secret_invalid', reason: 'must be 16-256 chars of A-Z a-z 0-9 _ -; falling back to derived secret' });
    }
    resolved = botToken
      ? { secret: crypto.createHmac('sha256', botToken).update('whatyousay-telegram-webhook-secret').digest('hex'), source: 'derived' }
      : { secret: null, source: 'none' };
  }
  _secretCache = { key, ...resolved };
  return resolved;
}

export function getWebhookSecret(): string | null {
  return resolveWebhookSecret().secret;
}

/** Constant-time check of the X-Telegram-Bot-Api-Secret-Token header. */
export function verifyWebhookSecret(header: string | undefined): boolean {
  const expected = getWebhookSecret();
  if (!expected || typeof header !== 'string' || !header) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers whatever was sent.
  const a = crypto.createHash('sha256').update(header).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── DB helpers (exported for use in routes.ts) ────────────────────────────────

// Link codes are bearer credentials: whoever sends one to the bot attaches their
// Telegram account or group to that WhatYouSay account. 128 bits, single use.
const LINK_CODE_RE = /^[0-9A-F]{32,}$/;

function newLinkCode(): string {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

export function getOrCreatePersonalToken(userId: number): string {
  const db = getDb();
  const row = db.prepare('SELECT token FROM telegram_tokens WHERE user_id = ?').get(userId) as unknown as { token: string } | undefined;
  if (row && LINK_CODE_RE.test(row.token)) return row.token;
  const token = newLinkCode();
  if (row) {
    // Pre-ME-065 codes were 32-bit. Replace in place: telegram_user_id and linked
    // groups are untouched, so nothing already linked stops working.
    db.prepare('UPDATE telegram_tokens SET token = ? WHERE user_id = ?').run(token, userId);
  } else {
    db.prepare('INSERT INTO telegram_tokens (user_id, token) VALUES (?, ?)').run(userId, token);
  }
  return token;
}

/** Replace a user's link code — after it was used, or after it was posted somewhere public. */
function rotateLinkCode(userId: number): void {
  getDb().prepare('UPDATE telegram_tokens SET token = ? WHERE user_id = ?').run(newLinkCode(), userId);
}

function getTelegramUserId(userId: number): number | null {
  const row = getDb()
    .prepare('SELECT telegram_user_id FROM telegram_tokens WHERE user_id = ?')
    .get(userId) as unknown as { telegram_user_id: number | null } | null;
  return row?.telegram_user_id ?? null;
}

export function listLinkedGroups(userId: number): TelegramGroup[] {
  return getDb()
    .prepare('SELECT * FROM telegram_groups WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as unknown as TelegramGroup[];
}

export function removeLinkedGroup(userId: number, chatId: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM telegram_groups WHERE chat_id = ? AND user_id = ?')
    .run(chatId, userId);
  return result.changes > 0;
}

export function lookupToken(token: string): number | null {
  if (!LINK_CODE_RE.test(token)) return null; // also refuses legacy 8-char codes
  const row = getDb()
    .prepare('SELECT user_id FROM telegram_tokens WHERE token = ?')
    .get(token) as unknown as { user_id: number } | null;
  return row?.user_id ?? null;
}

function getLinkedGroup(chatId: string): TelegramGroup | null {
  return (
    (getDb()
      .prepare('SELECT * FROM telegram_groups WHERE chat_id = ?')
      .get(chatId) as unknown as TelegramGroup | undefined) ?? null
  );
}

function getUserByTelegramId(telegramUserId: number): number | null {
  const row = getDb()
    .prepare('SELECT user_id FROM telegram_tokens WHERE telegram_user_id = ?')
    .get(telegramUserId) as unknown as { user_id: number } | null;
  return row?.user_id ?? null;
}

// ── Bot ───────────────────────────────────────────────────────────────────────

let _bot: Bot | null = null;

/** The running bot's @username, shown in the dashboard; null until the bot has initialised. */
export function getBotUsername(): string | null {
  return _bot?.isInited() ? _bot.botInfo.username : null;
}

export function getTelegramBot(): Bot | null {
  return _bot;
}

export async function sendToUserDm(userId: number, text: string, bot: Bot | null = _bot): Promise<boolean> {
  if (!bot) return false;
  const tgUserId = getTelegramUserId(userId);
  if (!tgUserId) return false;
  try {
    await bot.api.sendMessage(tgUserId, text);
    return true;
  } catch (err) {
    logger.error({ event: 'telegram.dm_error', userId, errName: (err as Error)?.name });
    return false;
  }
}

/**
 * Group commands that change which account a group belongs to are limited to the
 * group's admins — otherwise any member holding any valid code could take a group
 * over, or switch transcription off for everyone.
 */
async function senderIsChatAdmin(ctx: Context): Promise<boolean> {
  const chat = ctx.chat;
  if (!chat) return false;
  if (chat.type === 'private') return true;
  // Anonymous group admins post as the group itself; channel posts come from admins only.
  if (ctx.msg?.sender_chat?.id === chat.id) return true;
  if (!ctx.from) return false;
  try {
    const member = await ctx.api.getChatMember(chat.id, ctx.from.id);
    return member.status === 'creator' || member.status === 'administrator';
  } catch (err) {
    logger.warn({ event: 'telegram.admin_check_failed', chatId: String(chat.id), errName: (err as Error)?.name });
    return false;
  }
}

const CODE_USED_NOTE = `Each link code works once, so this one has been replaced. To link another group, copy the new code from ${APP_URL}`;

/** Build the bot and register its handlers. No network calls — see configureWebhook. */
export function createTelegramBot(botToken: string): Bot {
  const bot = new Bot(botToken);

  bot.catch(err => {
    logger.error({
      event: 'telegram.handler_error',
      errName: (err.error as Error)?.name,
      errMsg: (err.error as Error)?.message,
      updateId: err.ctx?.update?.update_id,
    });
  });

  // Temporary catch-all for debugging: log every update received
  bot.use(async (ctx, next) => {
    logger.info({ event: 'telegram.update', type: Object.keys(ctx.update).find(k => k !== 'update_id'), updateId: ctx.update.update_id });
    await next();
  });

  bot.command(['start', 'help'], async ctx => {
    const isPrivate = ctx.chat.type === 'private';
    if (isPrivate) {
      await ctx.reply(
        `👋 *WhatYouSay* transcribes voice notes.\n\n` +
        `*Option 1 — Direct messages (easiest):*\n` +
        `Link once here, then forward any voice note to me and I'll reply with the transcript.\n\n` +
        `*Option 2 — Auto-transcribe a group:*\n` +
        `Add me to a group, make me admin (Read Messages), then run /link <code> there.\n\n` +
        `Get your link code at ${APP_URL}`,
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(
        `👋 *WhatYouSay* transcribes voice notes in this group.\n\n` +
        `Run /link <your code> to activate. Get your code at ${APP_URL}`,
        { parse_mode: 'Markdown' },
      );
    }
  });

  bot.command('link', async ctx => {
    const token = (ctx.match ?? '').trim().toUpperCase();
    // Never log the code itself: it is a credential.
    logger.info({ event: 'telegram.link_received', hasCode: token.length > 0, chatType: ctx.chat.type, chatId: String(ctx.chat.id) });

    if (!token) {
      await ctx.reply(`Usage: /link <your code>\n\nFind your code at ${APP_URL}`);
      return;
    }

    const userId = lookupToken(token);
    if (!userId) {
      await ctx.reply(`❌ Code not recognised. Find your personal code at ${APP_URL}`);
      return;
    }

    if (ctx.chat.type !== 'private' && !(await senderIsChatAdmin(ctx))) {
      // Every member of the group has now seen this code, so it is burned either way.
      rotateLinkCode(userId);
      logger.warn({ event: 'telegram.link_denied_not_admin', chatId: String(ctx.chat.id), userId });
      await ctx.reply(
        `Only group admins can link this group.\n\n` +
        `Because your code was posted here it has been replaced. Get the new one at ${APP_URL}`,
      );
      return;
    }

    // Single use: the code has done its job.
    rotateLinkCode(userId);

    // Store the Telegram user ID so we can support DM forwarding + sent/received split.
    // Only from a private chat: the sender proves they hold the code, and only the code
    // owner's own DM may set where their voice notes are forwarded. In a group the
    // sender can be a group admin using someone else's code, and must not overwrite it.
    // Anonymous admins / channel posts are skipped too: their `from` is a Telegram service bot.
    const senderId = ctx.chat.type === 'private' && ctx.from && !ctx.from.is_bot && !ctx.msg?.sender_chat ? ctx.from.id : null;
    if (senderId !== null) {
      getDb()
        .prepare('UPDATE telegram_tokens SET telegram_user_id = ? WHERE user_id = ?')
        .run(senderId, userId);
    }

    // Private DM: just store the user ID — no group entry needed
    if (ctx.chat.type === 'private') {
      logger.info({ event: 'telegram.dm_linked', userId, telegramUserId: ctx.from?.id });
      await ctx.reply(
        '✅ Done! Forward any voice note to me here and I\'ll transcribe it.\n\n' +
        'You can forward from any group or chat — no group setup needed.\n\n' +
        CODE_USED_NOTE,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const chatId = String(ctx.chat.id);
    // Untrusted text chosen by whoever named the group. Stored raw; the dashboard
    // must render it with textContent, never innerHTML.
    const chatTitle = (
      ('title' in ctx.chat ? ctx.chat.title : undefined) ??
      ('username' in ctx.chat ? ctx.chat.username : undefined) ??
      'this chat'
    ).slice(0, 255);

    const previous = getLinkedGroup(chatId);
    getDb()
      .prepare('INSERT OR REPLACE INTO telegram_groups (chat_id, user_id, chat_title) VALUES (?, ?, ?)')
      .run(chatId, userId, chatTitle);

    const takenOver = previous !== null && previous.user_id !== userId;
    logger.info({ event: takenOver ? 'telegram.group_relinked' : 'telegram.linked', chatId, userId, previousUserId: takenOver ? previous.user_id : undefined });

    if (takenOver) {
      await sendToUserDm(
        previous.user_id,
        `A group admin re-linked the Telegram group "${chatTitle}" to another WhatYouSay account. ` +
        `Its voice notes are no longer transcribed with your settings.`,
        bot,
      );
    }

    // Check if the bot has admin access — without it, voice notes won't be delivered
    let replyMsg = takenOver
      ? '✅ Done! This group was previously linked to another WhatYouSay account; it now uses yours.'
      : '✅ Done! Voice notes in this group will now be transcribed using your WhatYouSay settings.';
    try {
      const me = await ctx.api.getMe();
      const member = await ctx.api.getChatMember(ctx.chat.id, me.id);
      if (member.status !== 'administrator') {
        replyMsg += '\n\n⚠️ *Action needed:* I don\'t have access to messages yet. '
          + 'Tap my name → Make Admin → enable only "Read Messages" → Save. '
          + 'Without this, voice notes won\'t reach me.';
      }
    } catch { /* non-fatal */ }

    replyMsg += '\n\n' + CODE_USED_NOTE;
    await ctx.reply(replyMsg, { parse_mode: 'Markdown' });
  });

  bot.command('unlink', async ctx => {
    const chatId = String(ctx.chat.id);
    if (!(await senderIsChatAdmin(ctx))) {
      await ctx.reply('Only group admins can unlink this group.');
      return;
    }
    const result = getDb().prepare('DELETE FROM telegram_groups WHERE chat_id = ?').run(chatId);
    if (result.changes > 0) {
      logger.info({ event: 'telegram.unlinked', chatId });
      await ctx.reply('👋 Unlinked. Transcriptions have stopped for this group.');
    } else {
      await ctx.reply("This group isn't linked to any account.");
    }
  });

  bot.on('message:voice', async ctx => {
    const chatId = String(ctx.chat.id);

    // Resolve which WhatYouSay user owns this chat (DM or group)
    let resolvedUserId: number | null = null;
    let isDm = false;
    if (ctx.chat.type === 'private') {
      resolvedUserId = ctx.from ? getUserByTelegramId(ctx.from.id) : null;
      isDm = true;
    } else {
      const group = getLinkedGroup(chatId);
      resolvedUserId = group?.user_id ?? null;
    }

    if (!resolvedUserId) {
      if (isDm) {
        await ctx.reply(
          `Link your account first — send /link <your code>\n\nGet your code at ${APP_URL}`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      } else {
        await ctx.reply(
          `This group isn't set up yet. Find your link code at ${APP_URL} and run /link <code> here.`,
          { reply_parameters: { message_id: ctx.message.message_id } },
        );
      }
      return;
    }

    const fileId = ctx.message.voice.file_id;
    const settings = getUserSettings(resolvedUserId) as ReturnType<typeof getUserSettings> & {
      telegram_transcribe_sent?: boolean;
      telegram_transcribe_received?: boolean;
    };

    // In DMs always transcribe; in groups respect sent/received toggles
    if (!isDm) {
      const tgUserId = getTelegramUserId(resolvedUserId);
      const isSent = tgUserId !== null && (ctx.from?.id ?? null) === tgUserId;
      const shouldTranscribe = isSent
        ? (settings.telegram_transcribe_sent ?? true)
        : (settings.telegram_transcribe_received ?? true);
      if (!shouldTranscribe) return;
    }

    let buffer: Buffer;
    try {
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ event: 'telegram.no_file_path', chatId });
        return;
      }
      const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      logger.error({ event: 'telegram.download_error', chatId, errName: (err as Error)?.name });
      return;
    }

    try {
      const result = await runPipeline(buffer, settings);

      await ctx.reply(result.replyText, {
        reply_parameters: { message_id: ctx.message.message_id },
        parse_mode: 'Markdown',
      });

      emitToUser(resolvedUserId, 'transcription', {
        id: 0,
        transcript: result.transcript,
        summary: result.summary ?? null,
      });

      logger.info({
        event: 'telegram.transcribed',
        chatId,
        userId: resolvedUserId,
        isDm,
        duration: result.duration,
        language: result.language,
      });
    } catch (err) {
      const step = err instanceof PipelineError ? err.step : 'unknown';
      logger.error({ event: 'telegram.pipeline_error', chatId, step, errName: (err as Error)?.name });
    }
  });

  return bot;
}

/** Register the webhook with Telegram, including the secret it must echo back. */
export async function configureWebhook(bot: Bot): Promise<void> {
  const { secret, source } = resolveWebhookSecret();
  if (!secret) throw new Error('no webhook secret available');
  const webhookUrl = `${APP_URL}/telegram/webhook`;
  await bot.api.setWebhook(webhookUrl, { drop_pending_updates: false, secret_token: secret });
  logger.info({ event: 'telegram.webhook_set', username: bot.botInfo?.username, url: webhookUrl, secretSource: source });
}

/**
 * Since ME-065 the route rejects updates without the secret, so a failed setWebhook
 * would leave Telegram on the old registration and every update would bounce with 401.
 * Retry with backoff rather than giving up after one transient failure.
 */
async function configureWebhookWithRetry(bot: Bot, attempts = 6): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      // botInfo is required by handleUpdate() in webhook mode; retried with the webhook.
      if (!bot.isInited()) await bot.init();
      await configureWebhook(bot);
      return;
    } catch (err) {
      logger.error({ event: 'telegram.webhook_error', attempt: i, errName: (err as Error)?.name, errMsg: (err as Error)?.message });
      if (i >= attempts) throw err;
      await new Promise(r => setTimeout(r, Math.min(60_000, 2_000 * 2 ** (i - 1))));
    }
  }
}

export async function startTelegramBot(): Promise<void> {
  const botToken = process.env.TELEGRAM_WHATYOUSAY_BOT_TOKEN;
  if (!botToken) {
    logger.info({ event: 'telegram.skip', reason: 'TELEGRAM_WHATYOUSAY_BOT_TOKEN not set' });
    return;
  }
  if (_bot) {
    logger.info({ event: 'telegram.skip', reason: 'already initialised in this process' });
    return;
  }

  // Registering the webhook points Telegram at BASE_URL for every instance sharing this
  // bot token, so a local run with a production bot token would steal the webhook (and
  // register a secret production does not know). Only a deployment with BASE_URL set registers.
  if (!process.env.BASE_URL) {
    logger.warn({ event: 'telegram.skip', reason: 'BASE_URL not set — not registering the webhook' });
    return;
  }

  const bot = createTelegramBot(botToken);
  _bot = bot;

  // Initialize bot info and register the webhook (bot.start() would do the former
  // internally; raw webhook mode requires explicit calls).
  try {
    await configureWebhookWithRetry(bot);
  } catch (err) {
    logger.error({ event: 'telegram.webhook_giving_up', errName: (err as Error)?.name, errMsg: (err as Error)?.message });
  }
}
