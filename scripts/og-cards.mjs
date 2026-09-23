#!/usr/bin/env node
// Render the social cards gen-pages.mjs asked for.
//
//   node scripts/og-cards.mjs            # render only what changed
//   node scripts/og-cards.mjs --all      # render everything
//
// gen-pages.mjs writes public/og/cards.json — one spec per card, keyed by the
// file name it will be served as — and points each page's og:image at
// /og/<key>.png. This turns those specs into 1200x630 PNGs in a headless
// browser. A card is re-rendered only when its spec, its screenshots or this
// template change, so a deploy with nothing new costs a second.
//
// Two layouts:
//   title   — one screenshot in a Mac window, the name, who and when.
//   collage — up to four screenshots, for hubs, eras and blog posts.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const PUB = resolve(process.cwd(), "public");
const OG = resolve(PUB, "og");
const SPECS = resolve(OG, "cards.json");
// Outside public/ so it is never deployed.
const STATE = resolve(process.cwd(), ".og-state.json");
const all = process.argv.includes("--all");

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Bump when the template below changes, so every card re-renders once.
const TEMPLATE_V = "1";

const CSS = `
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
body {
  font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
  background: #d8d4cc;
  background-image: repeating-linear-gradient(0deg, rgba(0,0,0,.035) 0 1px, transparent 1px 3px);
  color: #111; display: flex; align-items: center; padding: 56px; gap: 48px;
}
.win { background: #fff; border: 2px solid #111; box-shadow: 6px 6px 0 #111; flex: none; }
.bar { height: 26px; border-bottom: 2px solid #111; position: relative;
  background: repeating-linear-gradient(0deg, #111 0 1px, #fff 1px 3px); background-clip: content-box; padding: 5px 8px; }
.bar::before { content: ""; position: absolute; left: 14px; top: 5px; width: 16px; height: 14px; background: #fff; border: 2px solid #111; }
.win img { display: block; image-rendering: pixelated; }
.text { flex: 1; min-width: 0; }
h1 { font-size: 58px; line-height: 1.05; letter-spacing: -0.02em; font-weight: 800; }
.collage h1 { font-size: 50px; }
.sub { font-size: 28px; color: #333; margin-top: 18px; }
.tag { display: inline-block; margin-top: 34px; font-size: 26px; font-weight: 700; background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; }
.site { margin-top: 18px; font-size: 24px; color: #444; font-weight: 600; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; flex: none; width: 560px; }
.grid .win img { width: 100%; height: 196px; object-fit: cover; object-position: top left; }
.grid .bar { height: 18px; padding: 3px 6px; }
.grid .bar::before { width: 11px; height: 10px; top: 3px; left: 10px; }
`;

const dataUri = (rel) => `data:image/png;base64,${readFileSync(resolve(PUB, rel)).toString("base64")}`;
const pngSize = (rel) => { const b = readFileSync(resolve(PUB, rel)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

function titleHtml(spec) {
  const shot = spec.shots[0];
  const { w, h } = pngSize(shot);
  // Largest scale that fits the left half; whole-number when the screen is
  // small enough, so 1-bit dithering stays crisp rather than moiréd.
  const fit = Math.min(600 / w, 470 / h);
  const scale = fit >= 1 ? Math.floor(fit * 4) / 4 : fit;
  return `<div class="win"><div class="bar"></div><img src="${dataUri(shot)}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"></div>
<div class="text"><h1>${esc(spec.title)}</h1>${spec.sub ? `<p class="sub">${esc(spec.sub)}</p>` : ""}
<p class="tag">${esc(spec.tag)}</p><p class="site">macemu.com</p></div>`;
}

function collageHtml(spec) {
  const tiles = spec.shots.slice(0, 4).map((s) => `<div class="win"><div class="bar"></div><img src="${dataUri(s)}"></div>`).join("");
  return `<div class="grid">${tiles}</div>
<div class="text collage"><h1>${esc(spec.title)}</h1><p class="tag">${esc(spec.tag)}</p><p class="site">macemu.com</p></div>`;
}

const specs = JSON.parse(readFileSync(SPECS, "utf8"));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

const fingerprint = (spec) => {
  const h = createHash("sha256").update(TEMPLATE_V).update(JSON.stringify(spec));
  for (const s of spec.shots) { const st = statSync(resolve(PUB, s)); h.update(`${s}:${st.size}:${st.mtimeMs}`); }
  return h.digest("hex").slice(0, 16);
};

const todo = Object.entries(specs).filter(([key, spec]) => {
  if (!spec.shots.length) return false;
  return all || state[key] !== fingerprint(spec) || !existsSync(resolve(OG, `${key}.png`));
});

// Cards whose page no longer exists.
for (const f of readdirSync(OG)) {
  if (f.endsWith(".png") && !specs[f.slice(0, -4)]) { rmSync(resolve(OG, f)); delete state[f.slice(0, -4)]; console.log(`  removed stale og/${f}`); }
}

if (todo.length) {
  const { chromium } = await import("playwright");
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const [key, spec] of todo) {
    const inner = spec.kind === "title" ? titleHtml(spec) : collageHtml(spec);
    await page.setContent(`<!DOCTYPE html><html><head><style>${CSS}</style></head><body>${inner}</body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: resolve(OG, `${key}.png`), type: "png" });
    state[key] = fingerprint(spec);
  }
  await browser.close();
}
writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
console.log(`og cards: ${todo.length} rendered, ${Object.keys(specs).length - todo.length} unchanged`);
