/**
 * Compare Whisper-only transcript quality between two checked-out pipeline versions.
 * Usage: npx tsx evals/whisper-ab.ts <fixture-root> <baseline-root> <candidate-root> [fixture,...]
 * A fixture needs audio.opus and reference.txt; optional settings.json mirrors user context.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [fixtureRoot, baselineRoot, candidateRoot, requestedFixtures] = process.argv.slice(2);
if (!fixtureRoot || !baselineRoot || !candidateRoot) {
  throw new Error('Usage: npx tsx evals/whisper-ab.ts <fixture-root> <baseline-root> <candidate-root> [fixture,...]');
}

type Pipeline = {
  transcribe: (audio: Buffer, filename?: string, knownNames?: string) => Promise<{ text: string; lowConfidenceTailRetry: boolean }>;
  contextPrompt: (settings: { known_names?: string; whisper_context?: string }) => string | undefined;
};

const tokenize = (text: string) => text.toLowerCase()
  .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

function distance(hypothesis: string[], reference: string[]): number {
  let row = Array.from({ length: reference.length + 1 }, (_, i) => i);
  for (let i = 1; i <= hypothesis.length; i++) {
    const next = [i];
    for (let j = 1; j <= reference.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (hypothesis[i - 1] === reference[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[reference.length];
}

async function main() {
  const baseline = await import(pathToFileURL(path.join(baselineRoot, 'src/pipeline.ts')).href) as Pipeline;
  const candidate = await import(pathToFileURL(path.join(candidateRoot, 'src/pipeline.ts')).href) as Pipeline;
  const requested = requestedFixtures ? new Set(requestedFixtures.split(',').filter(Boolean)) : undefined;
  const fixtures = fs.readdirSync(fixtureRoot)
    .filter(name => fs.statSync(path.join(fixtureRoot, name)).isDirectory())
    .filter(name => fs.existsSync(path.join(fixtureRoot, name, 'audio.opus')) && fs.existsSync(path.join(fixtureRoot, name, 'reference.txt')))
    .filter(name => !requested || requested.has(name))
    .sort();
  if (!fixtures.length) throw new Error('No fixtures with both audio.opus and reference.txt');

  const results: Array<{ fixture: string; baselineDistance: number; candidateDistance: number; referenceWords: number; retried: boolean }> = [];
  for (let index = 0; index < fixtures.length; index++) {
    // A normal pipeline decode makes two immediate calls; the candidate may make a third.
    // Keep paired batches below 20 transcription calls/minute, leaving room for the product.
    if (index > 0) await new Promise(resolve => setTimeout(resolve, 9_400));
    const name = fixtures[index];
    const dir = path.join(fixtureRoot, name);
    const settingsPath = path.join(dir, 'settings.json');
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    const reference = tokenize(fs.readFileSync(path.join(dir, 'reference.txt'), 'utf8'));
    const audio = fs.readFileSync(path.join(dir, 'audio.opus'));
    const prompt = baseline.contextPrompt(settings);
    const baselineResult = await baseline.transcribe(audio, 'audio.opus', prompt);
    await new Promise(resolve => setTimeout(resolve, 6_200));
    const candidateResult = await candidate.transcribe(audio, 'audio.opus', candidate.contextPrompt(settings));
    const baselineDistance = distance(tokenize(baselineResult.text), reference);
    const candidateDistance = distance(tokenize(candidateResult.text), reference);
    const baselineSimilarity = Math.max(0, 1 - baselineDistance / reference.length);
    const candidateSimilarity = Math.max(0, 1 - candidateDistance / reference.length);
    results.push({ fixture: name, baselineDistance, candidateDistance, referenceWords: reference.length, retried: candidateResult.lowConfidenceTailRetry });
    const delta = (candidateSimilarity - baselineSimilarity) * 100;
    console.log(`${name}\tbaseline ${(baselineSimilarity * 100).toFixed(1)}%\tcandidate ${(candidateSimilarity * 100).toFixed(1)}%\tΔ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp\tretry ${candidateResult.lowConfidenceTailRetry ? 'yes' : 'no'}`);
  }
  const baselineAverage = results.reduce((sum, r) => sum + Math.max(0, 1 - r.baselineDistance / r.referenceWords), 0) / results.length;
  const candidateAverage = results.reduce((sum, r) => sum + Math.max(0, 1 - r.candidateDistance / r.referenceWords), 0) / results.length;
  const totalWords = results.reduce((sum, r) => sum + r.referenceWords, 0);
  const baselineDistance = results.reduce((sum, r) => sum + r.baselineDistance, 0);
  const candidateDistance = results.reduce((sum, r) => sum + r.candidateDistance, 0);
  const baselineCorpusSimilarity = 1 - baselineDistance / totalWords;
  const candidateCorpusSimilarity = 1 - candidateDistance / totalWords;
  const retries = results.filter(result => result.retried).length;
  console.log(`MACRO (clipped)\tbaseline ${(baselineAverage * 100).toFixed(1)}%\tcandidate ${(candidateAverage * 100).toFixed(1)}%\tΔ ${((candidateAverage - baselineAverage) * 100).toFixed(1)}pp`);
  console.log(`CORPUS WER\tbaseline ${((baselineDistance / totalWords) * 100).toFixed(1)}%\tcandidate ${((candidateDistance / totalWords) * 100).toFixed(1)}%\tΔ ${(((candidateDistance - baselineDistance) / totalWords) * 100).toFixed(1)}pp`);
  console.log(`CORPUS SIMILARITY\tbaseline ${(baselineCorpusSimilarity * 100).toFixed(1)}%\tcandidate ${(candidateCorpusSimilarity * 100).toFixed(1)}%\t${results.length} fixtures; retry selector ${retries}/${results.length}`);
  if (candidateDistance > baselineDistance) {
    throw new Error('Candidate increased corpus WER; refusing to treat it as a non-regression.');
  }
}

main();
