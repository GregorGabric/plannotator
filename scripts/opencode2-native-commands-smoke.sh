#!/usr/bin/env bash
# Verify the OpenCode 2 native slash commands against a host that actually has
# the post-#44765 command API.
#
# CI cannot do this: .github/workflows/test.yml pins @opencode-ai/cli to a
# `next` build, and `next` still ships the older command draft (no `add`), so
# the CI leg can only prove the fallback path. The command API currently lives
# on the `beta` and `dev` dist-tags, which move daily and are not something to
# pin a required check to. So this is a script a human runs before a release.
#
# Usage:
#   scripts/opencode2-native-commands-smoke.sh [dist-tag]      # default: dev
#
# What it proves:
#   1. The plugin activates without status:"failed".
#   2. All three slash commands resolve.
#   3. They resolve to the PLUGIN's definitions, not the markdown stubs the
#      fixture installs into the sandbox config dir exactly as install.sh does.
#      (3) is the shadowing check and is fatal here because of
#      PLANNOTATOR_SMOKE_EXPECT_NATIVE=1.
#
# What it does NOT prove: that /plannotator-review opens the UI without a model
# turn. Run that by hand in the TUI against the same build.

set -euo pipefail

tag="${1:-dev}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> installing @opencode-ai/cli@$tag into $work"
cd "$work"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "@opencode-ai/cli@$tag" >/dev/null
opencode_bin="$work/node_modules/.bin/opencode"
if [ ! -x "$opencode_bin" ]; then
  echo "No opencode binary at $opencode_bin" >&2
  exit 1
fi
"$opencode_bin" --version

echo "==> building and packing the plugin"
cd "$repo_root"
bun run build:opencode
cd "$repo_root/apps/opencode-plugin"
bun pm pack --filename "$work/plannotator-opencode.tgz" >/dev/null

echo "==> running the smoke with native commands required"
PLANNOTATOR_SMOKE_EXPECT_NATIVE=1 \
  bun run --cwd "$repo_root/apps/opencode-plugin" smoke:v2 -- \
  "$opencode_bin" \
  "$work/plannotator-opencode.tgz"
