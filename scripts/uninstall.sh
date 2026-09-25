#!/bin/sh
# Roll back the plannotator-dsh install from a DSH profile.
#
#   scripts/uninstall.sh [profile]     # default profile: desktop
#
# Removes the dependency and the bundle entry from the profile's package.json,
# deletes the installed copy from the profile's node_modules, and prunes the
# plugin's data directory when --purge is passed.

set -eu

PROFILE="${1:-desktop}"
PURGE="${2:-}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"

if [ ! -f "$PKG" ]; then
  echo "no profile package.json at $PKG" >&2
  exit 1
fi

"$NODE" -e '
const fs = require("node:fs");
const file = process.argv[1];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
delete data.dependencies?.["plannotator-dsh"];
const bundles = data.dsh?.profile?.bundles;
if (Array.isArray(bundles)) data.dsh.profile.bundles = bundles.filter((name) => name !== "plannotator-dsh");
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
console.log("pruned plannotator-dsh from", file);
' "$PKG"

rm -rf "$PROFILE_DIR/node_modules/plannotator-dsh"
echo "removed $PROFILE_DIR/node_modules/plannotator-dsh"

(
  cd "$PROFILE_DIR"
  "$NODE" "$PNPM" install --lockfile-only >/dev/null 2>&1 || true
)

if [ "$PURGE" = "--purge" ]; then
  rm -rf "$HOME/.dsh/storages/plannotator-dsh"
  echo "purged $HOME/.dsh/storages/plannotator-dsh"
fi

echo "restart DeepSeek Harness to unload the plugin"
