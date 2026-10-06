/**
 * Automated pipeline eval runner.
 * Usage:
 *   npx tsx evals/pipeline-evals.ts              # run all fixtures
 *   npx tsx evals/pipeline-evals.ts <name>       # run one fixture by directory name
 *
 * Each fixture directory under evals/fixtures/ needs:
 *   audio.opus    — the voice note
 *   expected.json — { language?, must_contain: string[], must_not_contain: string[] }
 *
 * Checks are applied to the full replyText (what gets sent to the WhatsApp sender).
 * Exits non-zero if any fixture fails.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { runPipeline } from '../src/pipeline';
import { DEFAULT_SETTINGS } from '../src/auth';

interface Expected {
  language?: string;
  must_contain?: string[];
  must_not_contain?: string[];
  /** Where to check must_contain/must_not_contain. Default: 'transcript' (not the full reply). */
  check_in?: 'transcript' | 'reply';
  /** Minimum number of paragraphs (blank-line-separated blocks) in result.transcript. */
  min_paragraphs?: number;
  /** Minimum word count in result.transcript — use to guard against Whisper truncation. */
  min_words?: number;
  /** When true, runs with summary_enabled: true and checks summary_* fields. */
  test_summary?: boolean;
  /** When set, runs with translate_to_english: true and this target language. */
  test_translation?: string;
  /** Minimum share of the source transcript's word count the translation must keep. */
  translation_min_word_ratio?: number;
  summary_must_contain?: string[];
  summary_must_not_contain?: string[];
}

// Optional per-fixture settings overrides — place settings.json in the fixture directory.
type PartialSettings = Partial<import('../src/auth').Settings>;

interface Result {
  fixture: string;
  passed: boolean;
  failures: string[];
  language?: string;
  transcript?: string;
  summary?: string;
  replyText?: string;
}

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

