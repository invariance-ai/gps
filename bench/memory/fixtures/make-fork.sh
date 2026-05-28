#!/usr/bin/env bash
#
# Build the contamination-control fixture for the memory benchmark (E5).
#
# Clones ky at a pinned SHA and deterministically rebrands `ky`/`Ky`/`KyError` -> `veki`/`Veki`/
# `VekiError` (package name, identifiers, filenames). The arbitrary/contrarian rule VALUES (17s,
# 13s, the trace header, retry-POST, cancelToken, no-throw-on-404) are unchanged — only the
# library's identity is mangled, so the model cannot lean on training-data familiarity with ky.
# If the gps-vs-baseline lift survives on code the model has never seen, the lift is memory.
#
# Usage: bash bench/memory/fixtures/make-fork.sh [dest-dir]
#   dest-dir defaults to bench/memory/fixtures/forkky
#   override the pinned commit with KY_SHA=<sha>
set -euo pipefail

DEST="${1:-bench/memory/fixtures/forkky}"
PIN="${KY_SHA:-61d6d66d27911001b9b4d57ab93139f9ad61384b}"

# Use perl for the rewrites: it supports \b word boundaries portably (BSD sed on macOS does not),
# and is present on both macOS and Linux.

echo "cloning ky @ ${PIN} -> ${DEST}"
rm -rf "$DEST"
git clone --quiet https://github.com/sindresorhus/ky.git "$DEST"
git -C "$DEST" checkout --quiet "$PIN"

echo "rebranding ky -> veki"
# Rename brand-named files first; KyError before Ky so the longer name wins.
mv "$DEST/source/errors/KyError.ts" "$DEST/source/errors/VekiError.ts"
mv "$DEST/source/core/Ky.ts"        "$DEST/source/core/Veki.ts"
mv "$DEST/source/types/ky.ts"       "$DEST/source/types/veki.ts"

# Identifier + import-path rewrites across all source files. Capital-"Ky" is brand-only in this
# source (covers Ky, KyError, KyInstance, KyOptions, ...). Lowercase "\bky" is boundary-anchored so
# it catches the brand prefix (ky, kyOptionKeys, kystop, ./types/ky.js) without touching words like
# "key" or "Tokyo".
find "$DEST/source" -type f -name '*.ts' -exec \
  perl -i -pe 's/Ky/Veki/g; s/\bky/veki/g' {} +

# Package identity.
perl -i -pe 's/"name": "ky"/"name": "veki"/' "$DEST/package.json"

# Re-commit so the reset helpers (`git checkout -- .`) restore THIS rebranded baseline, not ky's.
git -C "$DEST" add -A
git -C "$DEST" -c user.email=bench@gps -c user.name=bench commit --quiet \
  -m "rebrand ky->veki (benchmark contamination control, base ${PIN})"

echo "fork ready at ${DEST} (base ${PIN})"
echo "spot-check:"
grep -rl "\bVeki\b" "$DEST/source" | head -3
