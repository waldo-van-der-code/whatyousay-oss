/**
 * Benchmark our pipeline output against ChatGPT reference transcripts.
 *
 * Each fixture directory may contain a `reference.txt` file (gitignored, never committed)
 * with the ChatGPT-generated transcript for the same audio. Only fixtures with a
 * reference are scored; others are skipped.
 *
 * Produces:
 *   - Per-fixture WER (word error rate) and similarity score
 *   - Word precision / recall / F1 (unordered — tolerant of paraphrasing)
 *   - Words we added that ChatGPT didn't (potential hallucinations / over-corrections)
 *   - Words ChatGPT had that we dropped (potential omissions)
 *   - Aggregate score across all benchmarked fixtures
 *
 * Usage:
 *   npx tsx evals/benchmark-vs-chatgpt.ts              # all fixtures with reference.txt
 *   npx tsx evals/benchmark-vs-chatgpt.ts <name>       # single fixture
 *   npx tsx evals/benchmark-vs-chatgpt.ts --diff       # show full text diff inline
 *   npx tsx evals/benchmark-vs-chatgpt.ts --record     # append aggregate to scores-vs-chatgpt.jsonl
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { runPipeline } from '../src/pipeline';
import { DEFAULT_SETTINGS } from '../src/auth';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

// ── Word-error-rate helpers ────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // strip punctuation but keep apostrophes in contractions
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Classic dynamic-programming word edit distance (Levenshtein)
function editDistance(hyp: string[], ref: string[]): { sub: number; del: number; ins: number } {
  const R = ref.length;
  const H = hyp.length;
  const cost: Array<Array<{ d: number; sub: number; del: number; ins: number }>> = [];
  for (let i = 0; i <= H; i++) {
    cost[i] = [];
    for (let j = 0; j <= R; j++) {
      cost[i][j] = { d: 0, sub: 0, del: 0, ins: 0 };
    }
  }
  for (let i = 1; i <= H; i++) cost[i][0] = { d: i, sub: 0, del: 0, ins: i };
  for (let j = 1; j <= R; j++) cost[0][j] = { d: j, sub: 0, del: j, ins: 0 };

  for (let i = 1; i <= H; i++) {
    for (let j = 1; j <= R; j++) {
      if (hyp[i - 1] === ref[j - 1]) {
        cost[i][j] = cost[i - 1][j - 1];
      } else {
        const subOp = { d: cost[i - 1][j - 1].d + 1, sub: cost[i - 1][j - 1].sub + 1, del: cost[i - 1][j - 1].del, ins: cost[i - 1][j - 1].ins };
        const delOp = { d: cost[i - 1][j].d + 1,   sub: cost[i - 1][j].sub,   del: cost[i - 1][j].del,   ins: cost[i - 1][j].ins + 1 };
        const insOp = { d: cost[i][j - 1].d + 1,   sub: cost[i][j - 1].sub,   del: cost[i][j - 1].del + 1, ins: cost[i][j - 1].ins };
        const best = [subOp, delOp, insOp].reduce((a, b) => a.d <= b.d ? a : b);
        cost[i][j] = best;
      }
    }
  }
  return cost[H][R];
}

function wer(hypothesis: string, reference: string): {
  wer: number; similarity: number;
  sub: number; del: number; ins: number;
  refWords: number; hypWords: number;
} {
  const hyp = tokenize(hypothesis);
  const ref = tokenize(reference);
  if (ref.length === 0) return { wer: 0, similarity: 1, sub: 0, del: 0, ins: 0, refWords: 0, hypWords: hyp.length };
  const { sub, del, ins } = editDistance(hyp, ref);
  const total = sub + del + ins;
  const w = total / ref.length;
  return { wer: Math.min(w, 1), similarity: Math.max(0, 1 - w), sub, del, ins, refWords: ref.length, hypWords: hyp.length };
}

// Unordered word F1 — tolerant of reordering / paraphrasing
function wordF1(hypothesis: string, reference: string): { precision: number; recall: number; f1: number } {
  const hyp = tokenize(hypothesis);
  const ref = tokenize(reference);
  if (hyp.length === 0 && ref.length === 0) return { precision: 1, recall: 1, f1: 1 };
  if (hyp.length === 0 || ref.length === 0) return { precision: 0, recall: 0, f1: 0 };

  const refCounts = new Map<string, number>();
  for (const w of ref) refCounts.set(w, (refCounts.get(w) ?? 0) + 1);

  let matches = 0;
  const hypCounts = new Map<string, number>();
  for (const w of hyp) hypCounts.set(w, (hypCounts.get(w) ?? 0) + 1);

  for (const [w, cnt] of hypCounts) {
    matches += Math.min(cnt, refCounts.get(w) ?? 0);
  }

  const precision = matches / hyp.length;
  const recall = matches / ref.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return { precision, recall, f1 };
}

// Words in hypothesis that are NOT in reference (potential hallucinations / over-corrections)
function novelWords(hypothesis: string, reference: string): string[] {
  const hypTokens = tokenize(hypothesis);
  const refSet = new Set(tokenize(reference));
  const seen = new Set<string>();
  return hypTokens.filter(w => !refSet.has(w) && !seen.has(w) && seen.add(w) !== undefined);
}

// Words in reference that are NOT in hypothesis (potential omissions)
function missingWords(hypothesis: string, reference: string): string[] {
  const refTokens = tokenize(reference);
  const hypSet = new Set(tokenize(hypothesis));
  const seen = new Set<string>();
  return refTokens.filter(w => !hypSet.has(w) && !seen.has(w) && seen.add(w) !== undefined);
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  fixture: string;
  wer: number;
  similarity: number;
  f1: number;
  sub: number; del: number; ins: number;
  refWords: number; hypWords: number;
  novelWords: string[];
  missingWords: string[];
  ourTranscript: string;
  reference: string;
}

async function runFixture(name: string, showDiff: boolean): Promise<BenchmarkResult | null> {
  const dir = path.join(FIXTURES_DIR, name);
  const audioPath = path.join(dir, 'audio.opus');
  const refPath = path.join(dir, 'reference.txt');

  if (!fs.existsSync(refPath)) return null; // no reference — skip
  if (!fs.existsSync(audioPath)) {
    console.log(`  ${name} ... SKIP (no audio.opus)`);
    return null;
  }

  const reference = fs.readFileSync(refPath, 'utf8').trim();
  const audio = fs.readFileSync(audioPath);

  const settingsPath = path.join(dir, 'settings.json');
  const fixtureSettings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    : {};

  let result: Awaited<ReturnType<typeof runPipeline>>;
  try {
    result = await runPipeline(audio, {
      ...DEFAULT_SETTINGS,
      translate_to_english: false,
      summary_enabled: false,
      ...fixtureSettings,
    });
  } catch (err) {
    console.log(`  ${name} ... ERROR: ${err}`);
    return null;
  }

  const our = result.transcript;
  const w = wer(our, reference);
  const f = wordF1(our, reference);
  const novel = novelWords(our, reference);
  const missing = missingWords(our, reference);

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  const grade =
    w.similarity >= 0.9 ? '🟢' :
    w.similarity >= 0.75 ? '🟡' :
    w.similarity >= 0.5 ? '🟠' : '🔴';

  process.stdout.write(
    `  ${name}\n` +
    `    ${grade} similarity=${pct(w.similarity)}  WER=${pct(w.wer)}  F1=${pct(f.f1)}\n` +
    `       sub=${w.sub}  del=${w.del}  ins=${w.ins}  ref=${w.refWords}w  ours=${w.hypWords}w\n`
  );

  if (novel.length > 0) {
    process.stdout.write(`    📢 novel (we added):   ${novel.slice(0, 20).join(', ')}${novel.length > 20 ? ` … +${novel.length - 20}` : ''}\n`);
  }
  if (missing.length > 0) {
    process.stdout.write(`    ❌ missing (we dropped): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` … +${missing.length - 20}` : ''}\n`);
  }

  if (showDiff) {
    console.log('\n    --- Reference (ChatGPT) ---');
    console.log('    ' + reference.replace(/\n/g, '\n    '));
    console.log('\n    --- Ours ---');
    console.log('    ' + our.replace(/\n/g, '\n    '));
    console.log('');
  }

  return {
    fixture: name,
    wer: w.wer,
    similarity: w.similarity,
    f1: f.f1,
    sub: w.sub, del: w.del, ins: w.ins,
    refWords: w.refWords, hypWords: w.hypWords,
    novelWords: novel,
    missingWords: missing,
    ourTranscript: our,
    reference,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const record = args.includes('--record');
  const showDiff = args.includes('--diff');
  const target = args.find(a => !a.startsWith('--'));

  const names = target
    ? [target]
    : fs.existsSync(FIXTURES_DIR)
      ? fs.readdirSync(FIXTURES_DIR).filter(n => fs.statSync(path.join(FIXTURES_DIR, n)).isDirectory())
      : [];

  if (names.length === 0) {
    console.error(`No fixtures found in ${FIXTURES_DIR}`);
    process.exit(1);
  }

  console.log(`\nWhatYouSay vs ChatGPT — transcript benchmark\n`);

  const results: BenchmarkResult[] = [];
  for (let i = 0; i < names.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 8000)); // TPM guard
    const r = await runFixture(names[i], showDiff);
    if (r) results.push(r);
  }

  if (results.length === 0) {
    console.log('\nNo fixtures with reference.txt found. Add reference.txt to fixture directories to enable benchmarking.');
    return;
  }

  const avgSim = results.reduce((s, r) => s + r.similarity, 0) / results.length;
  const avgF1 = results.reduce((s, r) => s + r.f1, 0) / results.length;
  const avgWer = results.reduce((s, r) => s + r.wer, 0) / results.length;

  console.log('\n─────────────────────────────────────────');
  console.log(`Benchmarked ${results.length} fixture(s)`);
  console.log(`  avg similarity: ${(avgSim * 100).toFixed(1)}%`);
  console.log(`  avg WER:        ${(avgWer * 100).toFixed(1)}%`);
  console.log(`  avg word F1:    ${(avgF1 * 100).toFixed(1)}%`);

  // Top divergences across all fixtures
  const allNovel = results.flatMap(r => r.novelWords);
  const allMissing = results.flatMap(r => r.missingWords);
  const topNovel = [...new Map(allNovel.map(w => [w, allNovel.filter(x => x === w).length])).entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topMissing = [...new Map(allMissing.map(w => [w, allMissing.filter(x => x === w).length])).entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 15);

  if (topNovel.length > 0) {
    console.log('\nMost common words we ADD vs ChatGPT (possible over-corrections):');
    for (const [w, n] of topNovel) console.log(`  ${n}x  ${w}`);
  }
  if (topMissing.length > 0) {
    console.log('\nMost common words we DROP vs ChatGPT (possible omissions):');
    for (const [w, n] of topMissing) console.log(`  ${n}x  ${w}`);
  }

  if (record) {
    const entry = JSON.stringify({
      date: new Date().toISOString(),
      fixtures: results.length,
      avgSimilarity: +avgSim.toFixed(4),
      avgWer: +avgWer.toFixed(4),
      avgF1: +avgF1.toFixed(4),
      perFixture: results.map(r => ({
        fixture: r.fixture,
        similarity: +r.similarity.toFixed(4),
        wer: +r.wer.toFixed(4),
        f1: +r.f1.toFixed(4),
      })),
    });
    const scoresPath = path.join(import.meta.dirname, 'scores-vs-chatgpt.jsonl');
    fs.appendFileSync(scoresPath, entry + '\n');
    console.log(`\nScore recorded → ${scoresPath}`);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
