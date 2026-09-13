#!/usr/bin/env node
// Generates every HTML page on macemu.com from scripts/app-pages.json and
// scripts/utility-pages.json.
//
//   node scripts/gen-pages.mjs
//   node scripts/check-consistency.mjs    # gate; run before every deploy
//
// The catalogue JSON is the single source of truth. Editing a page means
// editing its entry and re-running this — never hand-editing public/run/*.html,
// which the next run overwrites.
//
// ── Per-title data contract ───────────────────────────────────────────────
//   slug          URL slug; the page is /run/<slug>/
//   title         <title> — lead with the query people actually type
//   description   meta description, 110–160 chars
//   keywords      comma list (legacy, low weight, kept for parity)
//   ogTitle/ogDescription   social card text (shorter than <title>)
//   crumb         breadcrumb label, e.g. "Marathon"
//   h1            on-page heading when it should differ from <title>
//   appName       short label for buttons and cards, e.g. "Marathon"
//   appType       "game" → VideoGame schema | "app" → SoftwareApplication
//   author        publisher/author for schema, e.g. "Bungie Software"
//   year          release year of the version hosted here (number)
//   genre         array of genre strings (games)
//   categories    closed set from CATEGORY_ORDER in catalogue.mjs
//   era           system-6 | system-7 | mac-os-8 | mac-os-9 — drives
//                 /collection/<era>/ and the "runs on" line
//   machine       Mac-Plus | Mac-SE | Mac-II | Quadra-650 | Power-Macintosh-G3
//                 → picks the emulator (EMULATORS in catalogue.mjs)
//   ramMB         emulated RAM; omit for the machine default
//   screen        { w, h, depth } of the emulated screen
//   bootDisk      name of a manifest in public/mac/disks/ — THE honest playable
//                 signal. Omit and the page becomes a bring-your-own-copy
//                 guide with the file loader, which is a real page, not a
//                 doorway. check-consistency.mjs verifies the manifest and all
//                 its chunks exist, so this cannot promise what isn't there.
//   iframeUrl     a self-contained native WASM port (e.g. a Glider PRO build)
//                 that replaces the emulator entirely
//   provenance    clean | grey | byo-only — what licence footing this sits on;
//                 rendered on the page, recorded in full in NOTICE.md
//   sold          URL where the title is still sold today. Setting this bans
//                 hosting: check-consistency.mjs fails if it also has bootDisk.
//   licenseReason prose: why this is here and on what terms
//   fullyFree     prose: why this is free in full (drives the FREE badge)
//   verdict       { kind: "good"|"partial"|"bad", text: "Runs well" }
//   intro         lead paragraph HTML, above the player
//   sections      [{ h, html }] rendered below the player
//   faq           [{ q, a }] → <details> and FAQPage JSON-LD
//   related       [{ href, title, desc }] link cards
//   download      { heading, html } — where to get an original copy
//   macControls   [{ keys, does }] rendered as a table under the player
//   launchNote    one line about what happens on boot ("Starts at the map")
//   byo           { accepts: [".sit"], hint: "…" } for guide pages
//   screenshot    true → /run/<slug>/screenshot.png; string overrides filename
//   updated       YYYY-MM-DD — sitemap <lastmod> + "Guide updated" line
//   addedDate     YYYY-MM-DD the title went live — drives the NEW badge
//   rank          integer, lower sorts earlier in the grids
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  SITE, esc, xmlEsc, isPlayable, isSold, emulatorFor, screenshotFile, isNew,
  NEW_BADGE, FREE_BADGE, posterCard, byoCard, sortPlayable, categoryCounts,
  categoryChips, jsonText, maxDate, toRfc822, itemListLd, ERA_ORDER, ERA_LABELS,
} from "./catalogue.mjs";
import {
  BRAND, TAGLINE, head, header, footer, nav, page, crumbs, breadcrumbLd,
  monthYear, adsAllowed, setAssetVersions, av,
} from "./site.mjs";

const ROOT = resolve(process.cwd(), "public");

// Content-hash every asset the pages reference, so a changed file always gets a
// changed URL and a returning visitor never runs yesterday's JavaScript against
// today's HTML.
const ASSETS = ["style.css", "macbin.js", "mac-player.js", "mac-loader.js", "grid-filter.js"];
setAssetVersions(Object.fromEntries(ASSETS.map((f) => {
  const p = resolve(ROOT, f);
  return [f, existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8) : "0"];
})));

