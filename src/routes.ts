import { Router, Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'path';
import { Resend } from 'resend';
import {
  createLoginToken,
  createAuthLink,
  peekLoginToken,
  consumeLoginToken,
  isTokenFormat,
  createSession,
  verifySession,
  deleteSession,
  getUserEmail,
  getUserSettings,
  saveUserSettings,
  sanitizeSettingsPatch,
  MAGIC_LINK_TTL_MS,
} from './auth';
import { addSseClient, emitToUser } from './sse';
import { isEmailAllowed, isValidEmail, maskEmail } from './validation';
import { initWhatsApp, getConnectionStatus, disconnectWhatsApp } from './whatsapp';
import { getOrCreatePersonalToken, listLinkedGroups, removeLinkedGroup, getTelegramBot, getBotUsername, verifyWebhookSecret } from './telegram-bot';
import { getDb, Transcription } from './db';
import { logger } from './logger';
import { SlidingWindowLimiter } from './rate-limit';

let _resend: Resend | null = null;
const getResend = () => (_resend ??= new Resend(process.env.RESEND_API_KEY ?? ''));

/**
 * Cookies are Secure everywhere (ME-065). The old rule — Secure only when
 * NODE_ENV=production — silently shipped a non-Secure session cookie because prod
 * never set NODE_ENV. ALLOW_INSECURE_COOKIES=true is the opt-out for plain-http
 * localhost testing and is ignored when NODE_ENV=production.
 */
export function cookieSecure(): boolean {
  return !(process.env.ALLOW_INSECURE_COOKIES === 'true' && process.env.NODE_ENV !== 'production');
}

const SESSION_COOKIE_MS = 30 * 24 * 60 * 60 * 1000;
const NONCE_COOKIE = 'login_nonce';

// ── Login rate limits (ME-065) ────────────────────────────────────────────────
// Every accepted request sends an email through Resend, so without limits the
// endpoint was a free mail cannon at someone else's inbox and our sender reputation.
export const loginLimits = {
  perEmail: new SlidingWindowLimiter(3, 15 * 60 * 1000),
  perIp: new SlidingWindowLimiter(10, 15 * 60 * 1000),
  // Backstops if the per-IP key is spoofed (see clientIp): bound total email volume
  // (Resend quota, sender reputation). They can lock out new logins for everyone while
  // abused; existing 30-day sessions are unaffected.
  global: new SlidingWindowLimiter(30, 15 * 60 * 1000),
  daily: new SlidingWindowLimiter(200, 24 * 60 * 60 * 1000),
};

/**
 * The visitor's IP, taken from X-Real-IP set by the reverse proxy. The app listens on
 * 127.0.0.1, so only the proxy can reach it. Behind Cloudflare, configure nginx's
 * real_ip module so $remote_addr is the visitor, not a Cloudflare edge (see README).
 * Client-supplied headers such as CF-Connecting-IP are never trusted directly.
 */
function clientIp(req: Request): string {
  const v = req.get('x-real-ip')?.trim();
  if (v && net.isIP(v)) return v;
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * True for a browser request sent from another site. Browsers attach Origin to
 * every cross-origin POST (and Sec-Fetch-Site to every request), so a forged form
 * or fetch from another page is recognisable; non-browser clients send neither.
 */
function isCrossSite(req: Request): boolean {
  const origin = req.get('origin');
  if (origin !== undefined) {
    const host = req.get('host');
    const allowed = new Set<string>();
    if (host) { allowed.add(`https://${host}`); allowed.add(`http://${host}`); }
    if (process.env.BASE_URL) {
      try { allowed.add(new URL(process.env.BASE_URL).origin); } catch { /* ignore a malformed BASE_URL */ }
    }
    return !allowed.has(origin);
  }
  const site = req.get('sec-fetch-site');
  return !!site && site !== 'same-origin' && site !== 'none';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const router = Router();

// Reject cross-site state changes on every route (ME-065). The Telegram webhook is
// a server-to-server call that carries no Origin and is authenticated by its secret.
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/telegram/webhook') return next();
  if (isCrossSite(req)) {
    logger.warn({ event: 'http.cross_site_rejected', method: req.method, path: req.path });
    res.status(403).json({ error: 'Cross-site request rejected' });
    return;
  }
  next();
});

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.session as string | undefined;
  if (!token) { res.redirect('/login'); return; }
  const userId = verifySession(token);
  if (!userId) {
    res.clearCookie('session');
    res.redirect('/login');
    return;
  }
  (req as any).userId = userId;
  next();
}

const VIEWS = path.join(__dirname, '..', 'views');

// ── Auth routes ──────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  const token = req.cookies?.session as string | undefined;
  if (token && verifySession(token)) { res.redirect('/'); return; }
  res.sendFile(path.join(VIEWS, 'login.html'));
});

