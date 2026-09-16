#!/usr/bin/env node
// Ask each title's own emulator which chunks it wants prefetched, and write the
// answer into its manifest.
//
//   node scripts/prefetch-hints.mjs --all --base https://macemu.pages.dev
//
// The chunked-disk layer logs "complete set of ideal prefetch chunks: [...]"
// once it knows what a boot actually touched. Without those hints the emulator
// discovers every chunk it needs one synchronous read at a time — fine over
// shared memory, and the reason the fallback path used on embeds intermittently
// gives up with "too many fetch failures" before the machine finishes starting.
//
// So the hints are not a tuning nicety. They are the difference between an
// embed booting and an embed failing on a slow connection, and the emulator is
// the only thing that knows them.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = flag("base", "https://macemu.pages.dev").replace(/\/$/, "");
const WAIT = parseInt(flag("wait", "90000"), 10);

const catalogue = JSON.parse(readFileSync(resolve(process.cwd(), "scripts", "app-pages.json"), "utf8"));
const slugs = argv.includes("--all")
  ? catalogue.filter((p) => p.bootDisk).map((p) => p.slug)
  : argv.filter((a) => !a.startsWith("--") && catalogue.some((p) => p.slug === a));

if (!slugs.length) { console.error("usage: prefetch-hints.mjs (--all | <slug>...) [--base URL]"); process.exit(2); }

let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ channel: "chrome", headless: true }); }

for (const slug of slugs) {
  const entry = catalogue.find((p) => p.slug === slug);
  const manifestPath = resolve(process.cwd(), "public", "mac", "disks", `${entry.bootDisk}.json`);
  if (!existsSync(manifestPath)) { console.log(`  skip  ${slug}: no manifest`); continue; }

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let ideal = null;
  page.on("console", (m) => {
    const t = m.text();
    const hit = t.match(/ideal prefetch chunks:\s*\[([0-9,\s]*)\]/);
    if (hit) ideal = hit[1].split(",").map((n) => parseInt(n.trim(), 10)).filter((n) => !Number.isNaN(n));
  });
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  await page.goto(`${BASE}/play/${slug}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1500);
  const btn = await page.$(".embed-play");
  if (btn) await btn.click();
  await page.waitForTimeout(WAIT);
  await ctx.close();

  if (!ideal || !ideal.length) { console.log(`  ----  ${slug}: the emulator reported no hints`); continue; }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const before = (manifest.prefetchChunks || []).join(",");
  manifest.prefetchChunks = ideal;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
  console.log(`  ok    ${slug}: ${ideal.length} chunks${before ? ` (was ${before.split(",").length})` : ""} -> ${entry.bootDisk}.json`);
}

await browser.close();
