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
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { isPlayable, isSold, emulatorFor, EMULATORS, screenshotFile, CATEGORY_ORDER, ERA_ORDER, SITE } from "./catalogue.mjs";
import { ISOLATE_CONTENT } from "./site.mjs";

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
    const PROVENANCE = ["clean", "shareware", "grey", "byo-only"];
    if (p.provenance && !PROVENANCE.includes(p.provenance)) {
      fail(`${where}: provenance ${JSON.stringify(p.provenance)} is not one of ${PROVENANCE.join(", ")}`);
    }
    // Anything actually hosted must have a written provenance record. On a site
    // that redistributes other people's software, "where did this come from and
    // on what terms" needs an answer written down before it goes up, not after
    // somebody asks.
    if (isPlayable(p) && !p.iframeUrl) {
      if (!existsSync(resolve(ROOT, "notices", `${p.slug}.md`))) {
        fail(`${where}: hosted but has no notices/${p.slug}.md recording where it came from and why it may be here`);
      }
      if (!p.provenance) fail(`${where}: hosted with no provenance set`);
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
  // A title may mount disks after its boot disk — that is how a title shares
  // one operating-system image with every other title of its era instead of
  // carrying its own copy. Each of those needs a manifest too, and a missing
  // one shows up as a disk that simply never appears on the desktop.
  for (const p of pages) {
    for (const d of p.extraDisks || []) {
      if (!existsSync(resolve(PUB, "mac", "disks", `${d}.json`)))
        fail(`${p.slug}: extraDisks lists "${d}" but there is no manifest at public/mac/disks/${d}.json`);
    }
    if (p.extraDisks && !p.bootDisk)
      fail(`${p.slug}: has extraDisks but no bootDisk — the machine would have nothing to boot from`);
  }

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
  if (!f) {
    // The boot test writes these; forgetting to declare one costs the page its
    // og:image and its poster tile, silently.
    if (existsSync(resolve(PUB, "run", p.slug, "screenshot.png"))) {
      warn(`${p.slug}: public/run/${p.slug}/screenshot.png exists but the entry does not set "screenshot": true, so nothing uses it`);
    }
    continue;
  }
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
    // The loop above only inspects hrefs that begin with "/", so a template
    // that interpolated nothing slips straight past it. href="undefined" is
    // never intentional, and 207 of them once shipped to production across
    // 69 pages because nothing here looked for the shape.
    for (const m of html.matchAll(/(?:href|src)="(undefined|null|)"/g)) {
      fail(`${file}: has ${m[0]} — a template rendered an empty value`);
      broken++;
    }
  }
  console.log(`  ${checked} internal links checked, ${broken} broken`);
}

// ── 5. the isolation / ads split holds ────────────────────────────────────
// The reason /play/ exists at all. If an ad tag ever lands on a cross-origin
// isolated page it will not render, and a reviewer loading the site sees a page
// with ad markup and no ads — which reads as broken, or worse, as cloaking.
section("Isolation and ads");
console.log(`  mode: content pages ARE ${ISOLATE_CONTENT ? "" : "NOT "}cross-origin isolated (ISOLATE_CONTENT in site.mjs)`);
if (ISOLATE_CONTENT && !existsSync(resolve(ROOT, "functions", "_middleware.js"))) {
  fail("ISOLATE_CONTENT is true but functions/_middleware.js is missing. Content pages would fall back to the slow service-worker path, which has been observed freezing the renderer.");
}
if (!ISOLATE_CONTENT && existsSync(resolve(ROOT, "functions", "_middleware.js"))) {
  fail("ISOLATE_CONTENT is false but functions/_middleware.js still isolates the site. Ads would be blocked on every page.");
}
for (const file of htmlFiles) {
  const html = readFileSync(resolve(PUB, file), "utf8");
  const isPlay = file.startsWith("play/");
  const isEmbed = file.startsWith("embed/");
  // While the whole site is isolated, an ad tag anywhere is a tag that cannot
  // render — which reads to a reviewer as a broken page, or as cloaking.
  if (ISOLATE_CONTENT && /adsbygoogle|pagead2\.googlesyndication/.test(html)) {
    fail(`${file}: carries an ad tag while ISOLATE_CONTENT is true. COEP blocks ad iframes, so it could never render.`);
  }
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
  // Parse _headers into rules rather than grepping the whole file. The earlier
  // version scanned the first forty lines for a COEP directive, which started
  // failing the moment a legitimate per-path COEP rule moved into that window.
  // What actually matters is which PATH a directive sits under.
  const rules = new Map();
  let current = null;
  for (const line of (read("_headers") || "").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { current = line.trim(); rules.set(current, []); }
    else if (current) rules.get(current).push(line.trim());
  }
  const directives = (path) => (rules.get(path) || []).join("\n");

  // Even when the whole site is isolated, the isolation belongs in a Function
  // and not here: _headers can only ADD headers, so a COEP set here could never
  // be lifted from /embed/, and embeds would break on every host page.
  if (/Cross-Origin-Embedder-Policy/i.test(directives("/*"))) {
    fail("_headers sets COEP under the /* catch-all. _headers can only add headers, so /embed/ could never opt out and embeds would break everywhere. Use functions/_middleware.js, which can exclude a path.");
  }
  // The mirror image: a worker script loaded from an isolated document must
  // carry COEP itself, or Chrome refuses it with ERR_BLOCKED_BY_RESPONSE and
  // every title fails to boot with nothing useful in the console.
  if (!/require-corp/i.test(directives("/mac/*"))) {
    fail("_headers does not set Cross-Origin-Embedder-Policy: require-corp on /mac/*. The emulator's worker is loaded from the isolated /play/ pages and would be blocked.");
  }
  if (!/Service-Worker-Allowed:\s*\//i.test(directives("/mac/emulator-service-worker.js"))) {
    fail("_headers does not set Service-Worker-Allowed: / on /mac/emulator-service-worker.js. The script lives under /mac/ and could not claim /play/, so fallback mode would fail on exactly the browsers that need it.");
  }
  if (!existsSync(resolve(ROOT, "functions", "play", "_middleware.js"))) fail("functions/play/_middleware.js is missing — /play/ would not be cross-origin isolated and the emulator would silently run in slow mode");
  if (!existsSync(resolve(ROOT, "functions", "embed", "_middleware.js"))) fail("functions/embed/_middleware.js is missing — embeds would be blocked by X-Frame-Options");
}

