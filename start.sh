#!/bin/bash
# Production entry point (used by ecosystem.config.js). Run `npx tsc` first to build dist/.
set -e
cd "$(dirname "$0")"
set -a
source ./.env
set +a
# Production mode: Express stops putting stack traces in error responses,
# ALLOW_INSECURE_COOKIES is ignored, and a missing DB_ENCRYPTION_KEY stops startup
# instead of falling back to a dev key. Set here, not in .env, so evals run from the
# shell are unaffected.
export NODE_ENV=production
exec node ./dist/index.js