async function runFixture(name: string): Promise<Result> {
  const dir = path.join(FIXTURES_DIR, name);
  const audioPath = path.join(dir, 'audio.opus');
  const expectedPath = path.join(dir, 'expected.json');

  if (!fs.existsSync(audioPath)) return { fixture: name, passed: false, failures: ['missing audio.opus'] };
  if (!fs.existsSync(expectedPath)) return { fixture: name, passed: false, failures: ['missing expected.json'] };

  const expected: Expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const audio = fs.readFileSync(audioPath);

  const settingsPath = path.join(dir, 'settings.json');
  const fixtureSettings: PartialSettings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    : {};

  const summarySettings = expected.test_summary
    ? { summary_enabled: true, summary_min_words: 1 }
    : { summary_enabled: false };

  const translationSettings = expected.test_translation
    ? { translate_to_english: true, translate_target_language: expected.test_translation }
    : {};

  let result: Awaited<ReturnType<typeof runPipeline>>;
  try {
    // translate_to_english defaults OFF — opt a fixture in with expected.test_translation.
    // A fixture opts in with expected.test_translation, or overrides via settings.json.
    result = await runPipeline(audio, { ...DEFAULT_SETTINGS, translate_to_english: false, ...summarySettings, ...translationSettings, ...fixtureSettings });
  } catch (err) {
    return { fixture: name, passed: false, failures: [`pipeline error: ${err}`] };
  }

  const failures: string[] = [];

  if (expected.language && result.language !== expected.language) {
    failures.push(`language: expected "${expected.language}", got "${result.language}"`);
  }

  // Primary checks: transcript by default, or full replyText when check_in: 'reply'
  const checkTarget = expected.check_in === 'reply' ? result.replyText : result.transcript;
  const checkLabel = expected.check_in ?? 'transcript';
  for (const s of expected.must_contain ?? []) {
    if (!checkTarget?.includes(s)) failures.push(`must_contain: "${s}" not found in ${checkLabel}`);
  }
  for (const s of expected.must_not_contain ?? []) {
    if (checkTarget?.includes(s)) failures.push(`must_not_contain: "${s}" found in ${checkLabel}`);
  }

  // Word count check — guards against Whisper truncation
  if (expected.min_words !== undefined) {
    const wordCount = (result.transcript ?? '').trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < expected.min_words) {
      failures.push(`min_words: expected ≥${expected.min_words}, got ${wordCount} (possible Whisper truncation)`);
    }
  }

  // Paragraph spacing check
  if (expected.min_paragraphs !== undefined) {
    const paragraphs = (result.transcript ?? '').split(/\n\n+/).filter(p => p.trim()).length;
    if (paragraphs < expected.min_paragraphs) {
      failures.push(`min_paragraphs: expected ≥${expected.min_paragraphs}, got ${paragraphs} (transcript has no paragraph breaks)`);
    }
  }

  // Look-alike characters must never reach WhatsApp — they break search and copy-paste.
  const invisibles = [...(result.transcript ?? ''), ...(result.summary ?? '')]
    .filter(c => /[\u00A0\u2007\u2009\u202F\u2011\u2012]/.test(c));
  if (invisibles.length) {
    const codes = [...new Set(invisibles.map(c => 'U+' + c.charCodeAt(0).toString(16).toUpperCase()))];
    failures.push(`invisible characters in output: ${codes.join(', ')}`);
  }

  // Translation must not silently summarise or drop the text
  if (expected.test_translation) {
    const ratio = expected.translation_min_word_ratio ?? 0.6;
    const words = (result.transcript ?? '').trim().split(/\s+/).filter(Boolean).length;
    if (result.language === expected.test_translation) {
      failures.push(`test_translation: fixture audio is already ${expected.test_translation}, nothing to translate`);
    } else if (words < (expected.min_words ?? 0) * ratio) {
      failures.push(`translation kept ${words} words, below ${ratio} of min_words ${expected.min_words}`);
    }
  }

  // Summary checks
  if (expected.test_summary) {
    if (!result.summary) {
      failures.push('summary: expected a summary but got none');
    } else {
      for (const s of expected.summary_must_contain ?? []) {
        if (!result.summary.includes(s)) failures.push(`summary_must_contain: "${s}" not found in summary`);
      }
      for (const s of expected.summary_must_not_contain ?? []) {
        if (result.summary.includes(s)) failures.push(`summary_must_not_contain: "${s}" found in summary`);
      }
    }
  }

  return {
    fixture: name,
    passed: failures.length === 0,
    failures,
    language: result.language,
    transcript: result.transcript,
    summary: result.summary,
    replyText: result.replyText,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const record = args.includes('--record');
  const target = args.find(a => a !== '--record');

  // evals/fixtures/ is gitignored because the audio is real voice content, so a
  // fresh clone has no directory at all. Read it only if it exists, otherwise
  // fall through to the same message as an empty one.
  const names = target
    ? [target]
    : fs.existsSync(FIXTURES_DIR)
      ? fs.readdirSync(FIXTURES_DIR).filter(n => fs.statSync(path.join(FIXTURES_DIR, n)).isDirectory())
      : [];

  if (names.length === 0) {
    console.error(
      `No fixtures found in ${FIXTURES_DIR}\n` +
        'Add one directory per case, each containing audio.opus and expected.json.'
    );
    process.exit(1);
  }

  console.log(`Running ${names.length} fixture(s)...\n`);

  const results: Result[] = [];
  for (let i = 0; i < names.length; i++) {
    // compound-mini routes through openai/gpt-oss-120b (8000 TPM limit).
    // German fixtures consume ~2400 tokens (clean + translate); 8s gives enough headroom
    // for 14 fixtures without hitting the per-minute cap.
    if (i > 0) await new Promise(r => setTimeout(r, 8000));
    const name = names[i];
    process.stdout.write(`  ${name} ... `);
    const r = await runFixture(name);
    results.push(r);
    if (r.passed) {
      console.log(`PASS  (lang=${r.language})`);
    } else {
      console.log('FAIL');
      for (const f of r.failures) console.log(`    ✗ ${f}`);
      if (r.transcript) console.log(`    transcript: ${r.transcript.slice(0, 300).replace(/\n/g, ' ')}`);
      if (r.summary) console.log(`    summary:    ${r.summary.replace(/\n/g, ' ')}`);
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);

  if (record) {
    const failureNames = results.filter(r => !r.passed).map(r => r.fixture);
    const entry = JSON.stringify({
      date: new Date().toISOString(),
      total: results.length,
      passed,
      failed,
      failures: failureNames,
    });
    const scoresPath = path.join(import.meta.dirname, 'scores.jsonl');
    fs.appendFileSync(scoresPath, entry + '\n');
    console.log(`\nScore recorded → ${scoresPath}`);
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