// ── 5b. nothing is served that the catalogue no longer describes ──────────
// A stale /play/ page is a Play button for software that is not there any more.
section("Orphans");
{
  const playable = new Set(pages.filter((p) => isPlayable(p) && !p.iframeUrl).map((p) => p.slug));
  const known = new Set(pages.map((p) => p.slug));
  for (const file of htmlFiles) {
    const m = file.match(/^(play|embed)\/([^/]+)\//);
    if (m && !playable.has(m[2])) {
      fail(`${file} exists but ${m[2]} is not a playable title — a Play button for software that is not there`);
    }
    const r = file.match(/^run\/([^/]+)\/index\.html$/);
    if (r && r[1] !== "index" && !known.has(r[1])) {
      fail(`${file} exists but ${r[1]} is not in the catalogue`);
    }
  }
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
      // Hub pages are generated from the catalogue rather than declared in a
      // data file. Rather than keep a list here that would drift, take the
      // honest definition: a top-level page that exists and is not noindex is
      // one that belongs in the sitemap. Matching on the directory name was
      // the first attempt and broke the moment a hub was not named "-games".
      ...readdirSync(PUB, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(resolve(PUB, d.name, "index.html")))
        .filter((d) => !/^(play|embed|mac|run|collection|blog|icons)$/.test(d.name))
        .filter((d) => !/name="robots"[^>]*noindex/
          .test(readFileSync(resolve(PUB, d.name, "index.html"), "utf8")))
        .map((d) => `/${d.name}/`),
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

  // A takedown promise of 48 hours is worth nothing if the address behind it
  // has quietly stopped accepting mail, which is what happened here once
  // already. security.txt is where a rights holder looks first, so it has to
  // exist and it has to be in date — an expired one advertises a dead contact.
  const sec = read(".well-known/security.txt") || "";
  if (!sec) fail("public/.well-known/security.txt is missing");
  else {
    const c = sec.match(/^Contact:\s*(\S+)/m);
    const e = sec.match(/^Expires:\s*(\S+)/m);
    if (!c) fail("security.txt has no Contact line");
    if (!e) fail("security.txt has no Expires line (RFC 9116 requires one)");
    else if (new Date(e[1]) <= new Date()) fail(`security.txt expired on ${e[1]}`);
  }
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
  // The verdict badge is the first thing read on the page. On a title that
  // hosts nothing it has to say so: "Runs well" beside no Play button is the
  // misleading-functionality shape that cost the sister site three AdSense
  // rejections, and it is a lie to the reader besides.
  if (!isPlayable(p) && !/bring your own|not hosted|needs your own/i.test(p.verdict.text)) {
    fail(`${p.slug}: verdict reads ${JSON.stringify(p.verdict.text)} but nothing is hosted — it must say the visitor needs their own copy`);
  }
  // A <title> that opens "Play X Online" on a page hosting nothing is a doorway
  // page by the definition search engines and ad networks actually use. The
  // sister site had forty-one of them and three AdSense rejections to match.
  if (!isPlayable(p) && /\b(play|use)\b[^—|-]{0,40}\bonline\b/i.test(p.title)) {
    fail(`${p.slug}: <title> promises play-online but nothing is hosted — ${JSON.stringify(p.title)}`);
  }
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
    // A takedown promise should be short enough to read in full before acting
    // on it. Padding it to clear a word count would make it worse.
    "takedown/index.html",
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

// ── 9b. cache-busting versions match the files on disk ────────────────────
// /*.js is cached for a day, so a stale ?v= pins every returning visitor to
// yesterday's script against today's HTML — which is exactly the deploy where
// it matters. The versions are content hashes; this checks nobody hand-edited
// a page or forgot to re-run the generator after touching a script.
section("Asset versions");
{
  const hashOf = (f) => {
    const p = resolve(PUB, f);
    return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8) : null;
  };
  const seen = new Map();
  for (const file of htmlFiles) {
    const html = readFileSync(resolve(PUB, file), "utf8");
    for (const m of html.matchAll(/["'(]\/([a-z0-9-]+\.(?:js|css))\?v=([a-f0-9]+)["')]/g)) {
      const [, asset, ver] = m;
      const want = hashOf(asset);
      if (!want) { fail(`${file} references /${asset}, which does not exist`); continue; }
      if (ver !== want) fail(`${file}: /${asset}?v=${ver} is stale — the file now hashes to ${want}. Re-run the generator.`);
      seen.set(asset, true);
    }
  }
  console.log(`  ${seen.size} versioned assets checked`);
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