router.post('/auth/login', async (req, res) => {
  // JSON only: an HTML form cannot send application/json cross-site without a CORS
  // preflight, which this server never approves.
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'Expected application/json' });
    return;
  }

  const ipCheck = loginLimits.perIp.hit(clientIp(req));
  if (!ipCheck.ok) {
    logger.warn({ event: 'auth.login_rate_limited', scope: 'ip' });
    res.setHeader('Retry-After', String(ipCheck.retryAfterS));
    res.status(429).json({ error: 'Too many login requests. Please wait a few minutes and try again.' });
    return;
  }

  const raw = req.body?.email;
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Invalid email' });
    return;
  }
  if (!isEmailAllowed(email)) {
    logger.warn({ event: 'auth.login_not_allowed', email: maskEmail(email) });
    res.status(403).json({ error: 'This instance is invite-only. Ask the person who runs it to add your email address.' });
    return;
  }

  // Global caps first, so a request refused by them leaves no per-email hit behind.
  for (const [scope, limiter] of [['global', loginLimits.global], ['daily', loginLimits.daily]] as const) {
    const check = limiter.hit('all');
    if (!check.ok) {
      logger.warn({ event: 'auth.login_rate_limited', scope });
      res.setHeader('Retry-After', String(check.retryAfterS));
      res.status(429).json({ error: 'Too many login requests right now. Please try again later.' });
      return;
    }
  }
  const emailCheck = loginLimits.perEmail.hit(email);
  if (!emailCheck.ok) {
    logger.warn({ event: 'auth.login_rate_limited', scope: 'email', email: maskEmail(email) });
    res.setHeader('Retry-After', String(emailCheck.retryAfterS));
    res.status(429).json({ error: 'Too many login links requested for this address. Please wait a few minutes and check your inbox.' });
    return;
  }

  // Bind the link to this browser (login CSRF, ME-065). Reuse an existing nonce so
  // several links requested from the same browser all count as "same browser".
  let nonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
  if (!isTokenFormat(nonce)) nonce = crypto.randomBytes(32).toString('hex');
  res.cookie(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/auth',
    maxAge: MAGIC_LINK_TTL_MS,
  });

  // No users row yet: it is created when the link is confirmed.
  const token = createLoginToken(email, nonce);

  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const link = `${baseUrl}/auth/verify?token=${token}`;

  const from = process.env.EMAIL_FROM ?? 'WhatYouSay <hello@example.com>';

  logger.info({ event: 'auth.magic_link_sent', email: maskEmail(email) });
  if (process.env.LOG_MAGIC_LINKS === 'true' && process.env.NODE_ENV !== 'production') {
    console.log(`\n🔗 Login link for ${email}:\n${link}\n`);
  }

  try {
    await getResend().emails.send({
      from,
      to: [email],
      subject: 'Your login link',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:40px 32px">
          <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700">Your login link</h2>
          <p style="color:#475569;margin:0 0 28px;font-size:15px">Click the button below to log in. This link is valid for 15 minutes.</p>
          <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px">Log in</a>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0">
          <p style="color:#94a3b8;font-size:13px;margin:0">If you didn't request this email, you can safely ignore it.</p>
          <p style="color:#cbd5e1;font-size:12px;margin:8px 0 0">Or copy this link: ${link}</p>
        </div>
      `,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ event: 'auth.email_failed', email: maskEmail(email), errName: (err as Error)?.name });
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Login CSRF (ME-065): a GET used to log in whoever opened the link, so an attacker
// could log a victim into the attacker's account (and harvest what the victim then
// linked). GET now only shows a confirm page naming the account; the login happens
// on the POST it submits, which the cross-site guard above protects. Prefetching
// mail scanners no longer burn the link either.
const VERIFY_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'views', 'verify.html'), 'utf8');
const OTHER_BROWSER_NOTICE =
  '<div class="alert alert-error" style="margin-bottom:16px">This link was requested from a different browser or device. ' +
  'Only continue if you asked for it yourself — otherwise close this page.</div>';

router.get('/auth/verify', (req, res) => {
  const token = req.query.token;
  if (!token) { res.redirect('/login?error=missing'); return; }
  const info = typeof token === 'string' ? peekLoginToken(token, req.cookies?.[NONCE_COOKIE]) : null;
  if (!info) { res.redirect('/login?error=invalid'); return; }

  // strict-origin keeps the token out of the Referer of /style.css (and so out of
  // access logs). Never no-referrer: the browser would then send "Origin: null" with
  // the confirm POST, which the cross-site guard rejects.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'strict-origin');
  // One pass with a replacer function: a valid address may contain "{{TOKEN}}" or
  // "$`", which sequential string replacements would expand.
  const values: Record<string, string> = {
    NOTICE: info.sameBrowser ? '' : OTHER_BROWSER_NOTICE,
    EMAIL: escapeHtml(info.email),
    TOKEN: escapeHtml(token as string),
  };
  res.type('html').send(VERIFY_TEMPLATE.replace(/\{\{(NOTICE|EMAIL|TOKEN)\}\}/g, (_m, k: string) => values[k]));
});

router.post('/auth/verify', (req, res) => {
  const token = req.body?.token;
  const userId = typeof token === 'string' ? consumeLoginToken(token) : null;
  if (!userId) { res.redirect(303, '/login?error=invalid'); return; }

  const sessionToken = createSession(userId);
  res.cookie('session', sessionToken, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MS,
  });
  res.clearCookie(NONCE_COOKIE, { path: '/auth' });
  res.redirect(303, '/');
});

