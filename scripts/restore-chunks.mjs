#!/usr/bin/env node
// Re-hydrate Images/build from the live site. Chunks never enter git — they
// are content-addressed and R2 is their only real backup — so after
// `Images/build` is pruned or a fresh clone has none, this is how the local
// cache comes back for boot-testing, re-chunking, or check-consistency.
//
//   node scripts/restore-chunks.mjs              # every chunk any manifest references
//   node scripts/restore-chunks.mjs oregon-trail # only this title's own + extra disks
//   node scripts/restore-chunks.mjs system-7.5.3 # or one disk, by manifest name
//   node scripts/restore-chunks.mjs --base https://macemu.com
//
// Each download is self-verifying: the file name IS blake2b(bytes), so a
// corrupt or truncated fetch is caught immediately and retried rather than
// silently written.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chunkSignature } from "./chunk-disk.mjs";

const ROOT = process.cwd();
const DISKS = resolve(ROOT, "public/mac/disks");
const BUILD = resolve(ROOT, "Images/build");

const args = process.argv.slice(2);
let base = "https://macemu.pages.dev";
const bi = args.indexOf("--base");
if (bi !== -1) { base = args[bi + 1]; args.splice(bi, 2); }
const slug = args[0];

function manifestsFor(slug) {
  if (!slug) return readdirSync(DISKS).filter((f) => f.endsWith(".json")).map((f) => join(DISKS, f));
  // A disk with no title of its own (the loader's system-7.5.3, the shared
  // OS images) is named directly.
  if (existsSync(join(DISKS, `${slug}.json`))) return [join(DISKS, `${slug}.json`)];
  const pages = JSON.parse(readFileSync(resolve(ROOT, "scripts/app-pages.json"), "utf8"));
  const p = pages.find((x) => x.slug === slug);
  if (!p) throw new Error(`no catalogue entry for slug "${slug}"`);
  const names = [p.bootDisk, ...(p.extraDisks || [])].filter(Boolean);
  if (!names.length) throw new Error(`${slug} has no bootDisk`);
  return names.map((n) => join(DISKS, `${n}.json`));
}

const wanted = new Set();
for (const m of manifestsFor(slug)) {
  for (const c of JSON.parse(readFileSync(m, "utf8")).chunks || []) if (c) wanted.add(c);
}

mkdirSync(BUILD, { recursive: true });
const need = [...wanted].filter((h) => !existsSync(join(BUILD, `${h}.chunk`)));
console.log(`${wanted.size} chunks referenced, ${need.length} missing locally, fetching from ${base}`);

let ok = 0, failed = 0;
const queue = need.slice();
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let hash; (hash = queue.shift()); ) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        const res = await fetch(`${base}/Disk/${hash}.chunk`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const got = chunkSignature(bytes);
        if (got !== hash) throw new Error(`hash mismatch: got ${got}`);
        writeFileSync(join(BUILD, `${hash}.chunk`), bytes);
        ok++;
        done = true;
      } catch (e) {
        if (attempt === 2) { failed++; console.error(`  FAILED ${hash}: ${e.message}`); }
      }
    }
  }
}));

console.log(`restored ${ok}, failed ${failed}`);
if (failed) process.exit(1);
