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
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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

// CHOOSING A MACHINE FOR A TITLE
//
// Hosted titles run on a Macintosh II under Mini vMac. The loader pages run a
// Macintosh IIfx under Basilisk II. They are different for one reason each.
//
// Mini vMac's Mac II boots the screen in COLOUR. Basilisk II boots it in black
// and white, and nothing in the emulator's configuration changes that — the
// depth lives in the Mac's parameter RAM, which starts zeroed every time. A
// visitor would have to open the Monitors control panel before a colour game
// would agree to start, and two of the first three titles tried here refused
// outright: Arashi puts up "requires 256 colors to run" with its Start button
// greyed out. Mini vMac simply comes up in colour.
//
// Basilisk II earns the loader pages because Mini vMac has no host file
// sharing at all, so a dropped .sit has nowhere to go. Title pages never need
// that, so they do not pay for it.

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
    extraHead: `\n<meta name="theme-color" content="#131313" />`,
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
    headHtml, bodyHtml: body, bodyClass: "is-play",
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
    extraHead: `\n<meta name="theme-color" content="#131313" />`,
  });
  const body = `${macMount(p, { mode: "fallback" })}
<div class="embedbar"><a href="${SITE}/play/${p.slug}/" target="_blank" rel="noopener">▶ Full speed on ${BRAND}</a></div>`;
  return page({ headHtml, bodyHtml: body, bodyClass: "is-embed", scripts: `<script src="/mac-player.js?v=${av("mac-player.js")}"></script>` });
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
      <li><strong>Shareware.</strong> A model built on being copied. Most shareware licences explicitly permit non-profit redistribution of the unregistered version, provided nothing is modified and the whole package is included — which is why the registration notices these programs open with are left exactly where their authors put them.</li>
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
  const meta = ERA_META[era] || {};
  const headHtml = head({
    title: meta.title || `${label} software you can run in a browser — ${BRAND}`,
    description: meta.description || `Games and applications from the ${label} era of the Macintosh, running in a browser tab.`,
    keywords: meta.keywords || "",
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
    ${ERA_BODY[era] || ""}
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
const ERA_BODY = {
  "system-6": "\n<p>A Macintosh Plus is eight megahertz, one megabyte of memory as standard, and a nine-inch screen showing 512 by 342 pixels in pure black and white. No greys. No colour. No hard disk unless you bought one separately. It is, by any modern measure, a rounding error of a computer.</p>\n<p>It is also the machine that convinced people a graphical interface was worth having, and the software written for it is unusually good, because the constraints left no room for anything that was not.</p>\n\n<h3>Why System 6 software still feels fast</h3>\n<p>Partly because it is: emulating an eight-megahertz 68000 in WebAssembly costs a modern processor almost nothing, which is why these are the only titles on this site genuinely comfortable on a phone. The whole machine starts in about a second.</p>\n<p>But mostly because of how it was written. There was no memory to waste and no processor headroom to hide behind, so a program did what you asked immediately or it did not ship. MacPaint responds to the mouse with no perceptible delay on hardware that would struggle to decode a modern JPEG. That is a design achievement, not a hardware one, and it survives emulation intact.</p>\n\n<h3>The black and white is the aesthetic</h3>\n<p>One bit per pixel means no anti-aliasing, no gradients and no soft edges — so the entire visual language of the era is built from dithering. Fifty-odd fill patterns that read as shades of grey from a normal viewing distance and resolve into checkerboards up close. Icons drawn pixel by pixel. Susan Kare's typefaces, designed as bitmaps at specific sizes rather than scaled from outlines.</p>\n<p>It has aged far better than the colour era that followed. A 1987 Macintosh screen looks deliberate. A 1995 one, with its 256-colour gradients and beveled everything, mostly looks like 1995.</p>\n\n<h3>What ran on it</h3>\n<p>MacPaint and MacWrite shipped with the machine. HyperCard arrived in 1987 and was given away free, which produced a decade of software written by people who did not consider themselves programmers. Games were small, sharp and often shareware: Dark Castle, Shufflepuck Café, Crystal Quest, Glider, Continuum, Lode Runner. Kid Pix came in 1989 and was black and white for exactly this reason.</p>\n<p>The strict limits also mean that a program written for a Mac Plus will often refuse to run under Mac OS 9, while the reverse is never true. If something here will not start on a later machine, the screen depth is usually why: code that assumes one bit per pixel does not survive contact with colour.</p>\n\n<h3>How it runs here</h3>\n<p>Mini vMac, compiled to WebAssembly. It emulates the compact Macs precisely and is small enough that startup is close to instant. The screen size is fixed by the hardware rather than a setting — ask for 800 by 600 and you get 512 by 342, because that is what a Macintosh Plus had.</p>\n<p>The system software is System 6.0.8, the last and most stable of the line. If you want to run your own copy of something from this era, <a href=\"/load-mac-file/\">the loader</a> takes disk images and archives and opens them on an emulated Mac.</p>\n",
  "system-7": "\n<p>System 7 shipped in May 1991 and ran, in one revision or another, until 1997. If you used a Macintosh and remember it, this is almost certainly what you remember: colour icons, the Apple menu you could put your own things in, aliases, balloon help, and a Finder that could copy files while you did something else.</p>\n\n<h3>What System 7 actually changed</h3>\n<p>It was the first fully 32-bit-clean system, which sounds like an implementation note and was in fact the thing that let a Macintosh address more than eight megabytes of memory. MultiFinder stopped being optional, so running two programs at once became normal rather than a setting you enabled.</p>\n<p>Three smaller additions mattered more day to day. <strong>Aliases</strong> — a file that points at another file, which the system tracks even if you move the original. <strong>The customisable Apple menu</strong>, which was a folder, so anything you dropped into it appeared in the menu. And <strong>drag and drop between applications</strong>, which is so ordinary now that its absence is hard to imagine.</p>\n<p>The System Folder was also reorganised into Extensions, Control Panels and Preferences, which is the reason anyone who used a Mac in the 1990s knows the phrase \"extension conflict\". Holding Shift at startup to disable them all was standard troubleshooting.</p>\n\n<h3>The era this covers</h3>\n<p>The shareware boom, the CD-ROM boom, and the school computer lab. Info-Mac and the University of Michigan archive. Games that came on floppies and games that came on discs with full-motion video. The Oregon Trail in colour. Marathon. Myst. Kid Pix 2. After Dark's flying toasters, which were an extension, which is why they only exist inside a running System 7.</p>\n<p>It is also where nearly everything on this site lives. System 7 ran for six years across an enormous range of hardware, so most Macintosh software of any consequence targets it.</p>\n\n<h3>How it runs here</h3>\n<p>Basilisk II, compiled to WebAssembly, emulating a 68k Macintosh with System 7.5.3 — the free update Apple released in 1996 and the most widely compatible version of the line. 640 by 480 in 256 colours, which is what most software of the period expects.</p>\n<p>The specific machine is a Macintosh IIfx rather than the faster Quadra, for an unglamorous reason: with the Quadra's ROM this particular System 7.5 install reads a few kilobytes, decides nothing is bootable, and stops on a black screen with no error at all. The IIfx boots it in full. Emulation is like that sometimes.</p>\n<p>Basilisk II also shares a folder with the browser, which appears on the desktop as \"The Outside World\" — that is where a file you drop into <a href=\"/load-mac-file/\">the loader</a> arrives.</p>\n",
  "mac-os-8": "\n<p>Mac OS 8 arrived in July 1997, at the point where Apple was close enough to failing that its survival was a live question in the press. It is a better system than that story suggests.</p>\n\n<h3>What it brought</h3>\n<p>The <strong>Platinum</strong> appearance replaced the flat grey of System 7 with soft three-dimensional shading — the look most people picture when they think \"old Mac OS\", and the first time the interface had been visually overhauled since 1984. <strong>Contextual menus</strong> arrived, on a one-button mouse, via Control-click. The <strong>Finder became multi-threaded</strong>, so copying a large folder no longer froze everything.</p>\n<p>Mac OS 8.1, in January 1998, added <strong>HFS Plus</strong>, which fixed a genuine problem: on the old filesystem a one-gigabyte disk allocated space in sixteen-kilobyte blocks, so a one-byte file consumed sixteen kilobytes, and a drive full of small files wasted most of itself.</p>\n\n<h3>Why this is a small collection</h3>\n<p>Most software that ran under Mac OS 8 also ran under System 7.5, because developers had no reason to abandon an installed base that large. A title genuinely needs Mac OS 8 only if it depends on the Appearance Manager or the newer filesystem, which is a short list.</p>\n<p>In practice, if something from this era will run under System 7, it is better off there — the emulation is lighter and the machine starts faster. This era matters most as the bridge to Mac OS 9 and, from there, to the end of the classic Mac OS entirely.</p>\n\n<h3>How it runs here</h3>\n<p>Basilisk II for the 68k releases, SheepShaver for anything that requires PowerPC. Both compiled to WebAssembly and both heavier than the System 6 and System 7 machines — worth it for titles that need them, unnecessary for anything that does not.</p>\n",
  "mac-os-9": "\n<p>Mac OS 9 shipped in October 1999 and was the end of a line that started in 1984. Apple knew it: Mac OS X was already in development, and 9 spent its last years as the Classic environment running inside its own successor, in a window, on machines that no longer needed it.</p>\n\n<h3>The last of its kind</h3>\n<p>It was also the best version of what it was. The Keychain arrived, and multiple user accounts, and Sherlock's internet search channels, and software update over the network. It was fast on the PowerPC G3 and G4 hardware of the time in a way no earlier classic system had been.</p>\n<p>What it never got was the thing it most needed. The classic Mac OS used cooperative multitasking: a program kept the processor until it chose to give it back, so one badly written application could freeze the entire machine. Every classic system had this flaw and none of them could fix it without starting over. Mac OS X, built on a Unix kernel, was the starting over.</p>\n\n<h3>Why this is the heaviest emulation here</h3>\n<p>Mac OS 9 needs a PowerPC processor, which means SheepShaver rather than the 68k emulators, and PowerPC emulation in a browser is substantially more work per instruction. Boots are slower and the frame rate is lower.</p>\n<p>So the rule for this era is simple: if a title will run under System 7, run it there. Use Mac OS 9 for software that genuinely requires it — later games, PowerPC-only applications, anything shipped after about 1998.</p>\n\n<h3>Where the line falls</h3>\n<p>Mac OS 9 is the last system this site emulates, and the boundary is not arbitrary. Mac OS X is a different operating system on a different foundation, and while it can be emulated — the <a href=\"https://infinitemac.org/\" rel=\"noopener\">Infinite Mac</a> project does it — the result takes minutes to boot and is slow once there. The <a href=\"/guide/\">what runs page</a> explains the line in full.</p>\n"
};

const ERA_META = {
  "system-6": {
    "title": "System 6 Software Online — The Compact Mac, in Your Browser",
    "description": "System 6 on an emulated Macintosh Plus: 512×342, black and white, and fast enough for a phone. What ran on it and why it still starts in a second.",
    "keywords": "system 6 online, macintosh plus emulator, mac system 6, compact macintosh, mini vmac online, black and white mac"
  },
  "system-7": {
    "title": "System 7 Online — Run the Classic Mac OS in Your Browser",
    "description": "System 7 on an emulated Macintosh: colour, aliases, the Apple menu you could fill yourself. The six years most people actually remember, running in a tab.",
    "keywords": "system 7 online, run system 7 in browser, mac os 7, classic mac os emulator, basilisk ii online, system 7.5.3"
  },
  "mac-os-8": {
    "title": "Mac OS 8 Online — Platinum, in Your Browser",
    "description": "Mac OS 8 on an emulated Macintosh: the Platinum look, contextual menus and a threaded Finder. The last classic system that still felt like the old Mac.",
    "keywords": "mac os 8 online, mac os 8 emulator, platinum appearance, classic mac os 8, mac os 8.1"
  },
  "mac-os-9": {
    "title": "Mac OS 9 Online — The End of the Classic Mac OS, in a Browser",
    "description": "Mac OS 9 on an emulated PowerPC Macintosh. The last and fastest classic system, and the software that needed it.",
    "keywords": "mac os 9 online, mac os 9 emulator, powerpc mac emulator, sheepshaver online, classic mac os 9"
  }
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

// ── clean up what should no longer exist ───────────────────────────────────
// The generator writes; without this it never unwrites. A title that stops
// being playable — because its disk was withdrawn, or the entry was reverted to
// a guide — leaves its /play/ and /embed/ pages on disk, and they get deployed,
// indexed, and served with a Play button for software that is no longer there.
// That is the exact promise this site refuses to make, so removal is part of
// generating rather than something to remember.
{
  const shouldExist = new Set(pages.filter((p) => isPlayable(p) && !p.iframeUrl).map((p) => p.slug));
  for (const route of ["play", "embed"]) {
    const dir = resolve(ROOT, route);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || shouldExist.has(entry.name)) continue;
      rmSync(resolve(dir, entry.name), { recursive: true, force: true });
      console.log(`  removed stale /${route}/${entry.name}/`);
    }
  }
  // Same for a screenshot left behind by a title that is no longer in the
  // catalogue at all.
  const runDir = resolve(ROOT, "run");
  const known = new Set(pages.map((p) => p.slug));
  if (existsSync(runDir)) {
    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      rmSync(resolve(runDir, entry.name), { recursive: true, force: true });
      console.log(`  removed stale /run/${entry.name}/`);
    }
  }
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
