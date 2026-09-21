#!/usr/bin/env node
// Run something inside the emulated Mac and keep what it wrote.
//
//   node scripts/author-disk.mjs --slug mac-os-8 --disk work-avara \
//     --steps scripts/steps/avara.json --out Images/authored/avara
//
// WHY THIS EXISTS
//
// Most Macintosh shareware from about 1996 onwards shipped as an Installer
// VISE archive — the files are compressed inside an application that has to be
// run on a Mac to unpack them. `SVCT` at the front of the data fork is the
// giveaway. No tool on this side of the fence reads it, so the only way to get
// at Avara or Escape Velocity Override is to boot a Mac, run the installer,
// and take the result away afterwards.
//
// That is what this does. The page is booted with a persistent disk, the steps
// drive the installer, and then the changed blocks are read back out.
//
// HOW THE DISK COMES BACK
//
// A persistent disk lives in the origin private file system as two files: a
// sparse `<name>.data` holding chunks at their real offsets, and a
// `<name>.dirtychunks` bitmap saying which of them were written. So only the
// changed blocks are pulled out — a few megabytes of an installed game rather
// than the whole five hundred megabyte volume — and assemble-image.mjs lays
// them over the base image afterwards.
//
// The worker holds an exclusive lock on those files while the machine is
// running, so it is stopped first.
import {readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync} from "node:fs";
import {resolve, join} from "node:path";
import {spawnSync} from "node:child_process";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const slug = flag("slug", "mac-os-8");
const diskName = flag("disk");
const base = flag("base", "https://macemu.pages.dev");
const outDir = resolve(process.cwd(), flag("out", "Images/authored/out"));
const stepsPath = flag("steps");
const bootTimeout = parseInt(flag("timeout", "300000"), 10);
const settle = parseInt(flag("settle", "25000"), 10);

if (!diskName) { console.error("usage: author-disk.mjs --disk <manifest name> [--slug s] [--steps f.json] --out dir"); process.exit(2); }
const steps = stepsPath ? JSON.parse(readFileSync(stepsPath, "utf8")) : [];

let chromium;
try { ({chromium} = await import("playwright")); }
catch {
  spawnSync("npx", ["--yes", "playwright@1.49.0", "install", "chromium"], {stdio: "inherit"});
  ({chromium} = await import("playwright"));
}
// A profile directory keeps the origin private file system between runs, so a
// disk can be built up over several short sessions — install one thing, come
// back, install the next — instead of one long fragile chain of clicks.
const profile = flag("profile");
mkdirSync(outDir, {recursive: true});
let browser, ctx;
if (profile) {
  mkdirSync(profile, {recursive: true});
  try { ctx = await chromium.launchPersistentContext(profile, {headless: !has("headed")}); }
  catch { ctx = await chromium.launchPersistentContext(profile, {channel: "chrome", headless: !has("headed")}); }
} else {
  try { browser = await chromium.launch({headless: !has("headed")}); }
  catch { browser = await chromium.launch({channel: "chrome", headless: !has("headed")}); }
  ctx = await browser.newContext();
}
const page = await ctx.newPage();
// The emulator's paint loop returns early when the document is hidden, and an
// automated tab is always hidden, so it would render nothing at all.
await page.addInitScript(() => Object.defineProperty(document, "hidden", {get: () => false}));
page.on("console", (m) => { const t = m.text(); if (/dirty chunks|Loaded saved disk|error/i.test(t)) console.log("   [page]", t.slice(0, 160)); });

const url = `${base}/play/${slug}/`;
console.log(`opening ${url}`);
await page.goto(url, {waitUntil: "domcontentloaded"});
// /play/ waits for a click before it starts the machine — only an embed inside
// someone else's page boots by itself.
const start = await page.$(".embed-play") || await page.$(".dz-bare");
if (start) await start.click();
await page.waitForFunction(() => window.__macBooted || window.__macBootError, null, {timeout: bootTimeout});
const bootErr = await page.evaluate(() => window.__macBootError);
if (bootErr) throw new Error("boot failed: " + bootErr);
console.log("booted; letting it settle");
await page.waitForTimeout(settle);

const canvas = await page.$("canvas");
const box = await canvas.boundingBox();
const screen = steps.screen || [800, 600];
const sx = box.width / screen[0], sy = box.height / screen[1];
let shot = 0;
const snap = async (label) => {
  const p = join(outDir, `step-${String(shot++).padStart(2, "0")}-${label}.png`);
  await page.screenshot({path: p, clip: box});
  console.log(`   shot ${p}`);
};
await snap("boot");

for (const step of steps.steps || []) {
  if (step.click) {
    // The emulated Mac polls the mouse rather than receiving events, so a click
    // that moves and releases inside one frame is often never seen. Move, let
    // the guest notice, then press and release with real time in between.
    const x = box.x + step.click[0] * sx, y = box.y + step.click[1] * sy;
    await page.mouse.move(x, y);
    await page.waitForTimeout(600);
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.up();
    console.log(`   click ${step.click.join(",")}${step.note ? "  (" + step.note + ")" : ""}`);
  } else if (step.doubleClick) {
    const x = box.x + step.doubleClick[0] * sx, y = box.y + step.doubleClick[1] * sy;
    await page.mouse.move(x, y);
    await page.waitForTimeout(600);
    await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    await page.waitForTimeout(90);
    await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    console.log(`   double-click ${step.doubleClick.join(",")}${step.note ? "  (" + step.note + ")" : ""}`);
  } else if (step.type) {
    await page.keyboard.type(step.type, {delay: 120});
    console.log(`   type ${JSON.stringify(step.type)}`);
  } else if (step.key) {
    await page.keyboard.press(step.key);
    console.log(`   key ${step.key}`);
  }
  await page.waitForTimeout(step.waitMs || 4000);
  await snap(step.note ? step.note.replace(/[^a-z0-9]+/gi, "-").toLowerCase() : "step");
}

