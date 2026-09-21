#!/usr/bin/env node
// Lay the blocks an authoring session wrote over the image it started from.
//
//   node scripts/assemble-image.mjs --base Images/titles/work-avara.img \
//     --dirty Images/authored/avara --out Images/titles/work-avara-installed.img
//
// author-disk.mjs brings back only the chunks the emulated Mac actually wrote,
// as dirty.json (which chunk indices) and dirty.bin (their bytes, in order).
// Writing them at their offsets over the original image reproduces the disk as
// it stood when the machine was stopped.
import {readFileSync, writeFileSync} from "node:fs";
import {resolve, join} from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const basePath = flag("base"), dirtyDir = flag("dirty"), outPath = flag("out");
if (!basePath || !dirtyDir || !outPath) {
  console.error("usage: assemble-image.mjs --base <img> --dirty <dir> --out <img>");
  process.exit(2);
}
const base = readFileSync(resolve(basePath));
const meta = JSON.parse(readFileSync(join(resolve(dirtyDir), "dirty.json"), "utf8"));
const blob = readFileSync(join(resolve(dirtyDir), "dirty.bin"));
const size = meta.chunkSize;
// Entries are [chunkIndex, byteLength]: a chunk at the tail of the sparse data
// file can be shorter than a full chunk, and only the bytes that were really
// saved may be written over the base.
const entries = meta.chunks.map((c) => (Array.isArray(c) ? c : [c, size]));
const total = entries.reduce((n, [, len]) => n + len, 0);
if (blob.length !== total)
  throw new Error(`dirty.bin is ${blob.length} bytes, expected ${total}`);

const out = Buffer.from(base);
let beyond = 0, cursor = 0;
for (const [idx, len] of entries) {
  const at = idx * size;
  if (at >= out.length) { beyond++; cursor += len; continue; }
  blob.copy(out, at, cursor, cursor + Math.min(len, out.length - at));
  cursor += len;
}
writeFileSync(resolve(outPath), out);
console.log(`applied ${entries.length - beyond} chunk(s) over ${basePath}`);
if (beyond) console.log(`  ${beyond} chunk(s) sat past the end of the base image and were skipped`);
console.log(`wrote ${outPath} (${(out.length / 1048576).toFixed(0)} MB)`);
