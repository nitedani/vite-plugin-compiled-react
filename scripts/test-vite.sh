#!/bin/sh
# Type-checks and tests the plugin and the example with a major version of Vite, in a copy of the
# repository: scripts/test-vite.sh 6
set -eu
major=$1
cd "$(dirname "$0")/.."
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
git ls-files -co --exclude-standard -z | tar -c --null -T - | tar -x -C "$dir"
cd "$dir"
pnpm --filter ./vite-plugin-compiled-react add -D --allow-build=esbuild "vite@$major"
# Vite 6 and 7 install esbuild, and @vitejs/plugin-react 6 needs Vite 8.
pnpm --filter ./example add --allow-build=esbuild "vite@$major" "@vitejs/plugin-react@$([ "$major" -ge 8 ] && echo 6 || echo 5)"
pnpm test
pnpm typecheck