// What the file loader boots, everywhere it appears.
//
// Always a Macintosh IIfx under Basilisk II, regardless of the era the
// surrounding page is about, for two reasons. Mini vMac has no host file
// sharing at all, so on a Mac Plus a dropped .sit has nowhere to go, whereas
// Basilisk II mounts a shared folder that appears on the desktop as "The
// Outside World". And of the Basilisk machines, the IIfx ROM is the one that
// actually boots this System 7.5 install: with the Quadra 650 ROM the machine
// reads 31 KB, decides there is nothing bootable, and sits on a black screen
// with no error anywhere.
const LOADER_MACHINE = "Mac-IIfx";
const LOADER_DISK = "system-7.5.3";
const DATA = resolve(process.cwd(), "scripts", "app-pages.json");
const UTILS = resolve(process.cwd(), "scripts", "utility-pages.json");
const STATIC = resolve(process.cwd(), "scripts", "static-pages.json");
const BLOG = resolve(process.cwd(), "scripts", "blog-posts.json");
const pages = existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : [];
const utils = existsSync(UTILS) ? JSON.parse(readFileSync(UTILS, "utf8")) : [];
const statics = existsSync(STATIC) ? JSON.parse(readFileSync(STATIC, "utf8")) : [];
const posts = (existsSync(BLOG) ? JSON.parse(readFileSync(BLOG, "utf8")) : [])
  .sort((a, b) => String(b.date).localeCompare(String(a.date)));

const written = [];
function write(relPath, html) {
  const abs = resolve(ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, html);
  written.push(relPath);
}

// Intrinsic PNG/JPEG dimensions so <img> never causes layout shift.
function imageSize(absPath) {
  try {
    const b = readFileSync(absPath);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

const shotUrl = (p) => { const f = screenshotFile(p); return f ? `${SITE}/run/${p.slug}/${f}` : null; };
const ogImage = (p) => shotUrl(p) || `${SITE}/og.png`;
const screenOf = (p) => p.screen || { w: 640, h: 480, depth: 8 };

// ── structured data ────────────────────────────────────────────────────────
function appLd(p) {
  const url = `${SITE}/run/${p.slug}/`;
  const common = `  "name": ${jsonText(p.appName)},
  "url": "${url}",
  "image": "${ogImage(p)}",
  "description": ${jsonText(p.description)},
  "operatingSystem": "Web Browser"${p.author ? `,
  "${p.appType === "game" ? "publisher" : "author"}": { "@type": "Organization", "name": ${JSON.stringify(p.author)} }` : ""}${p.updated ? `,
  "dateModified": ${JSON.stringify(p.updated)}` : ""}${isPlayable(p) ? `,
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }` : ""}`;
  if (p.appType === "game") {
    return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "VideoGame",
${common},
  "applicationCategory": "Game",
  "genre": [${(p.genre || []).map((g) => JSON.stringify(g)).join(", ")}],
  "gamePlatform": ["Web browser", "Macintosh"]
}
</script>`;
  }
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
${common},
  "applicationCategory": "Utility"
}
</script>`;
}

function faqLd(p) {
  if (!p.faq || !p.faq.length) return "";
  const items = p.faq.map((f) => `    {
      "@type": "Question",
      "name": ${jsonText(f.q)},
      "acceptedAnswer": { "@type": "Answer", "text": ${jsonText(f.a)} }
    }`).join(",\n");
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
${items}
  ]
}
</script>`;
}

// ── page parts ─────────────────────────────────────────────────────────────
// The emulator mount. Every attribute the player needs is a data-* on one
// element, so the page is static HTML and the driver is one generic script.
function macMount(p, { mode }) {
  const s = screenOf(p);
  const attrs = [
    `data-slug="${esc(p.slug)}"`,
    `data-app-name="${esc(p.appName)}"`,
    `data-machine="${esc(p.machine)}"`,
    `data-emulator="${esc(emulatorFor(p) || "")}"`,
    `data-disk="${esc(p.bootDisk || "")}"`,
    `data-width="${s.w}"`,
    `data-height="${s.h}"`,
    p.ramMB ? `data-ram="${p.ramMB}"` : "",
    `data-mode="${mode}"`,
  ].filter(Boolean).join("\n         ");
  return `<div id="mac-embed"
         ${attrs}></div>`;
}

function playerBlock(p) {
  if (p.iframeUrl) {
    return `
    <div class="iframe-embed-wrap" style="position:relative;width:100%;padding-bottom:62.5%;background:#000;border-radius:4px;overflow:hidden;">
      <iframe src="${esc(p.iframeUrl)}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen loading="lazy" title="${esc(p.appName)}"></iframe>
    </div>`;
  }
  if (isPlayable(p)) return `\n    ${macMount(p, { mode: "isolated" })}`;
  // No boot disk: the page still does something useful rather than being a
  // doorway. The loader takes the visitor's own copy and runs it.
  const accepts = (p.byo && p.byo.accepts) || [".sit", ".hqx", ".bin", ".img", ".dsk", ".toast", ".iso", ".zip"];
  return `
    <div id="mac-loader"
         data-slug="${esc(p.slug)}"
         data-app-name="${esc(p.appName)}"
         data-machine="${LOADER_MACHINE}"
         data-disk="${LOADER_DISK}"
         data-accepts="${esc(accepts.join(","))}">
      <noscript><p class="muted">JavaScript is required to run the emulator.</p></noscript>
    </div>`;
}

function controlsHtml(p) {
  if (!p.macControls || !p.macControls.length) return "";
  const rows = p.macControls
    .map((c) => `        <tr><td><kbd>${esc(c.keys)}</kbd></td><td>${esc(c.does)}</td></tr>`)
    .join("\n");
  return `
    <div class="controls-panel">
      <h3>Controls</h3>
      <table class="controls-table">
        <tbody>
