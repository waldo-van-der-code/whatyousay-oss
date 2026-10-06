import 'dotenv/config';
import express from 'express';

// Keep the process alive through Baileys crypto errors (Bad MAC, MessageCounterError).
// These are per-message signal-protocol failures — not bugs in our code — and should
// never crash the server. Log and continue.
// describeCrash logs the stack only — see src/log-filter.ts (ME-065).
import { installConsoleFilter, describeCrash } from './log-filter';
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', describeCrash(reason));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', describeCrash(err));
});
// Drop libsignal's console dumps of Signal session state (privKey/rootKey) before
// they reach the pm2 logs — see src/log-filter.ts.
installConsoleFilter();
import cookieParser from 'cookie-parser';
import path from 'path';
import { getDb } from './db';
import { router } from './routes';
import { reconnectAllSessions, closeAllSessions } from './whatsapp';
import { startTelegramBot } from './telegram-bot';
import { assertEncryptionKey } from './crypto';
import { logger } from './logger';
import { installGracefulShutdown } from './shutdown';
import { scheduleDailyRetention } from './retention';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

// Security headers (ME-065). The views run inline <script> blocks and inline event
// handlers, so script-src must keep 'unsafe-inline' and cannot stop an injected
// handler from running — output escaping in views/ is the XSS defence. What this
// does buy: no plugins, no <base> hijack, no framing (clickjacking), forms only post
// here, and fetch/XHR/beacons only reach this origin, which closes the
// easy exfiltration channel for anything that does slip through.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.whatsapp.net",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// No secret: no cookie is signed. Sessions are random tokens checked against the DB.
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/', router);

getDb();

// wa_sessions is encrypted at rest (ME-065). Fail before any session loads rather
// than reconnect with a key that cannot read — or would mis-encrypt — the rows.
// Exit explicitly: a top-level throw would be swallowed by the uncaughtException
// handler above and leave a half-started process.
try {
  assertEncryptionKey();
} catch (err) {
  logger.fatal({ event: 'startup.encryption_key_invalid', errMsg: (err as Error)?.message });
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.BASE_URL) {
  // Login links and the footer of every transcript reply would point at localhost.
  logger.fatal({ event: 'startup.base_url_missing' });
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_EMAILS && !process.env.ADMIN_EMAIL) {
  logger.warn({ event: 'startup.no_allowed_emails', hint: 'set ALLOWED_EMAILS or ADMIN_EMAIL, nobody can sign in' });
}
if (process.env.NODE_ENV !== 'production') {
  logger.warn({ event: 'startup.not_production', nodeEnv: process.env.NODE_ENV ?? null });
}

reconnectAllSessions();
startTelegramBot();
// Anonymise transcription senders older than 90 days, daily at 04:15 Berlin (ME-065).
scheduleDailyRetention(getDb);

const server = app.listen(PORT, HOST, () => {
  console.log(`WhatYouSay running on http://${HOST}:${PORT}`);
});

// Sockets are closed cleanly (not killed) so WhatsApp keeps the pairing, but only
// after in-flight voice notes have sent their reply.
installGracefulShutdown({
  stopAccepting: () => server.close(),
  closeSessions: closeAllSessions,
});
