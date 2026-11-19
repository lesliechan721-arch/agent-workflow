#!/usr/bin/env bash
set -euo pipefail

output=$1
core=packages/plugin-core
patch_dir=scripts/qualification/catalog-reads

build_variant() {
  local variant=$1
  local destination="$output/$variant/$core"
  pnpm --filter @lesliechan721/aw-plugin-core build
  mkdir -p "$destination"
  cp -R "$core/dist" "$core/schemas" "$core/package.json" "$destination/"
  node --input-type=module - "$core/node_modules" "$destination/node_modules" <<'JS'
import { symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
symlinkSync(resolve(process.argv[2]), resolve(process.argv[3]), process.platform === 'win32' ? 'junction' : 'dir');
JS
}

build_variant serial
for width in 4 8; do
  patch="$patch_dir/digest-$width.patch"
  git apply --check "$patch"
  git apply "$patch"
  if [ "$width" = 4 ]; then
    build_variant four
  else
    build_variant eight
  fi
  git apply --reverse "$patch"
done
