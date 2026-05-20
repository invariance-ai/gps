#!/usr/bin/env bash
# DEPRECATED: prefer `scripts/release.ts` (canonical entrypoint with version-bump,
# branch + dirty-tree guards, and lockstep commit/tag). This script is kept for
# muscle-memory dry-runs only: `pnpm release:dry` wraps `scripts/publish.sh --dry-run`.
#
# Publish gps packages to npm in dependency order.
#
# Usage:
#   scripts/publish.sh            # full publish
#   scripts/publish.sh --dry-run  # no upload, just resolve the would-publish tarball
#
# pnpm rewrites `workspace:*` deps to the package's current version on publish,
# so the order below matters: deps published first, dependents second.

set -euo pipefail
cd "$(dirname "$0")/.."

DRY=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY="--dry-run"
fi

echo "==> building all packages"
pnpm -r build

PKGS=(
  "@invariance/gps-schemas"
  "@invariance/gps-core"
  "@invariance/gps-llm"
  "@invariance/gps-mcp"
  "@invariance/gps"
)

for pkg in "${PKGS[@]}"; do
  echo ""
  echo "==> publishing $pkg $DRY"
  pnpm -F "$pkg" publish --access public --no-git-checks $DRY
done

echo ""
echo "done. install with: npx @invariance/gps wizard"
