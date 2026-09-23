#!/usr/bin/env node
// Photograph the emulated screen for a list of titles, several at a time.
//
//   node scripts/shoot.mjs --base http://localhost:8791 --out /tmp/triage \
//        --wait 55000 --jobs 3 slug slug slug
//   node scripts/shoot.mjs --stubs ...         # every entry still marked _stub
//
// boot-test.mjs answers "did it boot?" and, on the way, writes the published
// screenshot. This answers a different question — "what is actually on the
// screen?" — for titles that may well have failed, which is most of a freshly
// built batch. The distinction matters because boot-test reports a windowed
// game as "reached a Finder desktop" and a scrambled one as booted; the
// picture is the only thing that settles it.
//
// It therefore never judges, never skips a failure, and always writes a file.
// Running several at once is the difference between an hour and three: each
// title is one emulated Macintosh waiting out its own boot, and the host is
// mostly idle while it does.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const BASE = flag("base", "http://localhost:8791").replace(/\/$/, "");
const OUT = resolve(flag("out", "/tmp/triage"));
const WAIT = (() => {
  const w = parseInt(flag("wait", "55000"), 10);
  // Nobody ever wants to photograph a Macintosh 90 milliseconds after its
  // canvas appears; a bare "--wait 90" means seconds and silently produced a
  // black screen for every title once already.
  if (w < 1000) { console.error(`--wait is milliseconds; ${w} looks like seconds — using ${w * 1000}`); return w * 1000; }
  return w;
})();
const JOBS = parseInt(flag("jobs", "3"), 10);

const consumed = new Set(["--base", "--out", "--wait", "--jobs"].flatMap((f) => {
  const i = argv.indexOf(f); return i >= 0 ? [i, i + 1] : [];
}));
let slugs = argv.filter((a, i) => !a.startsWith("--") && !consumed.has(i));
if (has("stubs")) {
  slugs = JSON.parse(readFileSync("scripts/app-pages.json", "utf8"))
    .filter((p) => p._stub && p.bootDisk).map((p) => p.slug);
}
if (!slugs.length) { console.error("usage: shoot.mjs [--stubs | <slug>...]"); process.exit(2); }
if (has("skip-done")) slugs = slugs.filter((s) => !existsSync(`${OUT}/${s}.png`));
mkdirSync(OUT, { recursive: true });

const { chromium } = await import("playwright");
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ channel: "chrome", headless: true }); }

const queue = slugs.slice();
let done = 0;

async function worker(id) {
  while (queue.length) {
    const slug = queue.shift();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let note = "";
    try {
      // The runtime's paint loop starts with `if (document.hidden) return`, and
      // an automated page often reports itself hidden — without this the
      // machine boots and the canvas stays black, which is indistinguishable
      // from the failure being looked for.
      await page.addInitScript(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      });
      await page.goto(`${BASE}/play/${slug}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      const btn = await page.$(".embed-play");
      if (btn) await btn.click();
      await page.waitForSelector("canvas", { timeout: 30000 });
      await page.waitForTimeout(WAIT);
      // Read the pixels out of the canvas rather than asking Playwright for an
      // element screenshot: the element path captures whatever is composited
      // over that region, so the overlay hint lands in the picture and hides
      // the machine underneath. Reading the canvas gets the screen alone.
      //
      // NOTE --wait is MILLISECONDS. Passing `--wait 60` meaning a minute
      // captures 60ms after the canvas appears and every title looks dead.
      const dataUrl = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        if (!c || !c.width) return null;
        // Most of the emulator's canvas is written with zero alpha, so a
        // straight toDataURL yields a PNG that any viewer paints white — a
        // dark game comes out as a blank sheet. The stage behind the canvas
        // is black, so flattening onto black is what the visitor sees.
        const flat = document.createElement("canvas");
        flat.width = c.width; flat.height = c.height;
        const g = flat.getContext("2d");
        g.fillStyle = "#000"; g.fillRect(0, 0, flat.width, flat.height);
        g.drawImage(c, 0, 0);
        return flat.toDataURL("image/png");
      });
      if (!dataUrl) throw new Error("canvas had no pixels to read");
      writeFileSync(`${OUT}/${slug}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
    } catch (e) { note = " — " + String(e.message || e).split("\n")[0].slice(0, 70); }
    await ctx.close();
    console.log(`[${++done}/${slugs.length}] ${slug}${note}`);
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, slugs.length) }, (_, i) => worker(i)));
await browser.close();
console.log(`\nwrote ${OUT}`);