${rows}
        </tbody>
      </table>
    </div>`;
}

function figureHtml(p) {
  const f = screenshotFile(p);
  if (!f) return "";
  const d = imageSize(resolve(ROOT, "run", p.slug, f)) || { w: 1200, h: 750 };
  return `
    <figure class="app-shot">
      <img src="/run/${p.slug}/${f}" width="${d.w}" height="${d.h}" loading="lazy" alt="${esc(p.appName)} running in a browser tab" />
      <figcaption>${esc(p.appName)}, running here in ${esc(emulatorFor(p) || "an emulator")}.</figcaption>
    </figure>`;
}

// The one line that tells a visitor what machine this actually is. Search
// engines like it; more to the point, people ask it constantly.
function specLine(p) {
  const s = screenOf(p);
  const bits = [
    p.year ? `${p.year}` : "",
    p.author || "",
    ERA_LABELS[p.era] || "",
    emulatorFor(p) ? `${emulatorFor(p)} (${(p.machine || "").replace(/-/g, " ")})` : "",
    `${s.w}×${s.h}${s.depth === 1 ? " black and white" : s.depth ? ` at ${s.depth}-bit colour` : ""}`,
  ].filter(Boolean);
  return `<p class="muted small" style="margin-top:0.25rem;">${bits.map(esc).join(" · ")}</p>`;
}

function licenseHtml(p) {
  if (!p.licenseReason) return "";
  const cls = p.provenance === "clean" ? "free-note" : "warn-box";
  return `
    <p class="${cls}">${p.licenseReason}</p>`;
}

function soldHtml(p) {
  if (!p.sold) return "";
  return `
    <p class="warn-box"><strong>This one is still sold.</strong> ${esc(p.appName)} is available to buy today, so it is not hosted here and never will be — <a href="${esc(p.sold)}" rel="nofollow noopener">buy it</a> and run your own copy with the loader above.</p>`;
}

function downloadHtml(p) {
  if (!p.download) return "";
  return `
  <section class="card download-box">
    <h2>${esc(p.download.heading)}</h2>
    ${p.download.html}
  </section>`;
}

function sectionsHtml(sections, skipFirst = false) {
  if (!sections || !sections.length) return "";
  return sections.slice(skipFirst ? 1 : 0)
    .map((s) => `
  <section class="card">${s.h ? `
    <h2>${esc(s.h)}</h2>` : ""}
    ${s.html}
  </section>`).join("");
}

function faqHtml(p) {
  if (!p.faq || !p.faq.length) return "";
  const items = p.faq.map((f) => `      <details>
        <summary>${esc(f.q)}</summary>
        <p>${f.a}</p>
      </details>`).join("\n");
  return `
  <section class="card">
    <h2>Questions people ask</h2>
${items}
  </section>`;
}

function relatedHtml(related) {
  if (!related || !related.length) return "";
  const cards = related.map((r) => `      <a class="link-card" href="${esc(r.href)}">
        <strong>${esc(r.title)}</strong>
        <span>${esc(r.desc)}</span>
      </a>`).join("\n");
  return `
  <section class="card">
    <h2>Keep going</h2>
    <div class="card-grid">
${cards}
    </div>
  </section>`;
}

// Three more playable titles, so a page that got a visitor from search has
// somewhere to send them. Only ever links to titles that actually run.
function alsoPlayHtml(current, all) {
  const others = sortPlayable(all).filter((p) => p.slug !== current.slug).slice(0, 6);
  if (others.length < 3) return "";
  return `
  <section class="card">
    <h2>Play something else</h2>
    <ul class="poster-grid">
${others.map(posterCard).join("\n")}
    </ul>
  </section>`;
}

// ── /run/<slug>/ — the indexed content page ────────────────────────────────
function runPage(p) {
  const playable = isPlayable(p);
  const headHtml = head({
    title: p.title, description: p.description, keywords: p.keywords,
    path: `/run/${p.slug}/`, kind: "content",
    ogTitle: p.ogTitle, ogDescription: p.ogDescription, ogImage: ogImage(p),
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: p.crumb, href: `/run/${p.slug}/` }]),
      appLd(p), faqLd(p),
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: p.crumb }])}

  <section class="card">
    <h2>${esc(p.h1 || p.crumb)} <span class="verdict ${p.verdict.kind}">${esc(p.verdict.text)}</span></h2>
    ${specLine(p)}${p.updated ? `
    <p class="muted small">Guide updated ${esc(monthYear(p.updated))}${playable ? "" : " · needs your own copy"}</p>` : ""}
    ${p.intro}${playerBlock(p)}${p.launchNote && playable ? `
    <p class="muted small">${esc(p.launchNote)}</p>` : ""}${controlsHtml(p)}${figureHtml(p)}${soldHtml(p)}${licenseHtml(p)}
  </section>${downloadHtml(p)}${sectionsHtml(p.sections)}${faqHtml(p)}${alsoPlayHtml(p, pages)}${relatedHtml(p.related)}
</main>

${footer()}`;
  const scripts = `<script src="/macbin.js?v=${av("macbin.js")}"></script>
<script src="/mac-player.js?v=${av("mac-player.js")}"></script>${playable ? "" : `
<script src="/mac-loader.js?v=${av("mac-loader.js")}"></script>`}`;
  return page({ headHtml, bodyHtml: body, scripts });
}

