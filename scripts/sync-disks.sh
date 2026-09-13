#!/usr/bin/env bash
# Push disk chunks and ROMs to R2. Neither ever enters git: the chunks are built
# from Apple system software and third-party titles, and the ROMs are Apple's.
#
#   scripts/sync-disks.sh              # chunks + roms
#   scripts/sync-disks.sh roms         # roms only
#   scripts/sync-disks.sh chunks       # chunks only
#
# Uses wrangler rather than rclone so there is one credential to manage. For a
# large first upload rclone is much faster; scripts/rclone.conf.example in the
# vendored Infinite Mac repo shows the R2 remote configuration if you want it.
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET="macemu-disk"
what="${1:-all}"

up() { # up <local> <key>
  if npx wrangler r2 object get "$BUCKET/$2" --remote >/dev/null 2>&1; then
    printf "  skip  %s (already in R2)\n" "$2"
    return
  fi
  npx wrangler r2 object put "$BUCKET/$2" --file "$1" \
    --content-type application/octet-stream --remote >/dev/null
  printf "  put   %s\n" "$2"
}

if [ "$what" = "all" ] || [ "$what" = "roms" ]; then
  echo "ROMs → r2://$BUCKET/rom/"
  for f in Images/rom/*.rom; do [ -e "$f" ] || continue; up "$f" "rom/$(basename "$f")"; done
fi

if [ "$what" = "all" ] || [ "$what" = "chunks" ]; then
  echo "Chunks → r2://$BUCKET/"
  # Content-addressed names mean an existing key is definitionally the same
  # bytes, so skipping what is already there is safe and makes re-syncs cheap.
  n=0
  for f in Images/build/*.chunk; do
    [ -e "$f" ] || continue
    up "$f" "$(basename "$f")"
    n=$((n+1))
  done
  echo "  $n chunk(s) considered"
fi

echo "Done. Deploy the manifests too — they live in public/mac/disks/ and are served by Pages."
