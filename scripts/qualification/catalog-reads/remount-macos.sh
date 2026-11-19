#!/usr/bin/env bash
set -euo pipefail

input=$1
builds=$2
probe="$PWD/scripts/qualification/catalog-reads/probe.mjs"
scratch=$(mktemp -d "$RUNNER_TEMP/aw-catalog-remount.XXXXXX")
scratch=$(cd "$scratch" && pwd -P)
image="$scratch/catalog.dmg"
mountpoint="$scratch/mounted"
mounted=false

cleanup() {
  if [ "$mounted" = true ]; then
    hdiutil detach "$mountpoint" -quiet || return
  fi
  rm -f "$image"
  if [ -d "$mountpoint" ]; then rmdir "$mountpoint"; fi
  rmdir "$scratch"
}
trap cleanup EXIT

mkdir "$mountpoint"
hdiutil create -size 128m -fs APFS -volname AWCatalog -format UDRW "$image" -quiet
hdiutil attach "$image" -mountpoint "$mountpoint" -noverify -noautoopen -quiet
mounted=true
(cd "$mountpoint" && tar -xzf -) < "$input/catalog.tgz"
hdiutil detach "$mountpoint" -quiet
mounted=false
test ! -e "$mountpoint/catalog"

for variant in serial four eight; do
  hdiutil attach "$image" -mountpoint "$mountpoint" -readonly -noverify -noautoopen -quiet
  mounted=true
  /sbin/mount | grep -F " on $mountpoint (" | grep -F -q 'read-only'
  node "$probe" --mode remounted-read --root "$builds/$variant" --catalog "$mountpoint/catalog" \
    --output "$input/$variant-remounted.json"
  hdiutil detach "$mountpoint" -quiet
  mounted=false
  test ! -e "$mountpoint/catalog"
done
