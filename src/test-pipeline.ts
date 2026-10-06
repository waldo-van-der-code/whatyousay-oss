/**
 * Test script for the transcription pipeline.
 * Usage: tsx src/test-pipeline.ts <path-to-ogg-file>
 *
 * Requires GROQ_API_KEY and OPENAI_API_KEY in .env
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { runPipeline } from './pipeline';
import { DEFAULT_SETTINGS } from './auth';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: tsx src/test-pipeline.ts <path-to-ogg-file>');
  process.exit(1);
}

const buffer = fs.readFileSync(path.resolve(filePath));
console.log(`Running pipeline on ${filePath} (${buffer.length} bytes)...`);

runPipeline(buffer, { ...DEFAULT_SETTINGS })
  .then(result => {
    console.log('\n--- RESULT ---');
    console.log(`Language: ${result.language}`);
    console.log(`Duration: ${result.duration}s`);
    console.log(`Words: ${result.transcript.split(/\s+/).length}`);
    console.log(`Tokens: ${result.inputTokens} in / ${result.outputTokens} out`);
    console.log('\n--- REPLY ---\n');
    console.log(result.replyText);
  })
  .catch(err => {
    console.error('Pipeline failed:', err);
    process.exit(1);
  });
