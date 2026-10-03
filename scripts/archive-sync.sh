#!/usr/bin/env bash
# Sync data/archive/ with R2, so the hourly CI job can grow the archive without git.
#
#   scripts/archive-sync.sh pull    download + unpack the latest archive (fails if missing)
#   scripts/archive-sync.sh push    pack + upload, plus a dated daily copy (archive/daily/)
#
# Safety: push refuses to upload an archive with fewer hourly rows than the one it
# replaced, so a failed or partial run can never shrink the history.
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="${SWELL_R2_BUCKET:-taiwan-waves}"  # project-specific name: a generic R2_BUCKET from another project must not leak in
KEY="archive/cwa-archive.tar.gz"
TMP="${TMPDIR:-/tmp}/cwa-archive.tar.gz"
COUNT_FILE=".archive-rows"
wr() { npx wrangler r2 object "$@" --remote; }
rows() { cat data/archive/cwa-obs/*.csv 2>/dev/null | wc -l | tr -d ' '; }

case "${1:-}" in
  pull)
    wr get "$BUCKET/$KEY" --file "$TMP"
    rm -rf data/archive && mkdir -p data && tar -xzf "$TMP" -C data
    rows > "$COUNT_FILE"
    echo "pulled archive: $(cat "$COUNT_FILE") rows"
    ;;
  push)
    now=$(rows)
    before=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
    if (( now < before )); then
      echo "refusing to push: archive shrank from $before to $now rows" >&2
      exit 1
    fi
    COPYFILE_DISABLE=1 tar -czf "$TMP" --exclude "._*" -C data archive  # no macOS ._ metadata files
    wr put "$BUCKET/$KEY" --file "$TMP" --content-type application/gzip
    wr put "$BUCKET/archive/daily/$(date -u +%F).tar.gz" --file "$TMP" --content-type application/gzip
    echo "pushed archive: $now rows ($(du -h "$TMP" | cut -f1))"
    ;;
  *)
    echo "usage: $0 pull|push" >&2
    exit 2
    ;;
esac
