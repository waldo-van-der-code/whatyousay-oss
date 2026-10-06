#!/usr/bin/env -S npx tsx
/**
 * WhatYouSay — graceful shutdown evals
 * Run: npx tsx evals/shutdown.ts
 *
 * Regression guard for WAY-057. A deploy restarted pm2 two seconds after a voice
 * note arrived; Whisper had finished, the reply had not gone out, and the note was
 * lost for good (WhatsApp does not redeliver a message that was already acked).
 * Shutdown closed the WhatsApp sockets first, and pm2 SIGKILLed after 1.6 s anyway.
 *
 * The handler-is-tracked half lives in wa-retry.ts (G01, G02). This file checks
 * the shutdown sequence itself under a real signal, plus the pm2 and index.ts wiring.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DRAIN_TIMEOUT_MS, drainInFlight, trackInFlight } from '../src/shutdown';

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function check(id: string, desc: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${id} ${desc}`);
    passed++;
  } catch (err: unknown) {
    console.error(`  ✗ ${id} ${desc}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function runChildWithSigint(): Promise<{ marks: string[]; code: number | null; signal: NodeJS.Signals | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'helpers', 'shutdown-child.ts')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const marks: string[] = [];
    let buf = '';
    let sentAt = 0;
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith('MARK ')) continue;
        const mark = line.slice(5);
        marks.push(mark);
        if (mark === 'ready') {
          sentAt = Date.now();
          child.kill('SIGINT');
          // pm2 retrying, or a deploy run twice: the second signal must not cut the drain short.
          setTimeout(() => child.kill('SIGINT'), 300);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ marks, code, signal, ms: Date.now() - sentAt });
    });
  });
}

async function main(): Promise<void> {
  console.log('WhatYouSay — graceful shutdown evals\n');

  const run = await runChildWithSigint();
  check('W01', 'Regression WAY-057: SIGINT (sent twice) waits for the voice note in flight before closing sessions', () => {
    const order = run.marks.filter(m => m !== 'ready');
    assert(
      order.join(',') === 'stop-accepting,reply-sent,sessions-closed',
      `shutdown order was [${order.join(', ')}]; the reply must be sent before the WhatsApp sockets close`
    );
    assert(run.code === 0 && run.signal === null, `child exited with code ${run.code}, signal ${run.signal}`);
    assert(run.ms >= 1000, `exited ${run.ms} ms after SIGINT: it did not wait for the 1.5 s pipeline`);
  });

  trackInFlight(new Promise(() => {}));
  const started = Date.now();
  const drained = await drainInFlight(150);
  const waited = Date.now() - started;
  check('W02', 'a stuck pipeline cannot hold shutdown open past the drain timeout', () => {
    assert(!drained, 'drain reported success with work still pending');
    assert(waited >= 140 && waited < 1000, `drain waited ${waited} ms for a 150 ms timeout`);
  });

  check('W03', 'pm2 waits longer than the drain before SIGKILL', () => {
    const killTimeout = require(path.join(ROOT, 'ecosystem.config.js')).apps.find((a: any) => a.name === 'whatyousay')?.kill_timeout;
    assert(
      typeof killTimeout === 'number' && killTimeout > DRAIN_TIMEOUT_MS + 5000,
      `ecosystem.config.js kill_timeout is ${killTimeout}; pm2's 1.6 s default SIGKILLs a draining process`
    );
  });

  check('W04', 'index.ts uses the draining shutdown', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
    assert(src.includes('installGracefulShutdown('), 'index.ts does not install the graceful shutdown');
    assert(!/process\.(once|on)\('SIG(TERM|INT)'/.test(src), 'index.ts registers its own signal handler, which would bypass the drain');
  });

  console.log(`\n${'─'.repeat(50)}`);
  if (failed > 0) {
    console.log(`✗ ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`✓ All ${passed} shutdown checks passed`);
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
