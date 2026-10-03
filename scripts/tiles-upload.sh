#!/usr/bin/env bash
# Upload tiles/taiwan.pmtiles to R2, whatever its size, with no S3 keys:
# deploys the temporary swell-upload Worker (R2 binding + one-time secret), uploads in
# 64 MB parts through it, then deletes the Worker again.
#
#   bun run tiles:upload
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:-tiles/taiwan.pmtiles}"
KEY="${2:-taiwan.pmtiles}"
CFG=workers/upload/wrangler.jsonc

cleanup() { npx wrangler delete -c "$CFG" --force >/dev/null 2>&1 || true; }
trap cleanup EXIT

TOKEN=$(openssl rand -hex 24)
npx wrangler deploy -c "$CFG" >/dev/null
printf '%s' "$TOKEN" | npx wrangler secret put UPLOAD_TOKEN -c "$CFG" >/dev/null

echo "Waiting for upload.swell.fyi…"
for _ in $(seq 1 60); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST 'https://upload.swell.fyi/create?key=x')" == "403" ]] && break
  sleep 10
done

UPLOAD_TOKEN="$TOKEN" node scripts/r2-upload.mjs "$FILE" "$KEY"
echo "Uploaded $FILE → r2://taiwan-waves/$KEY. Tile caches expire within a day."
