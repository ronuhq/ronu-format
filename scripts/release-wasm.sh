#!/usr/bin/env bash
# Build the wasm validator binding as an npm package and stamp it with a
# trunk-based version, ready for `npm publish`.
#
# The format is unversioned until v1.0 (the commit hash is the version), and
# npm needs semver. So the package version is a pre-release that encodes the
# date and commit: 0.0.0-20260909.abc1234. Consumers pin exact versions; the
# `next` dist-tag means "trunk", and nothing ever claims to be 0.1.
#
#   scripts/release-wasm.sh          # build + stamp, print the publish command
#   scripts/release-wasm.sh --publish   # also run npm publish (needs npm login)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v wasm-pack >/dev/null || { echo "wasm-pack is required: cargo install wasm-pack"; exit 1; }
command -v node >/dev/null || { echo "node is required"; exit 1; }

if [ -n "$(git status --porcelain rust bindings spec schema)" ]; then
  echo "working tree has uncommitted changes under rust/, bindings/, spec/ or schema/; commit first so the version means something"
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
DATE="$(date -u +%Y%m%d)"
VERSION="0.0.0-${DATE}.${SHA}"

wasm-pack build bindings/wasm --release --target web --scope ronuhq

PKG="bindings/wasm/pkg/package.json"
node - "$PKG" "$VERSION" "$SHA" <<'EOF'
const fs = require("fs");
const [file, version, sha] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.name = "@ronuhq/ronu-wasm";
pkg.version = version;
pkg.description = "The .ronu format's reference validator (Rust) compiled to WebAssembly, for JavaScript and TypeScript.";
pkg.repository = { type: "git", url: "https://github.com/ronuhq/ronu-format", directory: "bindings/wasm" };
pkg.homepage = "https://github.com/ronuhq/ronu-format";
pkg.keywords = ["ronu", "learning", "simulation", "file-format", "validator", "wasm"];
pkg.sideEffects = ["./ronu_wasm.js"];
pkg.ronuFormatCommit = sha;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
EOF

cp README.md bindings/wasm/pkg/README.md 2>/dev/null || true
cp bindings/wasm/README.md bindings/wasm/pkg/README.md

echo
echo "built @ronuhq/ronu-wasm@${VERSION} in bindings/wasm/pkg"
echo
if [ "${1:-}" = "--publish" ]; then
  ( cd bindings/wasm/pkg && npm publish --access public --tag next )
else
  echo "to publish (needs npm login with rights to the @ronuhq scope):"
  echo "  cd bindings/wasm/pkg && npm publish --access public --tag next"
fi
