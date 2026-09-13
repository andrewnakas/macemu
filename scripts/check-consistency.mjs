#!/usr/bin/env node
// The deploy gate. Exits non-zero if anything on the site has drifted out of
// step with anything else. Run it after the generators and before every deploy:
//
//   node scripts/gen-pages.mjs && node scripts/check-consistency.mjs
//
// The point is not tidiness. Each of these checks exists because the failure it
// catches is invisible from the outside: a page that promises a game the site
// does not host looks exactly like a page that delivers one, right up until a
// visitor clicks — and, on the sister site, right up until an ad reviewer did.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { isPlayable, isSold, emulatorFor, EMULATORS, screenshotFile, CATEGORY_ORDER, ERA_ORDER, SITE } from "./catalogue.mjs";

const ROOT = process.cwd();
const PUB = resolve(ROOT, "public");
const pages = JSON.parse(readFileSync(resolve(ROOT, "scripts", "app-pages.json"), "utf8"));
const utils = JSON.parse(readFileSync(resolve(ROOT, "scripts", "utility-pages.json"), "utf8"));
const statics = JSON.parse(readFileSync(resolve(ROOT, "scripts", "static-pages.json"), "utf8"));
const posts = existsSync(resolve(ROOT, "scripts", "blog-posts.json"))
  ? JSON.parse(readFileSync(resolve(ROOT, "scripts", "blog-posts.json"), "utf8")) : [];

let failures = 0, warnings = 0;
const fail = (msg) => { failures++; console.error("  FAIL  " + msg); };
const warn = (msg) => { warnings++; console.warn("  warn  " + msg); };
const section = (name) => console.log("\n" + name);

const read = (rel) => (existsSync(resolve(PUB, rel)) ? readFileSync(resolve(PUB, rel), "utf8") : null);
const htmlFiles = (() => {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".html")) out.push(p.slice(PUB.length + 1));
    }
  })(PUB);
  return out.sort();
})();

// ── 1. the catalogue is internally coherent ───────────────────────────────
section("Catalogue");
{
  const seen = new Set();
  for (const p of pages) {
    const where = `app-pages.json[${p.slug}]`;
    if (seen.has(p.slug)) fail(`${where}: duplicate slug`);
    seen.add(p.slug);
    for (const field of ["slug", "title", "description", "crumb", "appName", "appType", "verdict", "intro", "updated", "era", "machine"]) {
      if (!p[field]) fail(`${where}: missing required field "${field}"`);
    }
    if (p.appType && !["game", "app"].includes(p.appType)) fail(`${where}: appType must be "game" or "app", got ${JSON.stringify(p.appType)}`);
    if (p.era && !ERA_ORDER.includes(p.era)) fail(`${where}: era ${JSON.stringify(p.era)} is not one of ${ERA_ORDER.join(", ")}`);
    if (p.machine && !EMULATORS[p.machine]) fail(`${where}: machine ${JSON.stringify(p.machine)} has no emulator mapping in catalogue.mjs`);
    for (const c of p.categories || []) {
      if (!CATEGORY_ORDER.includes(c)) fail(`${where}: category ${JSON.stringify(c)} is not in CATEGORY_ORDER`);
    }
    // The one rule with teeth: nothing still sold is ever hosted.
    if (isSold(p) && isPlayable(p)) fail(`${where}: is marked as still sold (${p.sold}) but also has a bootDisk. Commercial software is never hosted.`);
    if (p.description && (p.description.length < 70 || p.description.length > 175)) {
      warn(`${where}: meta description is ${p.description.length} chars; aim for 110–160 or search engines rewrite it`);
    }
    if (p.title && p.title.length > 65) warn(`${where}: <title> is ${p.title.length} chars — Bing truncates around 65`);
    if (!p.faq || p.faq.length < 4) warn(`${where}: only ${(p.faq || []).length} FAQ entries; 6+ earns the rich result`);
    if (!p.licenseReason) warn(`${where}: no licenseReason — every hosted or guided title should say why it is here`);
  }
}

// ── 2. a playable title really is playable ────────────────────────────────
section("Playability claims");
{
  for (const p of pages) {
    if (!p.bootDisk) continue;
    const manifestPath = resolve(PUB, "mac", "disks", `${p.bootDisk}.json`);
    if (!existsSync(manifestPath)) {
      fail(`${p.slug}: bootDisk "${p.bootDisk}" has no manifest at public/mac/disks/${p.bootDisk}.json — the page promises instant play with nothing behind it`);
      continue;
    }
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch (e) { fail(`${p.slug}: manifest ${p.bootDisk}.json is not valid JSON (${e.message})`); continue; }
    const chunks = manifest.chunks || [];
    if (!chunks.length) fail(`${p.slug}: manifest ${p.bootDisk}.json lists no chunks`);
    // Chunks live outside the repo (Images/build, then R2), so only check them
    // when a local build directory exists — on a clean checkout it will not.
    const buildDir = resolve(ROOT, "Images", "build");
    if (existsSync(buildDir)) {
      const missing = chunks.filter((c) => c && !existsSync(join(buildDir, `${c}.chunk`)));
      if (missing.length) fail(`${p.slug}: ${missing.length} of ${chunks.length} chunks missing from Images/build (first: ${missing[0]})`);
    } else {
      warn(`${p.slug}: Images/build not present, so chunk existence was not verified. Run scripts/sync-disks.sh before deploying.`);
    }
  }
  const playable = pages.filter(isPlayable);
  console.log(`  ${playable.length} playable, ${pages.length - playable.length} guides`);
}

