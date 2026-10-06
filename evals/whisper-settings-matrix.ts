/**
 * Whisper-stage settings matrix: every fixture × every real settings profile, through the
 * real transcribe(). Guards the rule that no user setting may cost transcript completeness
 * (WAY-32/33/34). Whisper only — spends no LLM tokens.
 *
 *   npx tsx evals/whisper-settings-matrix.ts                  # all fixtures, real profiles
 *   npx tsx evals/whisper-settings-matrix.ts <fixture>        # one fixture
 *   npx tsx evals/whisper-settings-matrix.ts --all-profiles   # include hypothetical profiles
 *
 * Each profile's final text is compared with the `no-context` profile's final text, NOT with
 * transcribe()'s own baseline — that would pass trivially if the prompt leaked into pass 1.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { contextPrompt, countWords, transcribe, MIN_PASS2_WORD_RATIO } from '../src/pipeline';

type Profile = { known_names?: string; whisper_context?: string };
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const CONFIG = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'settings-profiles.json'), 'utf8'));
const BASELINE = 'no-context';

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (err: any) {
      if (err?.status === 429) throw new Error(`Groq rate limit (429): ${err?.message ?? ''} — re-run later or per fixture`);
      if (attempt >= 3) throw err;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith('--'));
  const profiles: Record<string, Profile> = { ...CONFIG.profiles, ...(args.includes('--all-profiles') ? CONFIG.hypothetical : {}) };
  const fixtures = fs.readdirSync(FIXTURES_DIR).sort()
    .filter(f => fs.existsSync(path.join(FIXTURES_DIR, f, 'audio.opus')))
    .filter(f => !target || f === target);

  const failed = new Set<string>();
  let cells = 0, promptDropped = 0;
  for (const fx of fixtures) {
    const audio = fs.readFileSync(path.join(FIXTURES_DIR, fx, 'audio.opus'));
    const out: Record<string, { words: number; promptApplied: boolean }> = {};
    for (const [name, profile] of Object.entries(profiles)) {
      const r = await withRetry(() => transcribe(audio, undefined, contextPrompt(profile)));
      out[name] = { words: countWords(r.text), promptApplied: r.promptApplied };
    }
    const base = out[BASELINE].words;
    const parts: string[] = [], bad: string[] = [];
    for (const [name, c] of Object.entries(out)) {
      parts.push(`${name}: ${c.words}w${name === BASELINE ? '' : c.promptApplied ? ' names✓' : ' names dropped'}`);
      if (name === BASELINE) continue;
      cells++;
      if (!c.promptApplied) promptDropped++;
      if (c.words < base * MIN_PASS2_WORD_RATIO) bad.push(`${name} kept ${c.words}/${base} words`);
    }
    console.log(`${bad.length ? 'FAIL' : 'ok  '} ${fx.padEnd(38)} ${parts.join(' | ')}`);
    for (const b of bad) { console.log(`       ✗ ${b}`); failed.add(fx); }
  }
  console.log(`\n${fixtures.length - failed.size}/${fixtures.length} fixtures ok — context was dropped to protect completeness in ${promptDropped}/${cells} cells`);
  process.exit(failed.size ? 1 : 0);
}

main().catch(err => { console.error(String(err?.message ?? err)); process.exit(2); });