// ── /play/<slug>/ — cross-origin isolated, ad-free, noindex ────────────────
// Full-speed SharedArrayBuffer mode needs COOP/COEP on the top-level document,
// and COEP blocks ad iframes outright. Keeping the fast player on its own route
// means the money page and the fast page never have to be the same page.
function playPage(p) {
  const s = screenOf(p);
  const headHtml = head({
    title: `${p.appName} — ${BRAND}`,
    description: `${p.appName} running in ${emulatorFor(p) || "an emulator"}.`,
    path: `/play/${p.slug}/`, kind: "play",
    canonical: `${SITE}/run/${p.slug}/`, ogImage: ogImage(p),
    extraHead: `\n<style>body{margin:0;background:#000;color:#ddd;display:flex;flex-direction:column;min-height:100vh}.playbar{display:flex;gap:1rem;align-items:center;padding:0.4rem 0.8rem;background:#1a1816;font:13px/1.4 -apple-system,system-ui,sans-serif}.playbar a{color:#9cf}.playstage{flex:1;display:flex;align-items:center;justify-content:center}</style>`,
  });
  const body = `<div class="playbar">
  <a href="/run/${p.slug}/">‹ ${esc(p.appName)}</a>
  <span class="muted">${esc(emulatorFor(p) || "")} · ${s.w}×${s.h}</span>
  <span style="flex:1"></span>
  <a href="/">${BRAND}</a>
</div>
<div class="playstage">
  ${macMount(p, { mode: "isolated" })}
</div>`;
  return page({
    headHtml, bodyHtml: body,
    scripts: `<script src="/mac-player.js?v=${av("mac-player.js")}"></script>`,
  });
}

// ── /embed/<slug>/ — for other people's sites ──────────────────────────────
// Runs in fallback mode, because the host page almost certainly is not
// cross-origin isolated. Slower, and honest about it: the bar links out to the
// full-speed page, which is also the backlink.
function embedPage(p) {
  const s = screenOf(p);
  const headHtml = head({
    title: `${p.appName} (embed) — ${BRAND}`,
    description: `${p.appName} embedded from ${BRAND}.`,
    path: `/embed/${p.slug}/`, kind: "embed",
    canonical: `${SITE}/run/${p.slug}/`,
    extraHead: `\n<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}.embedbar{position:absolute;bottom:0;right:0;font:11px/1.6 system-ui,sans-serif;background:rgba(0,0,0,.6);padding:0 6px}.embedbar a{color:#9cf;text-decoration:none}</style>`,
  });
  const body = `${macMount(p, { mode: "fallback" })}
<div class="embedbar"><a href="${SITE}/play/${p.slug}/" target="_blank" rel="noopener">▶ Full speed on ${BRAND}</a></div>`;
  return page({ headHtml, bodyHtml: body, scripts: `<script src="/mac-player.js?v=${av("mac-player.js")}"></script>` });
}

// ── grids and hubs ─────────────────────────────────────────────────────────
const gridFilter = (list) => {
  const chips = categoryChips(categoryCounts(list));
  return `    <div class="grid-filter">
      <input type="search" class="gf-search" id="gf-search" placeholder="Search ${list.length} titles…" aria-label="Search titles" />
      <div class="gf-chips">
        <button type="button" class="chip is-on" data-cat="">All <span class="chip-n">${list.length}</span></button>
        ${chips}
      </div>
      <p class="gf-empty" hidden>Nothing matches. <button type="button" class="linklike" id="gf-clear">Clear filters</button></p>
    </div>`;
};

function runHub() {
  const playNow = sortPlayable(pages);
  const guides = pages.filter((p) => !isPlayable(p));
  const headHtml = head({
    title: `Every classic Mac title you can run here — ${BRAND}`,
    description: `${playNow.length} classic Macintosh games and apps that run instantly in a browser tab, plus ${guides.length} guides for running your own copy.`,
    path: "/run/", kind: "content",
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }]),
      itemListLd(playNow, { name: "Classic Mac titles playable in the browser", url: `${SITE}/run/` }),
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "All titles" }])}

  <section class="card">
    <h2>Everything on ${BRAND}</h2>
    <p>${playNow.length ? `<strong>${playNow.length}</strong> titles start in a click — nothing to install, nothing uploaded.` : "Titles are being added as their disk images are built and checked."} ${guides.length ? `Another <strong>${guides.length}</strong> have guides for running a copy you already own, using the same emulator and the same <a href="/load-mac-file/">file loader</a>.` : ""}</p>
    <p class="muted">This list is deliberately not exhaustive. There were tens of thousands of Macintosh programs, and a page that exists only to hold a name helps nobody. Each title here gets a real page: what it was, who made it, how to play it, what machine it needs, and where to find an original if you would rather run your own copy.</p>
  </section>

${playNow.length ? `  <section class="card">
    <h2>Play now</h2>
${gridFilter(playNow)}
    <ul class="poster-grid">
${playNow.map(posterCard).join("\n")}
${byoCard()}
    </ul>
  </section>` : ""}