// ── 3. screenshots that are claimed actually exist ────────────────────────
section("Screenshots");
for (const p of pages) {
  const f = screenshotFile(p);
  if (!f) continue;
  if (!existsSync(resolve(PUB, "run", p.slug, f))) {
    fail(`${p.slug}: screenshot "${f}" is declared but public/run/${p.slug}/${f} does not exist — it is also the og:image, so social cards would 404`);
  }
}

// ── 4. every internal link resolves ───────────────────────────────────────
section("Internal links");
{
  const redirects = read("_redirects") || "";
  const redirected = new Set(redirects.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const exists = (href) => {
    const clean = href.split("#")[0].split("?")[0];
    if (!clean || clean === "/") return true;
    if (redirected.has(clean)) return true;
    if (clean.endsWith("/")) return existsSync(resolve(PUB, clean.slice(1), "index.html"));
    return existsSync(resolve(PUB, clean.slice(1)));
  };
  let checked = 0, broken = 0;
  for (const file of htmlFiles) {
    const html = readFileSync(resolve(PUB, file), "utf8");
    for (const m of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
      checked++;
      if (!exists(m[1])) { fail(`${file} → ${m[1]} does not exist`); broken++; }
    }
  }
  console.log(`  ${checked} internal links checked, ${broken} broken`);
}

// ── 5. the isolation / ads split holds ────────────────────────────────────
// The reason /play/ exists at all. If an ad tag ever lands on a cross-origin
// isolated page it will not render, and a reviewer loading the site sees a page
// with ad markup and no ads — which reads as broken, or worse, as cloaking.
section("Isolation and ads");
for (const file of htmlFiles) {
  const html = readFileSync(resolve(PUB, file), "utf8");
  const isPlay = file.startsWith("play/");
  const isEmbed = file.startsWith("embed/");
  if ((isPlay || isEmbed) && /adsbygoogle|pagead2\.googlesyndication/.test(html)) {
    fail(`${file}: carries an ad tag. /play/ is cross-origin isolated (ads cannot render) and /embed/ runs on other people's sites.`);
  }
  if ((isPlay || isEmbed) && !/name="robots"[^>]*noindex/.test(html)) {
    fail(`${file}: missing noindex. It is the same title as its /run/ page with the article removed; indexing both invites a duplicate-content judgement on the page that matters.`);
  }
  if ((isPlay || isEmbed) && !/rel="canonical" href="[^"]*\/run\//.test(html)) {
    fail(`${file}: canonical should point at the /run/ page`);
  }
  if (file.startsWith("run/") && /mac-runtime\.js/.test(html)) {
    fail(`${file}: loads the emulator runtime directly. /run/ pages load it lazily through mac-player.js so that reading an article does not cost a multi-megabyte download.`);
  }
}
{
  const hdr = read("_headers") || "";
  if (/^\s*Cross-Origin-Embedder-Policy/mi.test(hdr.split("\n").slice(0, 40).join("\n"))) {
    fail("_headers appears to set a site-wide COEP. That blocks every cross-origin iframe, ad iframes included, and cannot be removed by _headers later — use a Pages Function middleware on the specific route.");
  }
  if (!existsSync(resolve(ROOT, "functions", "play", "_middleware.js"))) fail("functions/play/_middleware.js is missing — /play/ would not be cross-origin isolated and the emulator would silently run in slow mode");
  if (!existsSync(resolve(ROOT, "functions", "embed", "_middleware.js"))) fail("functions/embed/_middleware.js is missing — embeds would be blocked by X-Frame-Options");
}

