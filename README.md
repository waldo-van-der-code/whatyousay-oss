# WhatYouSay

WhatsApp voice notes, turned into text replies in the same chat, without keeping the transcripts.

WhatYouSay is a small self-hosted Node.js server that links to a WhatsApp account as a linked device. When a voice note is sent, it is transcribed with Whisper, cleaned up by an LLM, optionally translated and summarised, and posted as a reply right under the note. Nobody has to stop what they are doing to listen.

The idea comes from [WhatScribe](https://www.whatscribe.ai), a hosted service that does the same thing. WhatYouSay is an independent implementation you run yourself, built around one rule: the server does not keep what people said.

> [!warning]
> WhatYouSay connects through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. Unofficial clients break WhatsApp's terms of service, and WhatsApp can restrict or ban numbers that use them. Anyone who runs this takes that risk with their own number. This project is not affiliated with WhatsApp, Meta or WhatScribe.

## What it does

- Transcribes voice notes with Groq Whisper large-v3, using a two-pass strategy that guards against truncation and language flips.
- Cleans the text (punctuation, paragraphs, obvious mishearings) with language-specific rules for English, German and Dutch, and falls back to the raw Whisper text when the cleanup changes too much.
- Optionally translates into a target language and adds a short summary to long notes.
- Lets each user choose which voice notes are transcribed (sent or received, one-to-one chats or groups) and exclude specific contacts or groups.
- Shows transcripts live in a web dashboard while it is open. Login is by magic link.
- Optional: a Telegram bot that transcribes voice messages in linked Telegram groups, and Telegram alerts for operators.

## Privacy model

- **No transcript storage.** Transcript and summary text are never written to the database. Each processed note leaves one metadata row: sender, duration, language, token counts, WhatsApp message ID and timestamp. The transcript columns stay `NULL`.
- **Sender pseudonymisation.** After 90 days a daily job removes the sender's name and replaces their WhatsApp ID with a keyed hash.
- **Encrypted WhatsApp credentials.** Session credentials and Signal keys are encrypted at rest with `DB_ENCRYPTION_KEY`.
- **What does leave the server:** audio and text go to [Groq](https://groq.com) for transcription and text processing; the reply goes into the WhatsApp chat, where everyone in that chat can read it; an open dashboard receives transcripts over a live connection; a short-lived in-memory cache holds sent replies so WhatsApp can re-send them when a recipient's device asks. The dashboard loads the `libphonenumber-js` script from unpkg.com.

If you transcribe notes that other people send you, their audio passes through a third-party AI API. Tell them.

## Who can sign in

An instance is invite-only by default. In production, only the addresses in `ALLOWED_EMAILS` (comma-separated) and `ADMIN_EMAIL` can request a login link. `ALLOWED_EMAILS=*` opens signup to anyone, which lets strangers link their own WhatsApp and spend your Groq quota; every transcript reply ends with your instance's URL, so it is easy to find. Removing an address blocks new logins; delete the account in `/admin` to end an existing session. Outside production (`npm run dev`) an unset `ALLOWED_EMAILS` means open, for local testing.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`)
- A [Groq](https://console.groq.com) API key (the free tier is enough for personal use)
- A [Resend](https://resend.com) account with a verified sender domain, for login emails
- A domain name pointing at your server, for HTTPS
- A WhatsApp account on a phone, to scan the QR code

## Run locally

```bash
git clone https://github.com/waldo-van-der-code/whatyousay-oss.git whatyousay
cd whatyousay
npm ci                      # do not use --ignore-scripts: some dependencies need their install scripts
cp env.example .env         # fill in GROQ_API_KEY at minimum
echo "LOG_MAGIC_LINKS=true" >> .env
echo "ALLOW_INSECURE_COOKIES=true" >> .env
echo "BASE_URL=http://localhost:3000" >> .env
npm run dev
```

Open http://localhost:3000, enter any email address, and copy the magic link from the console. `LOG_MAGIC_LINKS` prints it before the email is sent, so without a Resend key the page reports "Failed to send email" but the printed link still works. The dashboard shows a QR code: on your phone, open WhatsApp → Settings → Linked devices → Link a device, and scan it.

## Deploy on an Oracle Cloud server

These steps set up an Oracle Cloud "Always Free" ARM instance (Ampere A1) with Ubuntu, nginx, a Let's Encrypt certificate and pm2. Any Ubuntu server works the same way; skip the Oracle-specific firewall step elsewhere.

### 1. Create the instance

In the Oracle Cloud console, create a compute instance:

- Image: **Canonical Ubuntu 24.04**
- Shape: **VM.Standard.A1.Flex** (Ampere ARM). 1 OCPU and 6 GB RAM is plenty.
- Add your SSH public key.

Give the instance a public IP, then point a DNS `A` record for your domain (for example `whatyousay.example.com`) at it.

### 2. Open ports 80 and 443

Oracle filters traffic in two places, and both need opening.

In the console, open the instance's subnet → **Security List** → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination ports `80` and `443`.

On the instance, Oracle's Ubuntu images ship with iptables rules that reject everything except SSH:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 3. Install Node.js, pm2 and nginx

```bash
sudo apt update && sudo apt install -y git nginx sqlite3
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
npm install -g pm2
```

### 4. Install WhatYouSay

```bash
cd ~
git clone https://github.com/waldo-van-der-code/whatyousay-oss.git whatyousay
cd whatyousay
npm ci
npm run build               # compiles src/ to dist/, which production runs
cp env.example .env
chmod 600 .env
nano .env
```

Fill in at least `GROQ_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `DB_ENCRYPTION_KEY`, `BASE_URL` (your `https://` domain; production refuses to start without it) and `ALLOWED_EMAILS` (who may sign in). Generate `DB_ENCRYPTION_KEY` with `openssl rand -hex 32`. Keep a copy of `DB_ENCRYPTION_KEY` somewhere safe and separate from your backups: without it, every linked WhatsApp session has to be scanned again.

### 5. Start it with pm2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd         # run the command it prints, so pm2 starts on boot
curl -sI http://127.0.0.1:3000/login | head -1   # expect HTTP/1.1 200 OK
```

The app listens on `127.0.0.1:3000` only. nginx is the public entry point.

### 6. Configure nginx

Create `/etc/nginx/sites-available/whatyousay`:

```nginx
server {
    listen 80;
    server_name whatyousay.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # The dashboard keeps a live Server-Sent Events connection open.
        proxy_read_timeout 86400;
        proxy_buffering off;
    }
}
```

The app takes the visitor's IP for its login rate limits from `X-Real-IP`. If you put Cloudflare in front, nginx sees Cloudflare's addresses instead of your visitors', so use nginx's `real_ip` module to restore them. Add this inside the `server` block, with every range from [cloudflare.com/ips](https://www.cloudflare.com/ips/):

```nginx
real_ip_header CF-Connecting-IP;
set_real_ip_from 173.245.48.0/20;   # one line per Cloudflare IPv4 and IPv6 range
```

Enable it and add HTTPS:

```bash
sudo ln -s /etc/nginx/sites-available/whatyousay /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d whatyousay.example.com
```

### 7. Link WhatsApp

Open your domain, log in with the magic link from your email, and scan the QR code under WhatsApp → Settings → Linked devices. Send yourself a voice note longer than a few seconds to check the reply arrives.

To use the admin panel at `/admin` (user list, account deletion), set `ADMIN_EMAIL` in `.env` to your login email.

### Updating

```bash
cd ~/whatyousay
git pull
npm ci
npm run build
pm2 restart whatyousay
```

`start.sh` reads `.env` on every start, so a restart also applies `.env` changes. A restart waits up to 45 seconds for voice notes that are still being processed.

### Backups

```bash
sqlite3 ~/whatyousay/whatyousay.db ".backup '/path/to/backup/whatyousay-$(date +%F).db'"
```

Stop the server (`pm2 stop whatyousay`) before running any other script that writes to the database. Two processes writing to the SQLite file at the same time can silently lose writes.

## Configuration

All settings live in `.env`; `env.example` documents every variable. The important ones:

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | yes | Whisper transcription and the LLM steps |
| `RESEND_API_KEY`, `EMAIL_FROM` | yes in production | Magic-link login emails |
| `DB_ENCRYPTION_KEY` | yes in production | Encrypts WhatsApp credentials at rest; production refuses to start without it |
| `BASE_URL` | yes in production | Public URL for login links, the reply footer and the Telegram webhook |
| `ALLOWED_EMAILS` | yes in production | Who may sign in: comma-separated emails, or `*` for open signup |
| `ADMIN_EMAIL` | no | Enables `/admin` for one login email, which may always sign in |
| `GROQ_LLM_MODELS` | no | Ordered fallback chain for the LLM steps (default `openai/gpt-oss-120b,openai/gpt-oss-20b`) |
| `TELEGRAM_*` | no | Telegram transcription bot and ops alerts |

Groq retires models from time to time. When the LLM model disappears, short notes keep working, long notes are sent uncleaned, and an ops alert fires if Telegram alerts are configured. Put the successor model first in `GROQ_LLM_MODELS` and restart.

The sender pseudonymisation job runs daily at 04:15 Europe/Berlin time (`src/retention.ts`).

## Architecture

One long-running Node.js and Express process with SQLite (`node:sqlite`). The WhatsApp sockets, live dashboard connections and the reply cache live in memory, so run exactly one instance: no cluster mode, no serverless.

| Path | Contents |
|---|---|
| `src/whatsapp.ts` | Baileys connection, message handling, retry receipts |
| `src/pipeline.ts` | Whisper passes, cleanup, translation, summary, reply formatting |
| `src/transcript-format.ts` | Cleanup guards and language-specific fidelity checks |
| `src/routes.ts`, `src/auth.ts` | Web routes, magic-link login, sessions, settings |
| `src/retention.ts` | Daily sender pseudonymisation |
| `src/crypto.ts` | At-rest encryption of WhatsApp credentials |
| `src/telegram-bot.ts`, `src/notify.ts` | Telegram bot and ops alerts |
| `views/`, `public/` | Dashboard, login and admin pages |
| `evals/` | Tests |

## Tests

```bash
npm run check                    # typecheck + offline evals (no API keys, no network)
npx playwright install chromium
npm run test:eval                # browser tests; start the server separately first
```

The browser tests write test users straight into the database, so run them on a development checkout with a throwaway database, never against production. Export `DB_PATH` in the shell (not in `.env`, which the test helpers do not read) before starting both the server and the tests:

```bash
export DB_PATH=/tmp/whatyousay-test.db
npm run dev                      # in one terminal
npm run test:eval                # in another, with the same DB_PATH exported
```

Two browser tests (`auth.spec.ts` B01 and the login success view) send a real email to Resend's `@resend.dev` test addresses, so they need `RESEND_API_KEY`.

`evals/pipeline-evals.ts`, `evals/whisper-ab.ts`, `evals/whisper-settings-matrix.ts` and `evals/benchmark-vs-chatgpt.ts` call Groq and run against your own recordings in `evals/fixtures/<name>/audio.opus` (with optional `expected.json`, `settings.json` and `reference.txt`). That folder is gitignored: never commit other people's voice notes.

## License

[MIT](LICENSE)
