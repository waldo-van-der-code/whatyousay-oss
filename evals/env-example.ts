import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

// Regression WAY-58: start.sh sources .env with bash. An unquoted
// `EMAIL_FROM=WhatYouSay <hello@...>` made bash fail on the `<`, so a .env
// copied from env.example crashed production startup.
const file = path.join(__dirname, '..', 'env.example');

try {
  execFileSync('bash', ['-c', 'set -a; source "$0"', file], { stdio: 'pipe' });
} catch (err) {
  console.error('✗ env.example is not valid bash, so start.sh would fail:\n' + String((err as { stderr?: Buffer }).stderr ?? err));
  process.exit(1);
}

const sourced = execFileSync('bash', ['-c', 'set -a; source "$0"; printf %s "$EMAIL_FROM"', file]).toString();
const parsed = parse(fs.readFileSync(file));
if (sourced !== parsed.EMAIL_FROM || !sourced.includes('<')) {
  console.error(`✗ bash and dotenv disagree on EMAIL_FROM: ${JSON.stringify(sourced)} vs ${JSON.stringify(parsed.EMAIL_FROM)}`);
  process.exit(1);
}
console.log('✓ env.example sources cleanly in bash and matches dotenv');
