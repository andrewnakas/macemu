#!/usr/bin/env bash
# Fetch the Apple system software needed to boot anything, into Images/.
#
#   scripts/fetch-system-software.sh
#
# Nothing downloaded here is committed: Images/ is gitignored in full. The
# files are Apple's. They are cached locally, chunked by scripts/chunk-disk.mjs
# and served from R2, which is the same footing the Internet Archive, Macintosh
# Garden and the Infinite Mac project have operated on for years. If Apple asks,
# /takedown/ is a 48-hour promise.
#
# ROMs come from the vendored Infinite Mac checkout, which commits them.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p Images/rom Images/system Images/build

echo "ROMs from vendor/infinite-mac/src/Data/"
for r in Mac-Plus Mac-SE Mac-II Quadra-650 Power-Macintosh-G3; do
  src="vendor/infinite-mac/src/Data/$r.rom"
  if [ -f "$src" ]; then
    cp -n "$src" "Images/rom/$r.rom" 2>/dev/null || true
    printf "  %-22s %s\n" "$r.rom" "$(du -h "Images/rom/$r.rom" | cut -f1)"
  else
    printf "  %-22s MISSING — run: git submodule update --init --depth 1\n" "$r.rom"
  fi
done

cat <<'NOTE'

System disk images are NOT downloaded automatically, on purpose.

A bootable image is not a file you can fetch and trust — it has to be the right
system version for the machine, have the right extensions enabled, and carry
StuffIt Expander for the loader pages to be any use. Building one is a manual,
one-time job:

  1. Get a System 7.5.3 install set. Apple published 7.5.3 as a free download
     and the Internet Archive mirrors it; Macintosh Garden has it too.
  2. Boot the installer in the emulator and install onto a blank image, or
     start from a prepared image if you have one.
  3. Add StuffIt Expander so the /load-mac-file/ pages can expand what people
     drop in.
  4. Save it as a raw .dsk / .img in Images/system/.

Then, for each title, the per-title image is that base plus the application
plus an alias in System Folder:Startup Items so it launches at boot:

  node scripts/chunk-disk.mjs Images/system/system-7.5.3.img system-7.5.3
  node scripts/chunk-disk.mjs Images/titles/marathon.img marathon-v1
  scripts/sync-disks.sh

Content-addressed chunks mean every title shares the base system's chunks, so
the twentieth title costs the size of the game, not the size of a Macintosh.

Finally add "bootDisk": "marathon-v1" to the entry in scripts/app-pages.json.
Until that field exists the page is a bring-your-own-copy guide, which is
honest and is what check-consistency.mjs enforces.
NOTE