${guides.length ? `  <section class="card">
    <h2>Bring your own copy</h2>
    <p class="muted">These are not hosted here. The page tells you what the title is, where to find it, and runs it in the same emulator once you drop the file in.</p>
    <ul class="link-list">
${guides.map((p) => `      <li><a href="/run/${p.slug}/">${esc(p.appName)}</a> <span class="muted small">${esc([p.year, p.author].filter(Boolean).join(" · "))}</span></li>`).join("\n")}
    </ul>
  </section>` : ""}
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body, scripts: `<script src="/grid-filter.js?v=${av("grid-filter.js")}"></script>` });
}

function homePage() {
  const playNow = sortPlayable(pages);
  const headHtml = head({
    title: `${BRAND} — run classic Mac games and apps in your browser`,
    description: "System 6, System 7 and Mac OS 9 software running in a browser tab. No download, no install, nothing uploaded. Open your own .sit, .hqx or disk image too.",
    path: "/", kind: "content",
    ld: [itemListLd(playNow, { name: "Classic Mac titles playable in the browser", url: `${SITE}/` })],
  });
  const body = `${header()}

<main class="prose">
  <section class="card">
    <h2>The Mac you grew up with, in a tab</h2>
    <p>${BRAND} runs classic Macintosh software the way it actually ran: the real System software, the real applications, emulated in WebAssembly. Pick a title and it starts in a couple of seconds. Nothing installs, nothing is uploaded, and your saves stay in your own browser.</p>
    <p>Got a file of your own — a <code>.sit</code> from an old download, a <code>.img</code> off a Zip disk, a <code>.hqx</code> from a Usenet archive? <a href="/load-mac-file/">Drop it in the loader</a> and it opens on an emulated Mac.</p>
  </section>

  <section class="card">
    <h2>What this is, exactly</h2>
    <p>Three emulators, all long-standing open-source projects, compiled to WebAssembly: <strong>Mini vMac</strong> for the compact black-and-white Macs, <strong>Basilisk II</strong> for the 68k machines that ran System 7, and <strong>SheepShaver</strong> for the PowerPC era of Mac OS 8 and 9. They execute real 68k and PowerPC instructions and boot Apple's real system software, exactly as the hardware did.</p>
    <p>Each title here gets its own machine, chosen to match what it was written for. Software from 1987 will not run under Mac OS 9, and software compiled for PowerPC will not run on a 68k Quadra at all — picking the wrong machine is the single most common reason an old program refuses to start. The page for each title says which machine it uses and why.</p>
    <p>Disk images are split into small chunks and fetched only as the emulated Mac reads them, which is why a machine with a two-hundred-megabyte hard disk starts in seconds instead of after a long download. <a href="/blog/how-we-run-system-7-in-a-browser/">The long version is on the blog.</a></p>
  </section>

  <section class="card">
    <h2>What is here, and on what footing</h2>
    <p>Every page says plainly whether a title runs here or needs a copy you supply. There are no pages promising a game the site does not have.</p>
    <ul>
      <li><strong>Free and clear.</strong> Software released by the people who made it — Marathon, which Bungie put into free redistribution in 2005; Glider PRO, whose source John Calhoun published under the GPL; Kid Pix 1.0, which Craig Hickman gave away himself.</li>
      <li><strong>Abandoned.</strong> Software whose publisher no longer exists or has not sold it in decades, preserved for the same reason the Internet Archive and Macintosh Garden preserve it. Not a claim that it is public domain — which is why the <a href="/takedown/">takedown page</a> is a 48-hour promise.</li>
      <li><strong>Still sold.</strong> Never hosted. Those pages tell you where to buy it and run your own copy in the same emulator.</li>
    </ul>
  </section>

${playNow.length ? `  <section class="card">
    <h2>Start here</h2>
${gridFilter(playNow)}
    <ul class="poster-grid">
${playNow.map(posterCard).join("\n")}
${byoCard()}
    </ul>
  </section>` : `  <section class="card">
    <h2>Being built in the open</h2>
    <p>Titles go live as their disk images are built and checked. Every page on the site already tells you honestly whether something runs here or needs your own copy — <a href="/run/">see the full list</a>.</p>
  </section>`}

  <section class="card">
    <h2>Browse by era</h2>
    <div class="card-grid">
${ERA_ORDER.filter((e) => pages.some((p) => p.era === e)).map((e) => `      <a class="link-card" href="/collection/${e}/">
        <strong>${esc(ERA_LABELS[e])}</strong>
        <span>${pages.filter((p) => p.era === e).length} titles</span>
      </a>`).join("\n")}
    </div>
  </section>

  <section class="card">
    <h2>Open a Mac file you already have</h2>
    <div class="card-grid">
${utils.filter((u) => u.onHome).map((u) => `      <a class="link-card" href="/${u.slug}/">
        <strong>${esc(u.cardTitle || u.crumb)}</strong>
        <span>${esc(u.cardDesc || "")}</span>
      </a>`).join("\n")}
    </div>
  </section>
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body, scripts: `<script src="/grid-filter.js?v=${av("grid-filter.js")}"></script>` });
}

function collectionPage(era) {
  const list = pages.filter((p) => p.era === era);
  const label = ERA_LABELS[era];
  const playNow = sortPlayable(list);
  const headHtml = head({
    title: `${label} software you can run in a browser — ${BRAND}`,
    description: `Games and applications from the ${label} era of the Macintosh, running in a browser tab. ${playNow.length} start in a click.`,
    path: `/collection/${era}/`, kind: "content",
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: label, href: `/collection/${era}/` }]),
      itemListLd(playNow, { name: `${label} titles`, url: `${SITE}/collection/${era}/` }),
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: label }])}
  <section class="card">
    <h2>${esc(label)}</h2>
    <p>${esc(ERA_BLURB[era] || "")}</p>
    <p class="muted">${esc(ERA_ADVICE[era] || "")}</p>
  </section>
${playNow.length ? `  <section class="card">
    <h2>Play now</h2>
    <ul class="poster-grid">
${playNow.map(posterCard).join("\n")}
    </ul>
  </section>` : ""}
${list.filter((p) => !isPlayable(p)).length ? `  <section class="card">
    <h2>Guides</h2>
    <ul class="link-list">
${list.filter((p) => !isPlayable(p)).map((p) => `      <li><a href="/run/${p.slug}/">${esc(p.appName)}</a> <span class="muted small">${esc([p.year, p.author].filter(Boolean).join(" · "))}</span></li>`).join("\n")}
    </ul>
  </section>` : ""}
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body });
}

// Practical advice per era, on the collection pages. A visitor who lands on
// "System 6" from a search wants to know what that even means for them.
const ERA_ADVICE = {
  "system-6": "If something here will not run on a later machine, this is usually why: a program written for a Mac Plus often depends on a 512×342 one-bit screen and breaks on anything larger or in colour. These are also the fastest titles on the site, and the only ones genuinely comfortable on a phone.",
  "system-7": "Most of what people remember is here. If you are not sure which era a title belongs to, start with this one — System 7 ran for six years and almost everything from the shareware and CD-ROM boom targets it.",
  "mac-os-8": "Anything that needs the Appearance Manager or a threaded Finder lives here. In practice most Mac OS 8 software also runs under System 7.5, so this is a smaller collection than its span suggests.",
  "mac-os-9": "PowerPC-only software, which means a heavier emulator. Worth it for the titles that need it, slower for everything else — if a program will run under System 7, it is better off there.",
};

const ERA_BLURB = {
  "system-6": "Black and white, 512×342, and a machine that booted from a floppy in under twenty seconds. System 6 ran on the Mac Plus and SE — the compact all-in-one Macs with the handle on top. Emulated here in Mini vMac, which is small and fast enough to run smoothly on a phone.",
  "system-7": "The Macintosh most people actually remember: colour, the Apple menu you could put things in, aliases, and a Finder that could do more than one thing at once. System 7 ran from 1991 to 1997 and covers the school computer lab, the CD-ROM boom and most of the shareware era. Emulated here in Basilisk II on a Macintosh IIfx.",
  "mac-os-8": "Platinum, contextual menus, and a Finder that finally used threads. Mac OS 8 arrived in 1997 and is the last classic system that still feels like the old Mac rather than a stepping stone to OS X.",
  "mac-os-9": "The end of the line for the classic Mac OS, and the fastest of them. Mac OS 9 ran on PowerPC hardware, so it is emulated here in SheepShaver — heavier than the 68k emulators, and worth it for the titles that need it.",
};

// ── utility pages ──────────────────────────────────────────────────────────
function utilityPage(u) {
  const headHtml = head({
    title: u.title, description: u.description, keywords: u.keywords,
    path: `/${u.slug}/`, kind: "content",
    ogTitle: u.ogTitle, ogDescription: u.ogDescription,
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: u.crumb, href: `/${u.slug}/` }]),
      u.faq && u.faq.length ? faqLd(u) : "",
      `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": ${jsonText(u.crumb)},
  "url": "${SITE}/${u.slug}/",
  "applicationCategory": "Utility",
  "operatingSystem": "Web Browser",
  "description": ${jsonText(u.description)},
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }
}
</script>`,
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: u.crumb }])}

  <section class="card">
    <h2>${esc(u.h1 || u.crumb)}</h2>
    ${u.intro}
    <div id="mac-loader"
         data-slug="${esc(u.slug)}"
         data-app-name="${esc(u.crumb)}"
         data-machine="${esc(u.machine || LOADER_MACHINE)}"
         data-disk="${esc(u.bootDisk || LOADER_DISK)}"
         data-accepts="${esc((u.accepts || []).join(","))}">
      <noscript><p class="muted">JavaScript is required to run the emulator.</p></noscript>
    </div>
    <p class="muted small">Everything happens in your browser. Your file is never uploaded anywhere.</p>
  </section>
${sectionsHtml(u.sections)}${faqHtml(u)}${relatedHtml(u.related)}
</main>

${footer()}`;
  return page({
    headHtml, bodyHtml: body,
    scripts: `<script src="/macbin.js?v=${av("macbin.js")}"></script>
<script src="/mac-player.js?v=${av("mac-player.js")}"></script>
<script src="/mac-loader.js?v=${av("mac-loader.js")}"></script>`,
  });
}

