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
  // A title may declare what to do once it has launched, so the screenshot is
  // of the game rather than of whatever dialog it opens with. Coordinates are
  // in the emulated machine's own pixels, which is the only frame of reference
  // that stays true when the page layout changes.
  const catalogue = JSON.parse(readFileSync(resolve(process.cwd(), "scripts", "app-pages.json"), "utf8"));
  const setupFor = (slug) => (catalogue.find((p) => p.slug === slug) || {}).shotSetup || null;
  for (const s of slugs) {
    targets.push({ url: `${BASE}/play/${s}/`, isolated: true, label: `play/${s}`, setup: setupFor(s) });
    targets.push({ url: `${BASE}/embed/${s}/`, isolated: false, label: `embed/${s}`, setup: setupFor(s) });
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

// Prefer Playwright's own Chromium; fall back to the Chrome already on the
// machine. Downloading a browser is the slowest and least reliable part of
// running this test, and a system Chrome does the job identically.
let browser;
try {
  browser = await chromium.launch({ headless: !has("headed") });
} catch (e) {
  console.log("bundled chromium unavailable, using the system Chrome");
  browser = await chromium.launch({ channel: "chrome", headless: !has("headed") });
}
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

    // __macBooted means the RUNTIME started, not that the Macintosh finished
    // booting — the machine still has a System to load, which takes another
    // twenty to forty seconds. So poll the screen until the Finder is up.
    //
    // WHAT TO LOOK FOR, AND WHAT NOT TO.
    //
    // The obvious test — count distinct colours, call a flat screen a failure —
    // is wrong, and wrong in the worst direction: it fails a machine that is
    // working. A System 7 desktop in 1-bit black and white contains exactly two
    // colours, so a perfectly booted Mac scores the same as a dead one. That
    // cost an hour of chasing imaginary disk-image bugs before anyone looked at
    // the actual screen.
    //
    // Brightness is no better: the "blinking floppy" screen and the desktop are
    // both about half white, because both are that 50% dither pattern.
    //
    // What separates them is the MENU BAR. A booted Macintosh has a solid white
    // strip across the top of the screen with black text in it. Nothing before
    // the Finder loads draws one. So: sample the top rows, and call it booted
    // when they are overwhelmingly white.
    const menuBarWhite = () => page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return -1;
      const off = document.createElement("canvas");
      off.width = c.width; off.height = c.height;
      const g = off.getContext("2d");
      g.drawImage(c, 0, 0);
      const rows = Math.min(14, c.height);
      const d = g.getImageData(0, 0, c.width, rows).data;
      let light = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) light++;
      }
      return total ? light / total : -1;
    });

    // Deciding "has this actually booted" from pixels, in two phases.
    //
    // A Macintosh starting up shows a 50% checkerboard dither, so the top of
    // the screen measures close to half white. When the Finder arrives it puts
    // a solid white menu bar there; when a title launches itself it covers the
    // menu bar with its own artwork, which for a game is usually dark. So both
    // success states are FAR from one half, and the failure state is AT one
    // half.
    //
    // The trap: before the emulator paints anything the canvas is pure black,
    // which is also far from one half. Testing only "is it far from half" made
    // every title pass in under four seconds without a Macintosh ever starting
    // — a green test that proved nothing, which is worse than a red one. So
    // phase one waits to actually see the startup dither, and only then does
    // phase two wait for it to go away.
    const BOOTED_LIGHT = 0.75;   // a Finder menu bar
    const BOOTED_DARK = 0.25;    // a game covering the screen
    const isStarting = (v) => v >= 0.3 && v <= 0.7;
    const isSettled = (v) => v >= BOOTED_LIGHT || (v >= 0 && v <= BOOTED_DARK);

    const deadline = Date.now() + TIMEOUT;
    let white = await menuBarWhite();
    let sawStartup = false;
    while (Date.now() < deadline) {
      if (white === -1) throw new Error("no canvas on the page");
      if (!sawStartup && isStarting(white)) sawStartup = true;
      if (sawStartup && isSettled(white)) break;
      await page.waitForTimeout(1500);
      white = await menuBarWhite();
    }
    if (!sawStartup) {
      throw new Error(`the emulated screen never showed a startup pattern within ${Math.round(TIMEOUT / 1000)}s (top rows ${Math.round(white * 100)}% white) — the machine never began booting`);
    }
    if (!isSettled(white)) {
      throw new Error(`the top of the screen is still ${Math.round(white * 100)}% white after ${Math.round(TIMEOUT / 1000)}s — that is the startup dither, so the Finder never loaded`);
    }
    const reached = white >= BOOTED_LIGHT ? "a Finder desktop" : "the title's own screen";

    // Let the machine settle before photographing it. Reaching a desktop is not
    // the end of the boot: System 7 often rebuilds its desktop file on a freshly
    // written volume, which puts a progress bar up for a good while and delays
    // whatever was meant to launch. Ten seconds caught that progress bar; this
    // waits for the machine to stop being busy.
    if (shot) await page.waitForTimeout(30000);

    // Then run the title's own setup: dismissing a registration notice, or
    // getting past a title screen, so the picture is of the software doing the
    // thing the page says it does.
    if (shot && t.setup) {
      const canvas = await page.$("canvas");
      const box = await canvas.boundingBox();
      const scaleX = box.width / (t.setup.screen?.[0] || 640);
      const scaleY = box.height / (t.setup.screen?.[1] || 480);
      for (const step of t.setup.steps || []) {
        if (step.click) {
          // An emulated Mac polls the mouse rather than receiving events, so a
          // synthetic click that moves and releases within the same frame is
          // frequently never seen. Move first, let the guest notice where the
          // pointer is, then press and release with real time in between.
          const x = box.x + step.click[0] * scaleX;
          const y = box.y + step.click[1] * scaleY;
          await page.mouse.move(x, y);
          await page.waitForTimeout(600);
          await page.mouse.down();
          await page.waitForTimeout(250);
          await page.mouse.up();
        } else if (step.key) {
          await page.keyboard.press(step.key);
        }
        await page.waitForTimeout(step.waitMs || 2500);
      }
    }

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
    console.log(`  ok    ${t.label.padEnd(34)} reached ${reached} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${sab ? "shared memory" : "fallback"}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${t.label.padEnd(34)} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${e.message}`);
  }
  await ctx.close();
}

await browser.close();
if (failures) { console.error(`\n${failures} failure(s).`); process.exit(1); }
console.log("\nEverything booted.");
