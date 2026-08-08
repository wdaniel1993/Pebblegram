#!/usr/bin/env bash
# Ship a release PBW: builds the app (if needed) and copies the artifact to
# release/ named after the version from package.json, e.g.
#   release/Pebblegram-v1.0.33.pbw
# Usage: tools/make-release.sh [--skip-build]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./package.json').version)")
OUT="release/Pebblegram-v${VERSION}.pbw"

if [[ "${1:-}" != "--skip-build" ]]; then
  echo "==> Building v${VERSION}..."
  pebble build
fi

mkdir -p release
cp build/pebblegram.pbw "$OUT"
echo "==> Release artifact: $OUT ($(stat -f%z "$OUT") bytes)"
# Cross-check the version baked into the PBW's appinfo.json matches package.json
APPINFO_VERSION=$(python3 -c "import zipfile,json;print(json.loads(zipfile.ZipFile('build/pebblegram.pbw').read('appinfo.json'))['versionLabel'])")
echo "==> appinfo version: $APPINFO_VERSION"
if [[ "$APPINFO_VERSION" != "$VERSION" ]]; then
  echo "ERROR: appinfo version ($APPINFO_VERSION) != package.json ($VERSION)" >&2
  exit 1
fi
