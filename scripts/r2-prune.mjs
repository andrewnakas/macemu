#!/usr/bin/env node
// Remove disk chunks from R2 that nothing references any more.
//
//   node scripts/r2-prune.mjs            # dry run: list what would go
//   node scripts/r2-prune.mjs --delete   # delete them, then verify the site
//
// A chunk is kept if ANY manifest in public/mac/disks/ names it, or any
// manifest backup in Images/authored/*.manifest.backup.json does — those are
// the rollback path for a rebuilt shared disk, and deleting their chunks would
// turn "restore the old manifest" into "rebuild the old disk". ROMs (rom/…)
// and anything else that is not a bare <hash>.chunk are never touched.
//
// Deleted chunks are not recoverable unless Images/build still has a copy, so
// the dry run says how many of them it does, and the key list is written to
// Images/authored/r2-pruned-<date>.json before anything is deleted.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";

const ROOT = process.cwd();
const BUCKET = "macemu-disk";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "ea509cdff27d40d5e3e4cb92dec2473f";
const doDelete = process.argv.includes("--delete");

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  // The wrangler OAuth token lasts about an hour; any wrangler call refreshes it.
  spawnSync("npx", ["--yes", "wrangler", "r2", "bucket", "list"], { stdio: "ignore" });
  for (const p of [join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
                   join(homedir(), ".wrangler/config/default.toml")]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  throw new Error("no Cloudflare credential: set CLOUDFLARE_API_TOKEN or run npx wrangler login");
}

const api = (path, init = {}) =>
  fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}${path}`,
        { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } })
    .then((r) => r.json());

const TOKEN = token();

// Everything in the bucket.
const objects = new Map();
let cursor = "";
do {
  const d = await api(`/objects?per_page=1000${cursor ? `&cursor=${cursor}` : ""}`);
  if (!d.success) throw new Error("listing failed: " + JSON.stringify(d.errors));
  for (const o of d.result) objects.set(o.key, o.size || 0);
  cursor = d.result_info && d.result_info.is_truncated ? d.result_info.cursor : "";
} while (cursor);

// Everything referenced.
const referenced = new Set();
const addManifest = (p) => {
  for (const c of JSON.parse(readFileSync(p, "utf8")).chunks || []) if (c) referenced.add(`${c}.chunk`);
};
const disks = join(ROOT, "public/mac/disks");
for (const f of readdirSync(disks)) if (f.endsWith(".json")) addManifest(join(disks, f));
const authored = join(ROOT, "Images/authored");
if (existsSync(authored)) {
  for (const f of readdirSync(authored)) if (f.endsWith(".manifest.backup.json")) addManifest(join(authored, f));
}

const missing = [...referenced].filter((k) => !objects.has(k));
if (missing.length) {
  // A referenced chunk that is not there is a broken title, and a sign this
  // listing cannot be trusted to decide what to delete.
  console.error(`${missing.length} referenced chunk(s) are missing from R2 — run scripts/sync-disks.sh first. Nothing deleted.`);
  process.exit(1);
}

const orphans = [...objects.keys()].filter((k) => /^[0-9a-f]+\.chunk$/.test(k) && !referenced.has(k)).sort();
const mb = orphans.reduce((s, k) => s + objects.get(k), 0) / 1e6;
const local = orphans.filter((k) => existsSync(join(ROOT, "Images/build", k))).length;
console.log(`${objects.size} objects in R2; ${referenced.size} chunks referenced; ${orphans.length} unreferenced (${mb.toFixed(1)} MB), ${local} of them with a local copy in Images/build.`);
if (!orphans.length || !doDelete) {
  if (orphans.length) console.log("Dry run. Pass --delete to remove them.");
  process.exit(0);
}

const record = join(authored, `r2-pruned-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(record, JSON.stringify(orphans, null, 0));
console.log(`key list written to ${record}`);

let ok = 0, failed = 0;
const queue = orphans.slice();
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let k; (k = queue.shift()); ) {
    const d = await api(`/objects/${encodeURIComponent(k)}`, { method: "DELETE" }).catch(() => ({}));
    if (d.success) ok++; else { failed++; console.error("  failed", k); }
  }
}));
console.log(`deleted ${ok}, failed ${failed}`);

// Prove the site still serves every chunk a manifest names.
execFileSync("bash", ["scripts/sync-disks.sh", "--verify-only"], { stdio: "inherit" });
