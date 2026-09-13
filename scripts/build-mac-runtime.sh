#!/usr/bin/env bash
# Build the macemu emulator runtime bundle from vendor/infinite-mac into
# public/mac/. Re-runnable; no Docker or Emscripten needed because the vendored
# checkout commits its prebuilt .wasm/.js artifacts.
#
#   scripts/build-mac-runtime.sh            # install deps if missing, build
#   MACEMU_REINSTALL=1 scripts/build-mac-runtime.sh   # force npm install
#   MACEMU_TYPECHECK=1 scripts/build-mac-runtime.sh   # also run tsc on runtime/
#
# Output files (fixed names, see vendor/infinite-mac/vite.runtime.config.ts):
#   mac-runtime.js worker.js emulator-service-worker.js emulator-audio-worklet.js
#   BasiliskII.js SheepShaver.js minivmac-*.js  (+ matching .wasm)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/infinite-mac"
OUT="$ROOT/public/mac"

cd "$VENDOR"

# --- dependencies -----------------------------------------------------------
# `npm ci` refuses the pinned lockfile with npm 11 (it lacks optional @emnapi
# entries), so use `npm install --no-save` and put the lockfile back exactly as
# it was: the vendored checkout must stay byte-identical to upstream.
if [ ! -x node_modules/.bin/vite ] || [ "${MACEMU_REINSTALL:-0}" = "1" ]; then
    echo "==> installing dependencies in $VENDOR"
    TMPDIR_LOCK="$(mktemp -d)"
    cp package-lock.json "$TMPDIR_LOCK/package-lock.json"
    cp package.json "$TMPDIR_LOCK/package.json"
    restore_lock() {
        cp "$TMPDIR_LOCK/package-lock.json" package-lock.json
        cp "$TMPDIR_LOCK/package.json" package.json
        rm -rf "$TMPDIR_LOCK"
    }
    trap restore_lock EXIT
    if ! npm ci --no-audit --no-fund --loglevel=error 2>/dev/null; then
        npm install --no-save --no-audit --no-fund --loglevel=warn \
            --fetch-retries=5 --fetch-retry-mintimeout=2000 --fetch-timeout=120000
    fi
    restore_lock
    trap - EXIT
fi

# --- optional type check ----------------------------------------------------
if [ "${MACEMU_TYPECHECK:-0}" = "1" ]; then
    echo "==> type-checking runtime/"
    node_modules/.bin/tsc -p runtime/tsconfig.json
fi

# --- build ------------------------------------------------------------------
echo "==> building runtime into $OUT"
mkdir -p "$OUT"
node_modules/.bin/vite build --config vite.runtime.config.ts

# --- verify -----------------------------------------------------------------
EXPECTED=(
    mac-runtime.js
    worker.js
    emulator-service-worker.js
    emulator-audio-worklet.js
    BasiliskII.js BasiliskII.wasm
    SheepShaver.js SheepShaver.wasm
    minivmac-128K.js minivmac-128K.wasm
    minivmac-512Ke.js minivmac-512Ke.wasm
    minivmac-Plus.js minivmac-Plus.wasm
    minivmac-SE.js minivmac-SE.wasm
    minivmac-II.js minivmac-II.wasm
    minivmac-IIx.js minivmac-IIx.wasm
)
missing=0
for f in "${EXPECTED[@]}"; do
    if [ ! -s "$OUT/$f" ]; then
        echo "MISSING: $OUT/$f" >&2
        missing=1
    fi
done
if [ "$missing" = "1" ]; then
    echo "build did not emit every expected file" >&2
    exit 1
fi

if ! grep -q "MacEmulator" "$OUT/mac-runtime.js"; then
    echo "mac-runtime.js does not define MacEmulator" >&2
    exit 1
fi

echo "==> emitted to $OUT:"
(cd "$OUT" && ls -l *.js *.wasm | awk '{printf "  %10d  %s\n", $5, $9}')
echo "==> total: $(cd "$OUT" && cat *.js *.wasm | wc -c | tr -d ' ') bytes"