// ── 6. sitemap lists exactly the indexable pages ──────────────────────────
section("Sitemap");
{
  const xml = read("sitemap.xml");
  if (!xml) fail("public/sitemap.xml is missing");
  else {
    const listed = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(SITE, "")));
    const shouldBe = new Set([
      "/", "/run/",
      ...pages.map((p) => `/run/${p.slug}/`),
      ...ERA_ORDER.filter((e) => pages.some((p) => p.era === e)).map((e) => `/collection/${e}/`),
      ...utils.map((u) => `/${u.slug}/`),
      ...statics.map((s) => `/${s.slug}/`),
      ...(posts.length ? ["/blog/"] : []),
      ...posts.map((q) => `/blog/${q.slug}/`),
    ]);
    for (const want of shouldBe) if (!listed.has(want)) fail(`sitemap is missing ${want}`);
    for (const got of listed) if (!shouldBe.has(got)) fail(`sitemap lists ${got}, which is not an indexable page`);
    for (const got of listed) {
      if (got.startsWith("/play/") || got.startsWith("/embed/")) fail(`sitemap lists ${got}, which is noindex — that tells a crawler two contradictory things`);
    }
    console.log(`  ${listed.size} URLs`);
  }
}

// ── 7. robots.txt and llms.txt agree with reality ─────────────────────────
section("Crawler files");
{
  const robots = read("robots.txt") || "";
  if (!/Disallow: \/play\//.test(robots)) fail("robots.txt should disallow /play/");
  if (!/Disallow: \/embed\//.test(robots)) fail("robots.txt should disallow /embed/");
  if (!/Sitemap: /.test(robots)) fail("robots.txt has no Sitemap line");
  const llms = read("llms.txt") || "";
  if (!llms) fail("public/llms.txt is missing — assistant referrals are one of the largest channels for this kind of site");
  else {
    for (const p of pages.filter(isPlayable)) {
      if (!llms.includes(`/run/${p.slug}/`)) fail(`llms.txt does not list playable title ${p.slug}`);
    }
    // The honesty check that matters most for assistants: a guide page must not
    // appear under the "runs instantly" heading.
    const runsSection = llms.split("## Guides")[0];
    for (const p of pages.filter((x) => !isPlayable(x))) {
      if (runsSection.includes(`/run/${p.slug}/`)) fail(`llms.txt lists ${p.slug} as playable, but it has no bootDisk`);
    }
  }
}

// ── 8. no page contradicts its own playability ────────────────────────────
section("Honesty");
for (const p of pages) {
  const html = read(`run/${p.slug}/index.html`);
  if (!html) { fail(`${p.slug}: no generated page at public/run/${p.slug}/index.html`); continue; }
  const hasLoader = /id="mac-loader"/.test(html);
  const hasPlayer = /id="mac-embed"/.test(html);
  if (isPlayable(p) && !p.iframeUrl && !hasPlayer) fail(`${p.slug}: marked playable but the page has no emulator mount`);
  if (!isPlayable(p) && !hasLoader) fail(`${p.slug}: not playable and the page has no file loader — that is a page with nothing to do, which is what a doorway page is`);
  if (!isPlayable(p) && /\bPlay\b[^<]{0,30}(now|instantly|free online)/i.test(html) && !/your own copy/i.test(html)) {
    warn(`${p.slug}: page is not hosted but the copy reads like it is`);
  }
}

// ── 9. utility and written pages are substantial ──────────────────────────
section("Page depth");
{
  const MIN_WORDS = 500;
  // Pages that are short because being short is correct. A contact page padded
  // to five hundred words is worse than a contact page, and an index page's job
  // is to get out of the way — the depth lives on the pages it links to.
  const SHORT_BY_DESIGN = new Set([
    "contact/index.html", "privacy/index.html", "terms/index.html",
    "blog/index.html", "run/index.html", "404.html",
  ]);
  for (const file of htmlFiles) {
    if (file.startsWith("play/") || file.startsWith("embed/") || SHORT_BY_DESIGN.has(file)) continue;
    const text = readFileSync(resolve(PUB, file), "utf8")
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ");
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < MIN_WORDS) warn(`${file}: only ~${words} words. Thin pages are what "low value content" means.`);
  }
}

// ── 10. assets referenced by the chrome exist ─────────────────────────────
section("Assets");
for (const f of ["favicon.svg", "og.png", "apple-touch-icon.png", "manifest.webmanifest", "style.css", "mac-player.js", "mac-loader.js", "macbin.js", "grid-filter.js", "robots.txt"]) {
  if (!existsSync(resolve(PUB, f))) fail(`public/${f} is missing but the pages reference it`);
}
{
  // Payload ceiling: Cloudflare Pages refuses any file over 25 MB, which is why
  // disk chunks and ROMs live in R2 and not here.
  const LIMIT = 25 * 1024 * 1024;
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).size > LIMIT) fail(`${p.slice(PUB.length + 1)} is ${(statSync(p).size / 1048576).toFixed(1)} MB — Cloudflare Pages rejects anything over 25 MB. It belongs in R2.`);
    }
  })(PUB);
}

// ── verdict ───────────────────────────────────────────────────────────────
console.log("");
if (failures) {
  console.error(`${failures} failure${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}. Not safe to deploy.`);
  process.exit(1);
}
console.log(`No failures. ${warnings} warning${warnings === 1 ? "" : "s"}.`);
