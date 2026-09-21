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
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
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
let browser;
try { browser = await chromium.launch({headless: !has("headed")}); }
catch { browser = await chromium.launch({channel: "chrome", headless: !has("headed")}); }

mkdirSync(outDir, {recursive: true});
const ctx = await browser.newContext();
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

console.log("stopping the machine so the disk files unlock");
await page.evaluate(async () => {
  for (const h of window.__macInstances || []) { try { await h.destroy(); } catch {} }
});
await page.waitForTimeout(3000);

console.log("reading the disk out of the origin private file system");
const result = await page.evaluate(async (nameIn) => {
  let name = nameIn;
  const root = await navigator.storage.getDirectory();
  const read = async (n) => {
    try { return new Uint8Array(await (await (await root.getFileHandle(n)).getFile()).arrayBuffer()); }
    catch { return null; }
  };
  // The saver names its files after the manifest's "name" field, which is the
  // title as it appears on the Mac desktop, not the manifest's filename. So the
  // directory is listed rather than guessed.
  const present = [];
  for await (const entry of root.keys()) present.push(entry);
  let stem = present.filter((n) => n.endsWith(".dirtychunks")).map((n) => n.slice(0, -12));
  if (stem.includes(name)) stem = [name];
  if (!stem.length) return {error: "nothing persistent in OPFS. Present: " + JSON.stringify(present)};
  if (stem.length > 1) return {error: "several persistent disks in OPFS: " + JSON.stringify(stem)};
  name = stem[0];
  const dirty = await read(name + ".dirtychunks");
  if (!dirty) return {error: `no ${name}.dirtychunks in OPFS`};
  const dataHandle = await root.getFileHandle(name + ".data").catch(() => null);
  if (!dataHandle) return {error: `no ${name}.data in OPFS`};
  const file = await dataHandle.getFile();
  const indices = [];
  for (let i = 0; i < dirty.length; i++) {
    if (!dirty[i]) continue;
    for (let b = 0; b < 8; b++) if (dirty[i] & (1 << b)) indices.push(i * 8 + b);
  }
  // Only the chunks that were actually written come back across the wire.
  const out = [];
  for (const idx of indices) {
    const at = idx * 262144;
    const slice = await file.slice(at, at + 262144).arrayBuffer();
    // A chunk can be flagged dirty and still lie past the end of the sparse
    // data file, or run off it — the saver only extends the file as far as it
    // has actually written. Only the bytes that really exist are carried back,
    // so assembly leaves the rest of the base image alone instead of zeroing
    // a region nothing was ever written to.
    if (!slice.byteLength) continue;
    out.push([idx, Array.from(new Uint8Array(slice))]);
  }
  return {name, chunkSize: 262144, dataSize: file.size, chunks: out};
}, diskName);

if (result.error) throw new Error(result.error);
console.log(`  ${result.chunks.length} dirty chunk(s), ${(result.chunks.length * 262144 / 1048576).toFixed(1)} MB changed`);
const manifest = {disk: result.name, chunkSize: result.chunkSize, dataSize: result.dataSize,
                  chunks: result.chunks.map(([i, b]) => [i, b.length])};
writeFileSync(join(outDir, "dirty.json"), JSON.stringify(manifest, null, 2) + "\n");
const blob = Buffer.concat(result.chunks.map(([, bytes]) => Buffer.from(bytes)));
writeFileSync(join(outDir, "dirty.bin"), blob);
console.log(`  wrote ${join(outDir, "dirty.json")} and dirty.bin`);
await browser.close();
