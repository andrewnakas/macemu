# Emulator runtime notice

Everything in this directory except this file and `disks/*.json` is build
output of `scripts/build-mac-runtime.sh` and is not committed.

## Infinite Mac (glue, worker, service worker, UI plumbing)

- Upstream: https://github.com/mihaip/infinite-mac
- Pinned commit: `283d34c` ("Also enable A/UX when the filter is explicitly
  requested."), vendored at `vendor/infinite-mac/`
- License: Apache-2.0 (`vendor/infinite-mac/LICENSE`)
- `mac-runtime.js`, `worker.js`, `emulator-service-worker.js` and
  `emulator-audio-worklet.js` are built from that checkout plus the thin,
  React-free entry in `vendor/infinite-mac/runtime/` (also Apache-2.0).

## Emulators (`*.wasm` and the matching `*.js` Emscripten glue)

The WebAssembly binaries are the prebuilt artifacts committed upstream in
`vendor/infinite-mac/src/emulator/worker/emscripten/`. They are GPL-2.0
software; their sources are the pinned submodules of the upstream checkout:

| Files | Project | Source |
|---|---|---|
| `BasiliskII.wasm`, `BasiliskII.js` | Basilisk II (68k, System 7 – Mac OS 8.1) | https://github.com/mihaip/macemu (fork of https://github.com/cebix/macemu), GPL-2.0 |
| `SheepShaver.wasm`, `SheepShaver.js` | SheepShaver (PowerPC, Mac OS 8.1 – 9.0.4) | https://github.com/mihaip/macemu (fork of https://github.com/cebix/macemu), GPL-2.0 |
| `minivmac-128K`, `-512Ke`, `-Plus`, `-SE`, `-II`, `-IIx` `.wasm`/`.js` | Mini vMac (68000/68020/68030 compact Macs) | https://github.com/mihaip/minivmac (fork of https://www.gryphel.com/c/minivmac/), GPL-2.0 |

Corresponding source for the exact builds: the `macemu` and `minivmac`
submodule commits recorded in `vendor/infinite-mac/.gitmodules` at commit
`283d34c`. Not shipped here: DingusPPC, PearPC, Previous and Snow, which the
runtime deliberately leaves out of the bundle.

## ROMs

The Macintosh ROM images the emulators need (`Mac-128K.rom`, `Mac-Plus.rom`,
`Mac-SE.rom`, `Mac-II.rom`, `Mac-IIx.rom`, `Mac-IIfx.rom`, `Quadra-650.rom`,
`Power-Macintosh-9500.rom`, `New-World.rom`, ...) are Apple Computer, Inc.
property. They are **not** part of this build and are **not committed** to this
repository; the runtime requests them from `/rom/<file>`, which a Pages
Function serves from a private R2 bucket. Nothing under `public/mac/` contains
ROM data.

## Disk chunks

`disks/*.json` are manifests produced by `scripts/chunk-disk.mjs`. The 256 KB
content-addressed chunks they reference live in R2 (served from `/Disk/`), not
in this repository. Each hosted disk image carries its own notice on the site.