// ALWAYS SHUT THE MACHINE DOWN BEFORE TAKING THE DISK AWAY
//
// Killing the emulator with the volume still mounted leaves HFS half-written,
// and the next boot runs Disk First Aid and reports damage it cannot repair —
// which, with --profile, means the disk you have been building up over several
// sessions is gone. So the shutdown is done here rather than left to whoever
// wrote the steps file to remember.
if (!has("no-shutdown")) {
  console.log("shutting the Mac down (Special \u25b8 Shut Down)");
  // Shut Down lives on the Finder's menu bar, so whatever is frontmost has to
  // go first — the menu click lands on the running application's menus
  // otherwise and the machine is killed dirty. Command-Q twice is enough: the
  // Finder cannot be quit, so it is harmless once we are back at it.
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Meta+q");
    await page.waitForTimeout(3500);
  }
  await page.waitForTimeout(3000);
  const menu = [181, 9], item = [206, 120];
  for (const [mx, my] of [menu, item]) {
    await page.mouse.move(box.x + mx * sx, box.y + my * sy);
    await page.waitForTimeout(700);
    await page.mouse.down(); await page.waitForTimeout(250); await page.mouse.up();
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(20000);
  await snap("shut-down");
}

console.log("stopping the machine so the disk files unlock");
await page.evaluate(async () => {
  for (const h of window.__macInstances || []) { try { await h.destroy(); } catch {} }
});
await page.waitForTimeout(3000);

console.log("reading the disk out of the origin private file system");

// The chunks are fetched in batches and encoded as base64 on the way across.
// Handing them over as an array of numbers instead — one JS number per byte —
// works for a ten megabyte install and runs the Node heap out of memory on a
// thirty megabyte one, which is a silent truncation waiting to happen.
const info = await page.evaluate(async (nameIn) => {
  const root = await navigator.storage.getDirectory();
  const present = [];
  for await (const entry of root.keys()) present.push(entry);
  let stem = present.filter((n) => n.endsWith(".dirtychunks")).map((n) => n.slice(0, -12));
  if (stem.includes(nameIn)) stem = [nameIn];
  if (!stem.length) return {error: "nothing persistent in OPFS. Present: " + JSON.stringify(present)};
  if (stem.length > 1) return {error: "several persistent disks in OPFS: " + JSON.stringify(stem)};
  const name = stem[0];
  const dirtyFile = await (await root.getFileHandle(name + ".dirtychunks")).getFile();
  const dirty = new Uint8Array(await dirtyFile.arrayBuffer());
  const dataHandle = await root.getFileHandle(name + ".data").catch(() => null);
  if (!dataHandle) return {error: `no ${name}.data in OPFS`};
  const indices = [];
  for (let i = 0; i < dirty.length; i++) {
    if (!dirty[i]) continue;
    for (let b = 0; b < 8; b++) if (dirty[i] & (1 << b)) indices.push(i * 8 + b);
  }
  return {name, indices, dataSize: (await dataHandle.getFile()).size, chunkSize: 262144};
}, diskName);
if (info.error) throw new Error(info.error);
console.log(`  ${info.indices.length} dirty chunk(s) to fetch`);

const binPath = join(outDir, "dirty.bin");
if (existsSync(binPath)) rmSync(binPath);
const lengths = [];
const BATCH = 12;
for (let i = 0; i < info.indices.length; i += BATCH) {
  const want = info.indices.slice(i, i + BATCH);
  const parts = await page.evaluate(async ({name, want, size}) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(name + ".data")).getFile();
    const out = [];
    for (const idx of want) {
      const buf = await file.slice(idx * size, idx * size + size).arrayBuffer();
      if (!buf.byteLength) { out.push(null); continue; }
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let k = 0; k < bytes.length; k += 8192)
        bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
      out.push(btoa(bin));
    }
    return out;
  }, {name: info.name, want, size: info.chunkSize});
  parts.forEach((b64, n) => {
    if (b64 === null) return;           // flagged dirty but past the end of the file
    const buf = Buffer.from(b64, "base64");
    appendFileSync(binPath, buf);
    lengths.push([want[n], buf.length]);
  });
  process.stdout.write(`\r  fetched ${Math.min(i + BATCH, info.indices.length)}/${info.indices.length}`);
}
process.stdout.write("\n");
writeFileSync(join(outDir, "dirty.json"), JSON.stringify(
  {disk: info.name, chunkSize: info.chunkSize, dataSize: info.dataSize, chunks: lengths}, null, 2) + "\n");
console.log(`  wrote ${lengths.length} chunk(s), ${(lengths.reduce((n, [, l]) => n + l, 0) / 1048576).toFixed(1)} MB`);
await (browser ? browser.close() : ctx.close());
