#!/usr/bin/env -S npx tsx
/**
 * WhatYouSay — reconnect append-message evals
 * Run: npx tsx evals/wa-reconnect.ts
 *
 * Regression guard for WAY-39: voice notes sent during a brief socket disconnect
 * arrive from Baileys as type 'append' (same as history sync) and were previously
 * dropped silently. Within RECONNECT_GRACE_MS of a connect, messages with a fresh
 * timestamp should be processed instead of dropped.
 *
 * These tests exercise the gate function directly — no server, no Baileys, no Groq.
 */

import { __shouldProcessAppend, __setLastConnectedAt } from '../src/whatsapp';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(id: string, desc: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${id} ${desc}`);
    passed++;
  } catch (err) {
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

// Use a stable "now" so tests don't depend on wall-clock jitter.
const NOW = Date.now();
const SEC = 1000;
const GRACE = 120_000;

console.log('WhatYouSay — reconnect append-message evals\n');

console.log('R — Append-in-grace gate');

check('R01', 'fresh append accepted when socket just reconnected and message is recent', () => {
  __setLastConnectedAt(1001, NOW - 5 * SEC);  // connected 5s ago
  const ok = __shouldProcessAppend(1001, (NOW / 1000) - 30, NOW);  // message 30s old
  assert(ok, 'expected __shouldProcessAppend to return true for a recent message after a fresh connect');
});

check('R02', 'append dropped when socket reconnected too long ago', () => {
  __setLastConnectedAt(1001, NOW - 200 * SEC);  // connected 200s ago (> 120s grace)
  const ok = __shouldProcessAppend(1001, (NOW / 1000) - 30, NOW);
  assert(!ok, 'expected false when socket reconnected more than RECONNECT_GRACE_MS ago');
});

check('R03', 'append dropped when message timestamp is stale even within grace window', () => {
  __setLastConnectedAt(1001, NOW - 5 * SEC);  // connected 5s ago
  const ok = __shouldProcessAppend(1001, (NOW / 1000) - 200, NOW);  // message 200s old
  assert(!ok, 'expected false when the message itself is older than RECONNECT_GRACE_MS');
});

check('R04', 'append dropped when no recent connect is recorded for the userId', () => {
  // userId 1002 has never connected — no entry in lastConnectedAt
  const ok = __shouldProcessAppend(1002, (NOW / 1000) - 10, NOW);
  assert(!ok, 'expected false when no lastConnectedAt exists for this userId');
});

check('R05', 'append dropped when message timestamp is zero', () => {
  __setLastConnectedAt(1001, NOW - 5 * SEC);
  const ok = __shouldProcessAppend(1001, 0, NOW);
  assert(!ok, 'expected false for a zero message timestamp (protects against default/missing timestamps)');
});

check('R06', 'append dropped when message timestamp is null', () => {
  __setLastConnectedAt(1001, NOW - 5 * SEC);
  const ok = __shouldProcessAppend(1001, null, NOW);
  assert(!ok, 'expected false for a null message timestamp');
});

check('R07', 'append accepted at the edge of the grace window (just inside)', () => {
  __setLastConnectedAt(1001, NOW - (GRACE - 1000));  // 1s before grace expires
  const ok = __shouldProcessAppend(1001, (NOW / 1000) - 30, NOW);
  assert(ok, 'expected true when still inside the grace window');
});

check('R08', 'append dropped just outside the grace window', () => {
  __setLastConnectedAt(1001, NOW - (GRACE + 1000));  // 1s after grace expires
  const ok = __shouldProcessAppend(1001, (NOW / 1000) - 30, NOW);
  assert(!ok, 'expected false when just past the grace window');
});

// WAY-40: Gap 2 — clock-skew guard (Math.abs on timestamp check)
console.log('\nWAY-40 — Clock-skew guard');

check('C01', 'message with future timestamp (clock-skewed sender) is dropped', () => {
  __setLastConnectedAt(1001, NOW - 5 * SEC);  // connected 5s ago
  const futureTs = (NOW / 1000) + 200;  // sender's clock is 200s ahead
  const ok = __shouldProcessAppend(1001, futureTs, NOW);
  assert(!ok, 'expected false for a timestamp 200s in the future — clock-skewed sender');
});

check('C02', 'message 60s in the future is dropped (just over allowed skew)', () => {
  __setLastConnectedAt(1001, NOW - 5 * SEC);
  const futureTs = (NOW / 1000) + 130;  // 130s ahead — past the 120s window
  const ok = __shouldProcessAppend(1001, futureTs, NOW);
  assert(!ok, 'expected false when timestamp is 130s in the future');
});

check('C03', 'message 90s in the future is accepted (within window, possibly benign skew)', () => {
  __setLastConnectedAt(1001, NOW - 5 * SEC);
  const futureTs = (NOW / 1000) + 90;  // 90s ahead — still within 120s window (abs)
  const ok = __shouldProcessAppend(1001, futureTs, NOW);
  assert(ok, 'expected true for a timestamp 90s in the future — within RECONNECT_GRACE_MS');
});

// WAY-40: Gap 3 — grace window not extended on rapid reconnects
console.log('\nWAY-40 — Grace window stability on rapid reconnects');

check('G01', 'a message from 65s ago is accepted when window was opened 60s ago', () => {
  // The function checks two independent windows: socket connected within 120s AND
  // message timestamp within 120s (abs). Both pass here. The "don't slide" guard lives in
  // the connection:open handler (not testable here) — this test confirms the gate stays
  // open for messages sent just before the reconnect (the target use case).
  __setLastConnectedAt(1001, NOW - 60 * SEC);  // window started 60s ago
  const ok = __shouldProcessAppend(1001, (NOW / 1000) - 65, NOW);
  assert(ok, 'a 65s-old message should be accepted — could have been sent just before the reconnect');
});

check('G02', 'new grace window opens after previous window has expired', () => {
  __setLastConnectedAt(1001, NOW - 200 * SEC);  // last connect was 200s ago — expired
  // In the real handler, connection:open now would set lastConnectedAt to NOW.
  // Simulate that here:
  __setLastConnectedAt(1001, NOW - 2 * SEC);  // fresh reconnect 2s ago
  const ok = __shouldProcessAppend(1001, (NOW / 1000) - 30, NOW);
  assert(ok, 'expected true — new grace window opened after previous expired');
});

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`✓ All ${passed} reconnect checks passed`);
} else {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
process.exit(0);
