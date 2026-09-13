#!/usr/bin/env node
// Headless boot test: does this title actually start, and at what speed?
//
//   node scripts/boot-test.mjs marathon                    # against production
//   node scripts/boot-test.mjs marathon --base http://localhost:8788
//   node scripts/boot-test.mjs --all
//
// Playwright is fetched on demand rather than made a dependency of the repo —
// the site itself has none, and it should stay that way.
//
// What it asserts, and why each one matters:
//   * /play/ reports crossOriginIsolated. If it does not, the COOP/COEP
//     middleware is not applying and every visitor is silently getting the slow
//     emulator with no error anywhere.
//   * the emulator reaches its loaded callback within the timeout. A disk with
//     a missing chunk hangs rather than failing, so only a timeout catches it.
//   * the canvas is not a flat colour. A Mac that boots to a blinking floppy
//     icon has "loaded" as far as the runtime is concerned.
//   * nothing was logged to console.error.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const BASE = flag("base", "https://macemu.com").replace(/\/$/, "");
const TIMEOUT = parseInt(flag("timeout", "90000"), 10);
const all = args.includes("--all");
const slugs = all
  ? JSON.parse(readFileSync(resolve(process.cwd(), "scripts", "app-pages.json"), "utf8"))
      .filter((p) => p.bootDisk).map((p) => p.slug)
  : args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--base" && args[args.indexOf(a) - 1] !== "--timeout");

if (!slugs.length) {
  console.error("usage: node scripts/boot-test.mjs <slug>... | --all   [--base URL] [--timeout MS]");
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("playwright not installed; fetching it into the project (not added to any manifest)…");
  const r = spawnSync("npx", ["--yes", "playwright@1.49.0", "install", "--with-deps", "chromium"], { stdio: "inherit" });
  if (r.status !== 0) { console.error("could not install playwright"); process.exit(2); }
  ({ chromium } = await import("playwright"));
}

const browser = await chromium.launch();
let failures = 0;

for (const slug of slugs) {
  for (const [route, wantIsolated] of [["play", true], ["embed", false]]) {
    const url = `${BASE}/${route}/${slug}/`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    const t0 = Date.now();
    let verdict = "ok";
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      const isolated = await page.evaluate(() => !!globalThis.crossOriginIsolated);
      if (isolated !== wantIsolated) {
        verdict = `crossOriginIsolated is ${isolated}, expected ${wantIsolated}`;
        throw new Error(verdict);
      }

      // The /play/ route waits for a click; the embed starts itself.
      const btn = await page.$(".embed-play");
      if (btn) await btn.click();

      await page.waitForFunction(() => globalThis.__macBooted === true, null, { timeout: TIMEOUT });

      // A booted Mac has a desktop on it. A blank canvas means it stopped at
      // the blinking floppy, which the runtime still calls "loaded".
      const distinct = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        if (!c) return -1;
        const g = c.getContext("2d") || (c.getContext("webgl") ? null : null);
        if (!g) return -2; // WebGL canvas; read it back the other way below
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        return seen.size;
      });
      if (distinct === 0 || distinct === 1) {
        verdict = "the canvas is a flat colour — it probably stopped at the blinking floppy";
        throw new Error(verdict);
      }
      if (errors.length) {
        verdict = `console errors: ${errors.slice(0, 2).join(" | ")}`;
        throw new Error(verdict);
      }
    } catch (e) {
      failures++;
      verdict = verdict === "ok" ? e.message : verdict;
      console.log(`  FAIL  ${route}/${slug}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  ${verdict}`);
      await ctx.close();
      continue;
    }
    console.log(`  ok    ${route}/${slug}  booted in ${((Date.now() - t0) / 1000).toFixed(1)}s${wantIsolated ? " (shared memory)" : " (fallback)"}`);
    await ctx.close();
  }
}

await browser.close();
if (failures) { console.error(`\n${failures} failure(s).`); process.exit(1); }
console.log("\nAll titles booted.");