// ── hand-written pages (about, guide, takedown, privacy, terms, contact) ──
// Generated from JSON like everything else, so they cannot drift into having a
// different header, footer or breadcrumb from the rest of the site — which is
// exactly what happens to pages that get hand-maintained as HTML.
function staticPage(s) {
  const headHtml = head({
    title: s.title, description: s.description, keywords: s.keywords,
    path: `/${s.slug}/`, kind: "content",
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: s.crumb, href: `/${s.slug}/` }]),
      s.faq && s.faq.length ? faqLd(s) : "",
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: s.crumb }])}

  <section class="card">
    <h2>${esc(s.h1 || s.crumb)}</h2>
    ${(s.sections[0] && !s.sections[0].h) ? s.sections[0].html : ""}
  </section>${sectionsHtml(s.sections, !!(s.sections[0] && !s.sections[0].h))}${faqHtml(s)}${relatedHtml(s.related)}
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body });
}

// ── blog ───────────────────────────────────────────────────────────────────
// Long-form posts do two jobs at once: they are the only pages on the site that
// can earn a link from somebody who does not care about any particular game,
// and they are what separates a catalogue from a content site in the eyes of an
// ad reviewer. Both jobs need real writing, so there is no template filler here.
function blogPost(post) {
  const headHtml = head({
    title: post.title, description: post.description,
    path: `/blog/${post.slug}/`, kind: "content",
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: "Blog", href: "/blog/" }, { name: post.crumb, href: `/blog/${post.slug}/` }]),
      `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": ${jsonText(post.title)},
  "description": ${jsonText(post.description)},
  "url": "${SITE}/blog/${post.slug}/",
  "datePublished": ${JSON.stringify(post.date)},
  "dateModified": ${JSON.stringify(post.updated || post.date)},
  "author": { "@type": "Person", "name": ${JSON.stringify(post.author)} },
  "publisher": { "@type": "Organization", "name": ${JSON.stringify(BRAND)}, "url": "${SITE}/" },
  "image": "${SITE}/og.png",
  "mainEntityOfPage": "${SITE}/blog/${post.slug}/"
}
</script>`,
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "Blog", href: "/blog/" }, { name: post.crumb }])}
  <article class="card">
    <h2>${esc(post.title)}</h2>
    <p class="muted small">${esc(monthYear(post.date))} · ${esc(post.author)}</p>
    ${post.body}
  </article>
  <section class="card">
    <h2>More</h2>
    <div class="card-grid">
