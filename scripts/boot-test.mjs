#!/usr/bin/env node
// Does a Macintosh actually start, and at what speed?
//
//   node scripts/boot-test.mjs --page /classic-mac-emulator-online/
//   node scripts/boot-test.mjs marathon            # its /play/ and /embed/ routes
//   node scripts/boot-test.mjs --all
//   ... --base https://macemu.pages.dev --timeout 120000 --headed
//
// Playwright is fetched on demand rather than declared as a dependency: the
// site itself has none and should keep it that way.
//
// What it asserts, and why each one is here:
//   * the route's isolation is what the design intends. /play/ that is not
//     cross-origin isolated still works — silently, at a fraction of the speed,
//     with nothing in the console to say so.
//   * the emulator reports itself loaded within the timeout. A disk with one
//     missing chunk HANGS rather than failing, so only a timeout catches it.
//   * the canvas is not a flat colour. A machine that stopped at the blinking
//     floppy has "loaded" as far as the runtime is concerned.
//   * nothing reached console.error.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
// Capturing the emulated screen is the same job as booting it, so the boot test
// doubles as the screenshot tool: --shot writes public/run/<slug>/screenshot.png
// from the /play/ route once the machine has settled. A screenshot taken by the
// test that proves the title runs cannot drift from what the title does.
const shot = has("shot");
const BASE = flag("base", "https://macemu.pages.dev").replace(/\/$/, "");
const TIMEOUT = parseInt(flag("timeout", "120000"), 10);

// Build the list of {url, isolated} targets.
const targets = [];
const pageFlag = flag("page", null);
if (pageFlag) {
  targets.push({ url: BASE + pageFlag, isolated: false, label: pageFlag });
} else {
  const consumed = new Set(["--base", "--timeout", "--page"].flatMap((f) => {
    const i = argv.indexOf(f); return i >= 0 ? [i, i + 1] : [];
  }));
  let slugs = argv.filter((a, i) => !a.startsWith("--") && !consumed.has(i));
  if (has("all")) {
    const data = resolve(process.cwd(), "scripts", "app-pages.json");
    slugs = JSON.parse(readFileSync(data, "utf8")).filter((p) => p.bootDisk).map((p) => p.slug);
  }
  if (!slugs.length) {
    console.error("usage: boot-test.mjs (<slug>... | --all | --page /path/)  [--base URL] [--timeout MS]");
    process.exit(2);
  }
  for (const s of slugs) {
    targets.push({ url: `${BASE}/play/${s}/`, isolated: true, label: `play/${s}` });
    targets.push({ url: `${BASE}/embed/${s}/`, isolated: false, label: `embed/${s}` });
  }
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("installing playwright (not added to any manifest)…");
  if (spawnSync("npx", ["--yes", "playwright@1.49.0", "install", "chromium"], { stdio: "inherit" }).status !== 0) {
    console.error("could not install playwright");
    process.exit(2);
  }
  try { ({ chromium } = await import("playwright")); }
  catch {
    const r = spawnSync("npm", ["install", "--no-save", "--silent", "playwright@1.49.0"], { stdio: "inherit" });
    if (r.status !== 0) { console.error("could not install playwright"); process.exit(2); }
    ({ chromium } = await import("playwright"));
  }
}

const browser = await chromium.launch({ headless: !has("headed") });
let failures = 0;

for (const t of targets) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (/\/Disk\/|\/rom\/|\/mac\//.test(u)) errors.push(`request failed: ${u} (${r.failure()?.errorText})`);
  });

  const t0 = Date.now();
  try {
    // The runtime's paint loop begins with `if (document.hidden) return`, and a
    // page under automation frequently reports itself hidden. Without this the
    // machine boots perfectly and the canvas stays black, which looks exactly
    // like a failure and is not one.
    await page.addInitScript(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    });
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const isolated = await page.evaluate(() => !!globalThis.crossOriginIsolated);
    if (t.isolated && !isolated) {
      throw new Error("not cross-origin isolated — the emulator would run at a fraction of full speed with nothing to say so");
    }

    // /play/ and /run/ wait for a click; an embed starts itself; a loader page
    // offers "or just start a Macintosh".
    const start = await page.$(".embed-play") || await page.$(".dz-bare");
    if (start) await start.click();

    await page.waitForFunction(
      () => globalThis.__macBooted === true || globalThis.__macBootError,
      null, { timeout: TIMEOUT }
    );
    const bootErr = await page.evaluate(() => globalThis.__macBootError || null);
    if (bootErr) throw new Error("runtime reported: " + bootErr);

    // A booted Mac has a desktop on it. A flat canvas means it stopped at the
    // blinking floppy, which the runtime still calls loaded.
    await page.waitForTimeout(shot ? 25000 : 6000);
    const distinct = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return -1;
      const off = document.createElement("canvas");
      off.width = c.width; off.height = c.height;
      off.getContext("2d").drawImage(c, 0, 0);
      const d = off.getContext("2d").getImageData(0, 0, off.width, off.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 89) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    });
    if (distinct === -1) throw new Error("no canvas on the page");
    if (distinct <= 2) throw new Error(`the screen is ${distinct} colour(s) — it probably stopped at the blinking floppy`);

    const fatal = errors.filter((e) => !/favicon|adsbygoogle|gtag/i.test(e));
    if (fatal.length) throw new Error("console: " + fatal.slice(0, 2).join(" | "));

    if (shot && t.isolated) {
      const slug = t.label.split("/")[1];
      const out = resolve(process.cwd(), "public", "run", slug, "screenshot.png");
      mkdirSync(dirname(out), { recursive: true });
      await (await page.$("canvas")).screenshot({ path: out });
      console.log(`        screenshot -> public/run/${slug}/screenshot.png`);
    }

    const sab = await page.evaluate(() => typeof SharedArrayBuffer !== "undefined");
    console.log(`  ok    ${t.label.padEnd(34)} booted in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${distinct} colours, ${sab ? "shared memory" : "fallback"}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${t.label.padEnd(34)} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${e.message}`);
  }
  await ctx.close();
}

await browser.close();
if (failures) { console.error(`\n${failures} failure(s).`); process.exit(1); }
console.log("\nEverything booted.");