router.post('/auth/logout', requireAuth, (req, res) => {
  const token = req.cookies?.session as string | undefined;
  if (token) deleteSession(token);
  res.clearCookie('session');
  res.redirect('/login');
});

// Cross-device auth link (generates a one-time 10-min login URL)
router.post('/auth/link', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const token = createAuthLink(userId);
  if (!token) { res.status(404).json({ error: 'User not found' }); return; }
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  res.json({ url: `${baseUrl}/auth/verify?token=${token}` });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(VIEWS, 'dashboard.html'));
});

// ── API routes ───────────────────────────────────────────────────────────────

router.get('/api/me', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  res.json({ email: getUserEmail(userId) });
});

router.get('/api/whatsapp/status', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const status = getConnectionStatus(userId);
  res.setHeader('Cache-Control', 'no-store');
  res.json(status);
});

router.get('/api/whatsapp/qr', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  addSseClient(userId, res);

  const status = getConnectionStatus(userId);
  logger.info({ event: 'sse.open', userId, connected: status.connected });
  if (status.connected) {
    emitToUser(userId, 'connected', status);
  } else {
    initWhatsApp(userId).catch(err => logger.error({ event: 'wa.init_error', userId, errName: (err as Error)?.name }));
  }
});

router.post('/api/whatsapp/disconnect', requireAuth, async (req, res) => {
  const userId = (req as any).userId as number;
  await disconnectWhatsApp(userId);
  res.json({ ok: true });
});

router.get('/api/transcriptions', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const rows = getDb()
    .prepare('SELECT * FROM transcriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(userId) as unknown as Transcription[];
  res.json(rows);
});

router.get('/api/settings', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  res.json(getUserSettings(userId));
});

router.post('/api/settings', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const result = sanitizeSettingsPatch(req.body);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.json(saveUserSettings(userId, result.patch));
});

// ── Telegram routes ───────────────────────────────────────────────────────────

router.get('/api/telegram/token', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const token = getOrCreatePersonalToken(userId);
  res.json({ token, botUsername: getBotUsername() });
});

router.get('/api/telegram/groups', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  res.json(listLinkedGroups(userId));
});

router.delete('/api/telegram/groups/:chatId', requireAuth, (req, res) => {
  const userId = (req as any).userId as number;
  const chatId = req.params.chatId;
  const removed = removeLinkedGroup(userId, chatId);
  if (!removed) { res.status(404).json({ error: 'Group not found' }); return; }
  res.json({ ok: true });
});

// Telegram webhook. The URL is public, so the only proof an update came from Telegram
// is the secret_token we registered via setWebhook, echoed back in this header (ME-065).
router.post('/telegram/webhook', (req, res) => {
  const header = req.get('x-telegram-bot-api-secret-token');
  if (!verifyWebhookSecret(header)) {
    logger.warn({ event: 'telegram.webhook_rejected', hasHeader: !!header });
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200); // respond immediately so Telegram doesn't retry
  const bot = getTelegramBot();
  logger.info({ event: 'telegram.webhook_received', hasBot: !!bot, hasBody: !!req.body, updateId: req.body?.update_id });
  if (bot) {
    bot.handleUpdate(req.body).catch(err => {
      logger.error({ event: 'telegram.handleupdate_error', errName: (err as Error)?.name, errMsg: (err as Error)?.message });
    });
  }
});

// ── Admin routes ─────────────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.session as string | undefined;
  if (!token) { res.redirect('/login'); return; }
  const userId = verifySession(token);
  if (!userId) { res.redirect('/login'); return; }
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const email = getUserEmail(userId)?.toLowerCase();
  if (!adminEmail || email !== adminEmail) { res.redirect('/'); return; }
  (req as any).userId = userId;
  next();
}

router.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(VIEWS, 'admin.html'));
});

router.get('/api/admin/users', requireAdmin, (_req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT
      u.id, u.email, u.created_at,
      COUNT(DISTINCT t.id) AS transcription_count,
      CASE WHEN w.user_id IS NOT NULL THEN 1 ELSE 0 END AS wa_connected
    FROM users u
    LEFT JOIN transcriptions t ON t.user_id = u.id
    LEFT JOIN wa_sessions w ON w.user_id = u.id AND w.creds_json IS NOT NULL
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  const total_transcriptions = (db.prepare('SELECT COUNT(*) as n FROM transcriptions').get() as any).n;
  res.json({ users, total_transcriptions });
});

router.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: 'Invalid id' }); return; }
  // Close the live WhatsApp socket first: deleting only the row left it transcribing
  // (and spending Groq quota) for the deleted account until the next restart.
  await disconnectWhatsApp(id);
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});
