# macemu

Run classic Macintosh software — System 6, System 7, Mac OS 8 and 9 — in a
browser tab. One URL per title, no download, no install, nothing uploaded.

Sister site to [exebrowser.com](https://exebrowser.com), which does the same for
DOS and Windows.

## How it works

The emulators are WebAssembly builds of **Mini vMac** (68k, black and white),
**Basilisk II** (68k, System 7 – Mac OS 8.1) and **SheepShaver** (PowerPC, Mac
OS 8.1 – 9.0.4), vendored from a fork of
[Infinite Mac](https://github.com/mihaip/infinite-mac) by Mihai Parparita
(Apache-2.0). Infinite Mac did the hard part; this site is a catalogue and a set
of pages on top of it. If you want the whole machine rather than one title,
go there — and consider [donating](https://infinitemac.org/donate).

Disk images are split into 256 KB content-addressed chunks and fetched lazily,
so a title starts in a couple of seconds instead of after a 200 MB download.
Chunks and ROMs live in Cloudflare R2 and are served same-origin by Pages
Functions.

## Layout

| Path | What it is |
|---|---|
| `scripts/` | Zero-dependency Node ESM generators. `app-pages.json` is the single source of truth for the catalogue. |
| `public/` | The deployed site. Everything here is static except `functions/`. |
| `functions/` | Cloudflare Pages Functions: R2 bridges and the header middleware. |
| `vendor/infinite-mac/` | Pinned fork of Infinite Mac; the emulator build lives here. |
| `Images/` | Local only, never committed: raw disk images, ROMs, built chunks. |

## Build and deploy

```sh
node scripts/gen-app-pages.mjs      # /run/, /play/, /embed/, hub, sitemap, feed, llms.txt
node scripts/gen-home-grid.mjs      # homepage grid in place
node scripts/check-consistency.mjs  # gate — exits non-zero if anything drifted
npx wrangler pages deploy public --project-name=macemu
node scripts/indexnow.mjs           # Bing indexes this site faster than Google does
```

Disk work is separate and rare:

```sh
scripts/build-mac-runtime.sh        # Docker + Emscripten; rebuilds the emulators
node scripts/chunk-disk.mjs Images/titles/marathon.img marathon-v1
scripts/sync-disks.sh               # rclone Images/build → R2
```

## Licensing

Site code: see `LICENSE`. The emulators are GPL-2 and their sources are the
pinned submodules of the vendored fork. Every hosted title carries a
`NOTICE.md` recording where it came from and why it is here. If you hold rights
to something on this site and want it gone, see `/takedown/` — it comes down
within 48 hours, no argument.

## DNS

macemu.com is registered at Namecheap. Both `macemu.com` and `www.macemu.com`
are already attached to the Pages project as custom domains and sit in
`pending` until DNS points at Cloudflare.

**If you move DNS to Cloudflare** (recommended — the apex works without an ALIAS
record, and you get caching and analytics in front of the site): add the site at
dash.cloudflare.com, which issues the nameserver pair, then set those two as
Custom DNS at Namecheap. Pages creates the records for both custom domains by
itself once the zone is active. Nameservers cannot be issued before the zone
exists, and they are assigned per zone — this account already uses two different
pairs, so they cannot be guessed from another domain.

**If you keep Namecheap DNS**, set these on Namecheap's Advanced DNS tab:

| Type | Host | Value |
|---|---|---|
| ALIAS Record | `@` | `macemu.pages.dev` |
| CNAME Record | `www` | `macemu.pages.dev` |

Namecheap's ALIAS record is what makes the apex work; a plain CNAME at `@` is
not valid DNS. Certificates issue automatically once the records resolve.

## Deploy

```sh
node scripts/gen-pages.mjs
node scripts/check-consistency.mjs          # gate
npx wrangler pages deploy public --project-name=macemu --branch=main
bash scripts/smoke-test.sh https://macemu.com
node scripts/indexnow.mjs
```
