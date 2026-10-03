#!/usr/bin/env bash
# Publish the CSV archive (data/archive/cwa-obs) to R2, where the swell-data Worker serves it:
#   cwa/csv/{id}.csv           each station's whole archive (downloads on the buoy pages)
#   cwa/archive-index.json     first/last hour and row count per station
# With --windows, also seed the Worker's live 120-day windows (cwa/obs/{id}.json) from the
# archive. Only needed once, or after a history backfill: from then on the Worker merges
# each new 48 h file into them itself, so routine runs must not overwrite them.
#
#   bun run fetch && scripts/publish-archive.sh [--windows]
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="${SWELL_R2_BUCKET:-taiwan-waves}"  # project-specific name: a generic R2_BUCKET from another project must not leak in
SRC=public/data/cwa
TMP="${TMPDIR:-/tmp}"

[[ -f "$SRC/archive-index.json" ]] || { echo "no $SRC/archive-index.json: run bun run fetch first" >&2; exit 1; }

# A wrangler bulk-put manifest: [{ key, file }] for every file in a directory.
manifest() { # dir ext out
  bun -e '
    const [dir, ext, out] = process.argv.slice(1);
    const files = (await import("node:fs")).readdirSync(dir).filter((f) => f.endsWith(ext));
    await Bun.write(out, JSON.stringify(files.map((f) => ({ key: `cwa/${dir.split("/").pop()}/${f}`, file: `${dir}/${f}` }))));
    console.log(`${files.length} files from ${dir}`);
  ' "$1" "$2" "$3"
}

manifest "$SRC/csv" .csv "$TMP/swell-csv.json"
npx wrangler r2 bulk put "$BUCKET" --remote -f "$TMP/swell-csv.json" --content-type "text/csv; charset=utf-8" --concurrency 16
if [[ "${1:-}" == "--windows" ]]; then
  manifest "$SRC/obs" .json "$TMP/swell-obs.json"
  npx wrangler r2 bulk put "$BUCKET" --remote -f "$TMP/swell-obs.json" --content-type application/json --concurrency 16
fi
# The index last, so the Worker never counts rows the CSVs don't have yet.
npx wrangler r2 object put "$BUCKET/cwa/archive-index.json" --remote --file "$SRC/archive-index.json" --content-type application/json
echo "published archive to r2://$BUCKET/cwa/"
