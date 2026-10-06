import path from 'node:path';
import dotenv from 'dotenv';

// Manual run of the transcription retention job (ME-065).
//   node dist/retention-cli.js            dry run: counts the rows it WOULD pseudonymise
//   node dist/retention-cli.js --apply    rewrites them — stop pm2 first: never write
//                                         to the DB from a second process
// The server runs the same job daily at 04:15 Berlin, so --apply is rarely needed.
// Output is counts plus a key fingerprint (keyId), never JIDs or names.

// Resolve .env and the default DB path from the checkout, not the caller's cwd: run
// from elsewhere, the CLI would otherwise open (and create) an empty ./whatyousay.db.
const root = path.join(__dirname, '..');
process.chdir(root);
dotenv.config({ path: path.join(root, '.env') });

const apply = process.argv.includes('--apply');
if (apply && !(process.env.DB_ENCRYPTION_KEY ?? '').trim()) {
  // Without the real key the hashes come from a dev key and would never match the
  // ones the server writes, splitting every sender in two.
  console.error('Refusing --apply: DB_ENCRYPTION_KEY is not set');
  process.exit(1);
}

// Required after chdir/dotenv: db.ts reads DB_PATH and the cwd when it loads.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDb } = require('./db') as typeof import('./db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RETENTION_DAYS, runRetention, anonKeyId } = require('./retention') as typeof import('./retention');

const r = runRetention(getDb(), { dryRun: !apply });
console.log(JSON.stringify({ retentionDays: RETENTION_DAYS, keyId: anonKeyId(), ...r }));