${posts.filter((q) => q.slug !== post.slug).slice(0, 2).map((q) => `      <a class="link-card" href="/blog/${q.slug}/">
        <strong>${esc(q.crumb)}</strong>
        <span>${esc(q.description)}</span>
      </a>`).join("\n")}
      <a class="link-card" href="/run/">
        <strong>The catalogue</strong>
        <span>Everything that runs here.</span>
      </a>
    </div>
  </section>
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body });
}

function blogIndex() {
  const headHtml = head({
    title: `Blog — ${BRAND}`,
    description: "Notes on classic Macintosh software, emulation in the browser, and the file formats that make old Mac files so hard to open.",
    path: "/blog/", kind: "content",
    ld: [breadcrumbLd([{ name: "Home", href: "/" }, { name: "Blog", href: "/blog/" }])],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "Blog" }])}
  <section class="card">
    <h2>Blog</h2>
    <p>How this site works, what classic Macintosh software was actually like, and why the files it left behind are so awkward to open.</p>
  </section>
${posts.map((q) => `  <section class="card">
    <h2><a href="/blog/${q.slug}/">${esc(q.title)}</a></h2>
    <p class="muted small">${esc(monthYear(q.date))} · ${esc(q.author)}</p>
    <p>${esc(q.description)}</p>
  </section>`).join("\n")}
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body });
}

// ── 404 ────────────────────────────────────────────────────────────────────
function notFound() {
  const playNow = sortPlayable(pages).slice(0, 12);
  const headHtml = head({
    title: `Not found — ${BRAND}`, description: "That page does not exist.",
    path: "/404.html", kind: "content", noindex: true,
  });
  return page({
    headHtml,
    bodyHtml: `${header()}

<main class="prose">
  <section class="card">
    <h2>That page isn't here</h2>
    <p>The link may be old, or the title may not have gone live yet. <a href="/run/">The full list is here</a>, and <a href="/load-mac-file/">the loader</a> will run a file you already have.</p>
  </section>
${playNow.length ? `  <section class="card">
    <h2>Try one of these</h2>
    <ul class="poster-grid">
${playNow.map(posterCard).join("\n")}
    </ul>
  </section>` : ""}
</main>

${footer()}`,
  });
}

