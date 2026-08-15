#!/usr/bin/env bash
# Assemble the deployable web bundle. Run before `cdk deploy`.
#
#   bash aws/scripts/build-web.sh
#
# Produces two directories the CDK web stack reads:
#   aws/.build/web     - the Lambda deployment package
#   aws/.build/static  - the objects that go to S3 behind CloudFront
#
# THE TWO MUST COME FROM ONE BUILD. Next content-hashes every chunk filename per
# build for cache busting, so uploading static assets from one build alongside a
# server from another yields a 404 on every chunk - a failure that reads like a
# CloudFront misconfiguration and is not. That is the whole reason this is one
# script rather than two commands.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"
OUT="$ROOT/aws/.build"

echo "==> clean"
rm -rf "$OUT"
mkdir -p "$OUT/web" "$OUT/static"

echo "==> next build (standalone)"
pnpm build

if [ ! -d ".next/standalone" ]; then
  echo "ERROR: .next/standalone missing. Is output:'standalone' still set in next.config.ts?" >&2
  exit 1
fi

echo "==> assemble lambda package"
cp -R .next/standalone/. "$OUT/web/"

# The standalone trace deliberately excludes static assets and public/, because
# it assumes a CDN in front. There is one - CloudFront - but the Lambda still
# needs them for any request that reaches it directly, and for the first render
# before the CDN is warm.
mkdir -p "$OUT/web/.next"
cp -R .next/static "$OUT/web/.next/static"
[ -d public ] && cp -R public "$OUT/web/public"

# The RDS certificate authority is compiled into lib/db/rds-ca.ts, so it is
# already inside the bundle. Nothing to copy - that is why it is a TS module and
# not a .pem on disk. See lib/db/rds-ca.ts.

echo "==> assemble static upload"
cp -R .next/static/. "$OUT/static/"

echo "==> entrypoint"
# The adapter's bootstrap execs this. `exec` matters: without it Node runs as a
# child of bash, and the SIGTERM Lambda sends on shutdown goes to bash instead
# of Node, so graceful shutdown never happens and `after()` callbacks are lost.
cat > "$OUT/web/run.sh" <<'RUNSH'
#!/bin/bash
exec node server.js
RUNSH
chmod +x "$OUT/web/run.sh"

echo
echo "web bundle:    $(du -sh "$OUT/web" | cut -f1)  ($OUT/web)"
echo "static upload: $(du -sh "$OUT/static" | cut -f1)  ($OUT/static)"
echo
# Lambda's hard limit is 250 MB unzipped. Warn well before it, because the
# failure arrives at deploy time after a full CloudFormation round trip.
SIZE_MB=$(du -sm "$OUT/web" | cut -f1)
if [ "$SIZE_MB" -gt 200 ]; then
  echo "WARNING: web bundle is ${SIZE_MB} MB; Lambda's unzipped limit is 250 MB." >&2
fi
echo "ok"