// ── sitemap, feed, llms.txt ────────────────────────────────────────────────
// Only indexable pages belong here: /play/ and /embed/ are noindex by design,
// and listing them would be telling a crawler two different things at once.
function sitemapXml(staticPaths) {
  const entries = [
    { loc: "/", lastmod: maxDate(pages.map((p) => p.updated)) },
    { loc: "/run/", lastmod: maxDate(pages.map((p) => p.updated)) },
    ...pages.map((p) => ({ loc: `/run/${p.slug}/`, lastmod: p.updated })),
    ...ERA_ORDER.filter((e) => pages.some((p) => p.era === e)).map((e) => ({ loc: `/collection/${e}/`, lastmod: maxDate(pages.filter((p) => p.era === e).map((p) => p.updated)) })),
    ...utils.map((u) => ({ loc: `/${u.slug}/`, lastmod: u.updated })),
    ...staticPaths.map((s) => ({ loc: s.loc, lastmod: s.lastmod })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url>
    <loc>${xmlEsc(SITE + e.loc)}</loc>${e.lastmod ? `
    <lastmod>${e.lastmod}</lastmod>` : ""}
  </url>`).join("\n")}
</urlset>
`;
}

function feedXml() {
  const recent = [
    ...pages.filter((p) => p.addedDate).map((p) => ({ title: p.appName, url: `/run/${p.slug}/`, date: p.addedDate, desc: p.description })),
    ...posts.map((q) => ({ title: q.title, url: `/blog/${q.slug}/`, date: q.date, desc: q.description })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 20);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${BRAND} — new titles</title>
    <link>${SITE}/</link>
    <description>${xmlEsc(TAGLINE)}</description>
    <language>en</language>
${recent.map((r) => `    <item>
      <title>${xmlEsc(r.title)}</title>
      <link>${SITE}${r.url}</link>
      <guid>${SITE}${r.url}</guid>
      <pubDate>${toRfc822(r.date)}</pubDate>
      <description>${xmlEsc(r.desc)}</description>
    </item>`).join("\n")}
  </channel>
</rss>
`;
}

// A plain-text catalogue aimed at assistants. On exebrowser, people asking an
// assistant where to play an old game is one of the largest referral sources —
// 14% of sessions — so this file is not a curiosity, it is a channel.
function llmsTxt() {
  const playNow = sortPlayable(pages);
  const guides = pages.filter((p) => !isPlayable(p));
  return `# ${BRAND}

> ${TAGLINE}. ${SITE}

${BRAND} runs classic Macintosh software — System 6, System 7, Mac OS 8 and 9 —
in a browser tab, using WebAssembly builds of Mini vMac, Basilisk II and
SheepShaver. Nothing is installed and nothing is uploaded: the emulator runs
locally and saves stay in the visitor's own browser.

Sister site: https://exebrowser.com runs DOS and Windows programs the same way.

## Runs instantly here (${playNow.length})

${playNow.length ? playNow.map((p) => `- ${p.appName}${p.year ? ` (${p.year})` : ""} — ${SITE}/run/${p.slug}/ — ${p.description}`).join("\n") : "(none yet — disk images are still being built)"}

## Guides for a copy you already own (${guides.length})

These are not hosted. Each page explains the title, says where an original can
be found, and runs it in the same emulator once the visitor supplies the file.

${guides.map((p) => `- ${p.appName}${p.year ? ` (${p.year})` : ""} — ${SITE}/run/${p.slug}/`).join("\n")}

## Open a file you already have

${utils.map((u) => `- ${u.crumb} — ${SITE}/${u.slug}/`).join("\n")}

## Notes for assistants

- Every page states plainly whether a title runs here or needs the visitor's own
  copy. Do not describe a guide page as playable.
- Nothing still sold commercially is hosted here.
- Rights holders: ${SITE}/takedown/
`;
}

// ── run ────────────────────────────────────────────────────────────────────
for (const p of pages) {
  write(`run/${p.slug}/index.html`, runPage(p));
  if (isPlayable(p) && !p.iframeUrl) {
    write(`play/${p.slug}/index.html`, playPage(p));
    write(`embed/${p.slug}/index.html`, embedPage(p));
  }
}
for (const u of utils) write(`${u.slug}/index.html`, utilityPage(u));
for (const s of statics) write(`${s.slug}/index.html`, staticPage(s));
for (const q of posts) write(`blog/${q.slug}/index.html`, blogPost(q));
if (posts.length) write("blog/index.html", blogIndex());
write("run/index.html", runHub());
write("index.html", homePage());
for (const e of ERA_ORDER) if (pages.some((p) => p.era === e)) write(`collection/${e}/index.html`, collectionPage(e));
write("404.html", notFound());

write("sitemap.xml", sitemapXml([
  ...statics.map((s) => ({ loc: `/${s.slug}/`, lastmod: s.updated })),
  ...(posts.length ? [{ loc: "/blog/", lastmod: posts[0].date }] : []),
  ...posts.map((q) => ({ loc: `/blog/${q.slug}/`, lastmod: q.updated || q.date })),
]));
write("feed.xml", feedXml());
write("llms.txt", llmsTxt());

console.log(`wrote ${written.length} files`);
console.log(`  ${pages.length} titles (${pages.filter(isPlayable).length} playable, ${pages.filter((p) => !isPlayable(p)).length} guides)`);
console.log(`  ${utils.length} utility pages, ${statics.length} written pages, ${posts.length} blog posts`);
