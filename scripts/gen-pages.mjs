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
  categoryChips, jsonText, maxDate, toRfc822, itemListLd, ERA_ORDER, ERA_LABELS, shotAlt,
} from "./catalogue.mjs";
import {
  BRAND, TAGLINE, head, header, footer, nav, page, crumbs, breadcrumbLd,
  monthYear, adsAllowed, setAssetVersions, av,
} from "./site.mjs";

const ROOT = resolve(process.cwd(), "public");

// Content-hash every asset the pages reference, so a changed file always gets a
// changed URL and a returning visitor never runs yesterday's JavaScript against
// today's HTML.
const ASSETS = ["style.css", "macbin.js", "mac-player.js", "mac-loader.js", "grid-filter.js", "continue-playing.js"];
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
//
// The Mac II is not automatically right either. Some titles ship as a
// black-and-white build that refuses to start on a colour screen — SimCity 1.2
// opens, finds a colour monitor and quits, leaving a bare desktop and no error.
// Those run on a Macintosh SE (512x342, one bit), which is what they were
// written for. So the rule is: match the machine to the build, and the way you
// find out is to boot it and look.

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
// Social cards. Pages ask for one by key and get its URL back; the specs are
// written to public/og/cards.json and scripts/og-cards.mjs renders them. A raw
// 512x342 screenshot shared on a social feed is a grey smear cropped to 1.91:1;
// a card says what the thing is and where to play it. The gate fails a page
// whose card was never rendered.
const OG_CARDS = {};
function ogCard(key, spec) {
  OG_CARDS[key] = spec;
  return `${SITE}/og/${key}.png`;
}
const shotsFor = (list, n) => sortPlayable(list).filter((q) => screenshotFile(q)).slice(0, n)
  .map((q) => `run/${q.slug}/${screenshotFile(q)}`);
const ogImage = (p) => {
  const f = screenshotFile(p);
  if (!f) return `${SITE}/og.png`;
  return ogCard(p.slug, {
    kind: "title", title: p.appName,
    sub: [p.author, p.year].filter(Boolean).join(" · "),
    tag: isPlayable(p) ? "Play it in your browser" : "Open your own copy in your browser",
    shots: [`run/${p.slug}/${f}`],
  });
};
const screenOf = (p) => p.screen || { w: 640, h: 480, depth: 8 };

// ── structured data ────────────────────────────────────────────────────────
function appLd(p) {
  const url = `${SITE}/run/${p.slug}/`;
  const common = `  "name": ${jsonText(p.appName)},
  "url": "${url}",
  "image": "${ogImage(p)}",
  "description": ${jsonText(p.description)},
  "operatingSystem": "Web Browser"${shotUrl(p) ? `,
  "screenshot": "${shotUrl(p)}"` : ""}${p.year ? `,
  "datePublished": "${esc(String(p.year))}"` : ""}${p.author ? `,
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

// Homepage only. Tells a search engine what the site is called and who runs
// it, which is what feeds the site name shown above a result. No SearchAction:
// the site has no search page, and declaring one that does not exist is worse
// than declaring none.
function siteLd() {
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "@id": "${SITE}/#website", "name": "${BRAND}", "url": "${SITE}/", "inLanguage": "en", "publisher": { "@id": "${SITE}/#org" } },
    { "@type": "Organization", "@id": "${SITE}/#org", "name": "${BRAND}", "url": "${SITE}/", "logo": "${SITE}/apple-touch-icon.png", "email": "hello@macemu.com" }
  ]
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

// Whether a title is unplayable without a physical keyboard: arrow keys,
// typed commands, Space to fire. Read off the controls table, so a phone
// visitor can be told before the machine spends a minute booting.
// `touchOk: true` on a title overrides it, for a game played with the pointer
// that merely has keyboard extras (Crystal Quest's smart bomb on Space).
const needsKeyboard = (p) => !p.touchOk &&
  (p.macControls || []).some((c) => /arrow|type \+ return|keyboard|\bspace\b|\bshift\b/i.test(c.keys || ""));

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
    `data-extra-disks="${esc((p.extraDisks || []).join(","))}"`,
    // Persistence routes the disk through an origin-private-file-system
    // saver so writes survive a reload — which is what lets someone come back
    // to a saved game. It has been seen to stop a machine booting, so the
    // player treats a persistent boot as revocable: if it fails it retries
    // once without and remembers, per title, in localStorage.
    `data-persist="${p.persist ? "true" : "false"}"`,
    // The names the emulator gives its persistent files in the origin private
    // file system. It uses each manifest's `name` field — "Archon v2" — not
    // the manifest's filename, so a player that guessed from the slug would
    // look for a save that is not there and delete nothing when asked to.
    (() => {
      const names = [p.bootDisk].concat(p.extraDisks || []).filter(Boolean)
        .map((d) => {
          try {
            return JSON.parse(readFileSync(resolve(ROOT, "mac", "disks", `${d}.json`), "utf8")).name || d;
          } catch { return d; }
        });
      return names.length ? `data-disk-names="${esc(JSON.stringify(names))}"` : "";
    })(),
    // What the visitor has to do once the machine is up. 59 of the 101 titles
    // need a first action — click Start Game, allow 256 colours, press Demo,
    // wait for the screensaver — and until now that was a line of small grey
    // text UNDER the player, which is both easy to miss and not on screen at
    // all in fullscreen. The player shows it over the machine instead.
    p.launchNote ? `data-launch-note="${esc(p.launchNote)}"` : "",
    // The controls table again, for the player's own overlay. The article
    // under the screen carries the same information, but in fullscreen there
    // is no article — and fullscreen is exactly when someone needs reminding
    // which key throws the ball.
    p.macControls && p.macControls.length
      ? `data-controls="${esc(JSON.stringify(p.macControls.map((c) => [c.keys, c.does])))}"`
      : "",
    `data-width="${s.w}"`,
    `data-height="${s.h}"`,
    p.ramMB ? `data-ram="${p.ramMB}"` : "",
    `data-mode="${mode}"`,
    p.era ? `data-era="${esc(p.era)}"` : "",
    // The title's own screenshot behind the Start button. Absolute, because
    // the same mount appears on /run/, /play/ and /embed/.
    // Only when the file is really there: a brand-new title's screenshot is
    // taken by booting the page, and a poster pointing at a 404 fails that boot.
    screenshotFile(p) && existsSync(resolve(ROOT, "run", p.slug, screenshotFile(p)))
      ? `data-poster="/run/${esc(p.slug)}/${esc(screenshotFile(p))}"` : "",
    ...(() => {
      const next = relatedPlayable(p, pages, 1)[0];
      return next ? [`data-next-slug="${esc(next.slug)}"`, `data-next-name="${esc(next.appName)}"`] : [];
    })(),
    needsKeyboard(p) ? `data-needs-keyboard="true"` : "",
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
  // doorway. The loader takes the visitor's own copy and runs it, and says so
  // before the visitor goes looking for a Play button that is not there.
  const accepts = (p.byo && p.byo.accepts) || [".sit", ".hqx", ".bin", ".img", ".dsk", ".toast", ".iso", ".zip"];
  return `
    <p class="byo-lede"><strong>${esc(p.appName)} is not hosted here.</strong> ${p.sold
      ? "It is still sold, so it never will be."
      : "Drop a copy you already own into the loader below and it runs on an emulated Macintosh, in this tab."} ${p.download ? "Where to find one is further down the page." : ""}</p>
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
      <img src="/run/${p.slug}/${f}" width="${d.w}" height="${d.h}" loading="lazy" alt="${esc(shotAlt(p))}" />
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
    // On a guide page the machine is what the loader WILL use, not what the
    // page is running — say so, rather than implying something is live.
    emulatorFor(p) ? `${isPlayable(p) ? "" : "runs under "}${emulatorFor(p)} (${(p.machine || "").replace(/-/g, " ")})` : "",
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

function relatedHtml(related, pages) {
  if (!related || !related.length) return "";
  // Two shapes, both in use. The older entries carry a hand-written card
  // ({href, title, desc}); newer ones are just a slug, because writing a
  // bespoke blurb three times per page for a hundred pages is how you end up
  // with a hundred bad blurbs. A slug is resolved against the catalogue.
  // Anything that resolves to neither is dropped rather than rendered as
  // href="undefined", which is what shipped before this existed.
  const resolve = (r) => {
    if (r && typeof r === "object" && r.href) return r;
    if (typeof r !== "string") return null;
    const t = (pages || []).find((x) => x.slug === r);
    if (!t) return null;
    return { href: `/run/${t.slug}/`, title: t.appName || t.crumb || t.slug,
             desc: t.ogDescription || t.description || "" };
  };
  const cards = related.map(resolve).filter(Boolean).map((r) => `      <a class="link-card" href="${esc(r.href)}" data-rec="keep-going">
        <strong>${esc(r.title)}</strong>
        <span>${esc(r.desc)}</span>
      </a>`).join("\n");
  if (!cards) return "";
  return `
  <section class="card">
    <h2>Keep going</h2>
    <div class="card-grid">
${cards}
    </div>
  </section>`;
}

// Playable titles most like this one, best first: those sharing a hub, then
// the same era, then the site's running order. It used to be the global top
// six on every page, so someone who came for an Infocom adventure was offered
// the same arcade games as someone who came for Maelstrom.
function relatedPlayable(current, all, n) {
  const hubs = CATEGORY_HUBS.filter((h) => h.match(current));
  const score = (p) => hubs.filter((h) => h.match(p)).length * 2 + (p.era === current.era ? 1 : 0);
  return sortPlayable(all)
    .filter((p) => p.slug !== current.slug)
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map((x) => x.p);
}

// Six more playable titles, so a page that got a visitor from search has
// somewhere to send them. Only ever links to titles that actually run.
function alsoPlayHtml(current, all) {
  const others = relatedPlayable(current, all, 6);
  if (others.length < 3) return "";
  return `
  <section class="card">
    <h2>Play something else</h2>
    <ul class="poster-grid">
${others.map((q) => posterCard(q, "also")).join("\n")}
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
    <h1 class="page-title">${esc(p.h1 || p.crumb)} <span class="verdict ${p.verdict.kind}">${esc(p.verdict.text)}</span>${!playable && p.fullyFree ? `
    <span class="verdict good" title="The licence is clear; this site simply does not host a copy">Freely licensed</span>` : ""}</h1>
    ${specLine(p)}${p.updated ? `
    <p class="muted small">Guide updated ${esc(monthYear(p.updated))}${playable ? "" : " · needs your own copy"}</p>` : ""}
    ${p.intro}${playerBlock(p)}${p.launchNote && playable ? `
    <p class="muted small">${esc(p.launchNote)}</p>` : ""}${controlsHtml(p)}${figureHtml(p)}${soldHtml(p)}${licenseHtml(p)}
  </section>${downloadHtml(p)}${sectionsHtml(p.sections)}${faqHtml(p)}${embedBlockHtml(p)}${alsoPlayHtml(p, pages)}${relatedHtml(p.related, pages)}${hubLinksHtml(p)}
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
<div class="embedbar"><a id="embed-out" href="${SITE}/play/${p.slug}/?utm_source=embed&amp;utm_medium=embed&amp;utm_campaign=${esc(p.slug)}" target="_blank" rel="noopener">▶ Full speed on ${BRAND}</a></div>
<script>
  // Name the site this embed is sitting on, so a visit that comes through it
  // is credited to that site rather than to macemu.com's own /embed/ page —
  // which is what the referrer of a click inside an iframe otherwise says.
  try {
    var host = document.referrer ? new URL(document.referrer).hostname : "";
    if (host && host !== location.hostname) {
      var a = document.getElementById("embed-out");
      a.href = a.href.replace("utm_source=embed", "utm_source=" + encodeURIComponent(host));
    }
  } catch (e) {}
</script>`;
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
    <h1 class="page-title">Everything on ${BRAND}</h1>
    <p>${playNow.length ? `<strong>${playNow.length}</strong> titles start in a click — nothing to install, nothing uploaded.` : "Titles are being added as their disk images are built and checked."} ${guides.length ? `Another <strong>${guides.length}</strong> have guides for running a copy you already own, using the same emulator and the same <a href="/load-mac-file/">file loader</a>.` : ""}</p>
    <p class="muted">This list is deliberately not exhaustive. There were tens of thousands of Macintosh programs, and a page that exists only to hold a name helps nobody. Each title here gets a real page: what it was, who made it, how to play it, what machine it needs, and where to find an original if you would rather run your own copy.</p>
  </section>

${playNow.length ? `  <section class="card">
    <h2>Play now</h2>
${gridFilter(playNow)}
    <ul class="poster-grid">
${playNow.map((q) => posterCard(q, "catalog")).join("\n")}
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
  return page({ headHtml, bodyHtml: body, scripts: `<script src="/grid-filter.js?v=${av("grid-filter.js")}"></script>\n<script src="/continue-playing.js?v=${av("continue-playing.js")}"></script>` });
}

function homePage() {
  const playNow = sortPlayable(pages);
  const headHtml = head({
    title: `${BRAND} — run classic Mac games and apps in your browser`,
    description: "System 6, System 7 and Mac OS 9 software running in a browser tab. No download, no install, nothing uploaded. Open your own .sit, .hqx or disk image too.",
    path: "/", kind: "content",
    ld: [siteLd(), itemListLd(playNow, { name: "Classic Mac titles playable in the browser", url: `${SITE}/` })],
  });
  const body = `${header()}

<main class="prose">
  <section class="card">
    <h1 class="page-title">Classic Mac games, running in a browser tab</h1>
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

  <!-- Filled by continue-playing.js from what this visitor has actually
       played, or left hidden. Rendered client-side on purpose: it is different
       for every visitor, so it must not be baked into a cached page, and it
       carries no SEO weight either way. -->
  <section class="card" id="continue-playing" hidden></section>

${playNow.length ? `  <section class="card">
    <h2>Start here</h2>
${gridFilter(playNow)}
    <ul class="poster-grid">
${playNow.map((q) => posterCard(q, "home")).join("\n")}
${byoCard()}
    </ul>
  </section>` : `  <section class="card">
    <h2>Being built in the open</h2>
    <p>Titles go live as their disk images are built and checked. Every page on the site already tells you honestly whether something runs here or needs your own copy — <a href="/run/">see the full list</a>.</p>
  </section>`}

  <section class="card">
    <h2>Browse</h2>
    <div class="card-grid">
${CATEGORY_HUBS.filter((h) => pages.some(h.match)).map((h) => `      <a class="link-card" href="/${h.slug}/">
        <strong>${esc(h.name)}</strong>
        <span>${pages.filter(h.match).length} titles</span>
      </a>`).join("\n")}
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
  return page({ headHtml, bodyHtml: body, scripts: `<script src="/grid-filter.js?v=${av("grid-filter.js")}"></script>\n<script src="/continue-playing.js?v=${av("continue-playing.js")}"></script>` });
}


// ── category hubs ─────────────────────────────────────────────────────────
// The era collections are organised the way the SITE thinks — System 6, System
// 7, Mac OS 8. Nobody searches that. These are organised the way a visitor
// thinks, and each one has to earn its place with real writing: a page that is
// only a grid of links is the thin content that got exebrowser turned down.
// Start with one hub rather than seven empty ones.
const CATEGORY_HUBS = [
  {
    slug: "school-computer-lab-games",
    name: "The school computer lab",
    match: (p) => (p.categories || []).includes("Classroom classics"),
    title: "School Computer Lab Games — Play the Originals Free",
    description: "The games from the school computer lab, playable free in your browser. Oregon Trail, Carmen Sandiego, Reader Rabbit and the rest, in their real Macintosh releases.",
    keywords: "school computer lab games, old educational computer games, games we played in school, 90s school games online, classroom games from the 90s, elementary school computer games",
    body: `<p>If you were at school in North America between about 1985 and 1998, there was a room with a dozen beige Macintoshes in it, and a rota that got you twenty minutes on one. This is what was on them.</p>
<p>The machines matter to the memory. School districts bought Apple, heavily and for years, which is why the version of <em>The Oregon Trail</em> most adults picture is the Macintosh one rather than the DOS release — the black-and-white wagon, the blocky river, the hunting screen where the deer moves faster than your cursor. Every title on this page is that version: the actual software, running on an emulated Macintosh, not a remake.</p>

<h2>Why these games worked</h2>
<p>None of them announced that they were teaching you anything, which is precisely why they did. <em>Carmen Sandiego</em> did not set out to teach geography; it made you look up a currency because the clock was running and the suspect was getting away. <em>The Oregon Trail</em> did not lecture about supply management; it let you buy too many bullets and not enough food, and then killed your entire family in Kansas.</p>
<p>That indirectness was a deliberate design position, and it is the reason these titles are remembered with affection while the drill-and-practice software of the same era is remembered not at all. The lesson arrived as a consequence of wanting something else.</p>

<h2>What the lab actually had</h2>
<p>MECC — the Minnesota Educational Computing Consortium — supplied a great deal of it, as a state-funded body that ended up shipping some of the most-played software of the century. Brøderbund supplied Carmen Sandiego. The Learning Company supplied Reader Rabbit. Davidson supplied Math Blaster. Between those four, most of a generation's screen time before 1995 is accounted for.</p>

<h2>A note on what is missing</h2>
<p>Number Munchers is not here, and it is the one people ask about. No working Macintosh copy appears to survive: the archived disk images are either truncated or turn out to hold the PC side of a hybrid disc. Super Munchers, from the same series, is here and does run. Kid Pix is not here either, for a different reason — it is still sold today, and this site does not host anything you can buy.</p>`,
  },
];

// The rest of the hubs live in hub-pages.json, as prose plus a declarative
// match: a title belongs if any of its genres, categories or provenance is
// listed, or its slug is named, and it is not excluded by slug.
const HUBS_FILE = resolve(process.cwd(), "scripts", "hub-pages.json");
for (const h of existsSync(HUBS_FILE) ? JSON.parse(readFileSync(HUBS_FILE, "utf8")) : []) {
  const m = h.match || {};
  CATEGORY_HUBS.push({
    ...h,
    match: (p) => !(m.exclude || []).includes(p.slug) && (
      (m.slugs || []).includes(p.slug)
      || (p.genre || []).some((g) => (m.genres || []).includes(g))
      || (p.categories || []).some((c) => (m.categories || []).includes(c))
      || (m.provenance || []).includes(p.provenance)),
  });
}

// "More like this" at the foot of a title page: every hub the title appears
// on. This is what makes the hubs part of the site rather than a side door —
// without it they are linked only from the homepage.
function hubLinksHtml(p) {
  const hubs = CATEGORY_HUBS.filter((h) => h.match(p));
  if (!hubs.length) return "";
  return `
  <section class="card">
    <h2>More like this</h2>
    <div class="card-grid">
${hubs.map((h) => `      <a class="link-card" href="/${h.slug}/" data-rec="more-like" data-slug="${esc(h.slug)}">
        <strong>${esc(h.name)}</strong>
        <span>${sortPlayable(pages.filter(h.match)).length} to play</span>
      </a>`).join("\n")}
    </div>
  </section>`;
}

function categoryPage(hub) {
  const list = pages.filter(hub.match);
  const playNow = sortPlayable(list);
  const headHtml = head({
    title: hub.title, description: hub.description, keywords: hub.keywords,
    path: `/${hub.slug}/`, kind: "content",
    ogImage: ogCard(`hub-${hub.slug}`, { kind: "collage", title: hub.name, tag: `${playNow.length} to play in your browser`, shots: shotsFor(list, 4) }),
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: hub.name, href: `/${hub.slug}/` }]),
      itemListLd(playNow, { name: hub.name, url: `${SITE}/${hub.slug}/` }),
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: hub.name }])}
  <section class="card">
    <h1 class="page-title">${esc(hub.name)}</h1>
    ${hub.body}
  </section>
${playNow.length ? `  <section class="card">
    <h2>Play now</h2>
    <ul class="poster-grid">
${playNow.map((q) => posterCard(q, "hub")).join("\n")}
    </ul>
  </section>` : ""}
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body });
}


// ── the embed offer ───────────────────────────────────────────────────────
// Every playable title is already served at /embed/<slug>/ and has been since
// the site launched, but nothing anywhere said so. Distribution was named as
// the growth lever and then left with no front door: no hub, no snippet, no
// mention on the page of the person most likely to want one.
//
// allowfullscreen is not optional in the snippet. The player checks
// document.fullscreenEnabled and hides its own fullscreen button when the
// framing page has not granted it, so a snippet without it ships a visibly
// poorer game to someone else's audience.
function embedSnippet(p) {
  const s = p.screen || { w: 640, h: 480 };
  return `<iframe src="${SITE}/embed/${p.slug}/"\n        width="${s.w}" height="${s.h}"\n        style="border:0;max-width:100%"\n        allowfullscreen\n        title="${esc(p.appName)}"></iframe>`;
}

function embedBlockHtml(p) {
  if (!isPlayable(p) || p.iframeUrl) return "";
  return `
  <section class="card" id="embed">
    <h2>Put ${esc(p.appName)} on your own site</h2>
    <p>Free, no permission needed and no account. Paste this where you want the machine to appear; it brings its own emulator and asks nothing of your page.</p>
    <pre class="embed-code"><code>${esc(embedSnippet(p))}</code></pre>
    <p class="muted small">Sized to this title's real screen. <a href="/embed-a-game/">How embedding works</a>.</p>
  </section>`;
}

const EMBED_HUB = {
  slug: "embed-a-game",
  title: "Embed a Classic Mac Game on Your Site — Free",
  description: "Put a working Macintosh game on your own page with one line of HTML. Free, no account, no permission needed. Every title on macemu can be embedded.",
  keywords: "embed classic game, embed mac game website, free game iframe, embeddable retro game, put a game on my website, classic mac game widget",
};

function embedHubPage() {
  const playable = sortPlayable(pages.filter((p) => isPlayable(p) && !p.iframeUrl));
  const sample = playable[0];
  const headHtml = head({
    title: EMBED_HUB.title, description: EMBED_HUB.description, keywords: EMBED_HUB.keywords,
    path: `/${EMBED_HUB.slug}/`, kind: "content",
    ld: [breadcrumbLd([{ name: "Home", href: "/" }, { name: "Embed a game", href: `/${EMBED_HUB.slug}/` }])],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "Embed a game" }])}
  <section class="card">
    <h1 class="page-title">Put a working Macintosh on your page</h1>
    <p>Every one of the ${playable.length} playable titles here can be embedded in somebody else's site with a single line of HTML. It is free, it needs no account and no permission, and there is nothing to ask us for.</p>
    <pre class="embed-code"><code>${esc(embedSnippet(sample))}</code></pre>
    <p>That is the whole of it. The frame loads its own emulator, fetches the disk in pieces as it needs them, and runs the real software. Your page does not need to change its headers, load a script, or do anything else.</p>

    <h3>Where the snippet lives</h3>
    <p>Every title's page carries its own, sized to that machine's real screen — a compact Macintosh is 512×342 and a Power Macintosh is 800×600, so one size would letterbox most of them. Open any title and the snippet is near the bottom.</p>

    <h3>Things worth knowing</h3>
    <p><strong>Keep <code>allowfullscreen</code>.</strong> The player offers a fullscreen button and hides it when the framing page has not granted permission. Drop the attribute and your visitors get a worse version than the one on this site.</p>
    <p><strong>It is not a video or a screenshot.</strong> The emulator runs in your visitor's browser, so the software is genuinely being operated rather than played back. Nothing is installed on their machine and nothing is uploaded from it.</p>
    <p><strong>The first start is the slow one.</strong> Disks are served in 256-kilobyte content-addressed pieces, so a returning visitor — and anyone who has opened another title of the same era — starts from cache.</p>
    <p><strong>No link back is required.</strong> It is appreciated and not demanded. If you would rather not link, embed it anyway.</p>

    <h3>What you may not embed</h3>
    <p>The same rule that governs this site governs the frames: nothing here is hosted if it is still sold, and every title carries a notice saying where it came from and on what footing. If a rightsholder asks for something to come down it comes down, and your embed will stop working with it. That is the honest trade for software of this age.</p>
  </section>

  <section class="card">
    <h2>Pick a title</h2>
    <p class="muted small">Each links to its page, where the ready-made snippet is waiting.</p>
    <ul class="poster-grid">
${sortPlayable(playable).slice(0, 24).map((q) => posterCard(q, "embed-hub")).join("\n")}
    </ul>
    <p><a href="/run/">See all ${playable.length} titles →</a></p>
  </section>
</main>

${footer()}`;
  return page({ headHtml, bodyHtml: body });
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
    ogImage: ogCard(`era-${era}`, { kind: "collage", title: `${label} software`, tag: `${playNow.length} to play in your browser`, shots: shotsFor(list, 4) }),
    ld: [
      breadcrumbLd([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: label, href: `/collection/${era}/` }]),
      itemListLd(playNow, { name: `${label} titles`, url: `${SITE}/collection/${era}/` }),
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "All titles", href: "/run/" }, { name: label }])}
  <section class="card">
    <h1 class="page-title">${esc(label)}</h1>
    ${ERA_BODY[era] || ""}
  </section>
${playNow.length ? `  <section class="card">
    <h2>Play now</h2>
    <ul class="poster-grid">
${playNow.map((q) => posterCard(q, "collection")).join("\n")}
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
  "mac-os-8": "\n<p>Mac OS 8 arrived in July 1997, at the point where Apple was close enough to failing that its survival was a live question in the press. It is a better system than that story suggests.</p>\n\n<h3>What it brought</h3>\n<p>The <strong>Platinum</strong> appearance replaced the flat grey of System 7 with soft three-dimensional shading — the look most people picture when they think \"old Mac OS\", and the first time the interface had been visually overhauled since 1984. <strong>Contextual menus</strong> arrived, on a one-button mouse, via Control-click. The <strong>Finder became multi-threaded</strong>, so copying a large folder no longer froze everything.</p>\n<p>Mac OS 8.1, in January 1998, added <strong>HFS Plus</strong>, which fixed a genuine problem: on the old filesystem a one-gigabyte disk allocated space in sixteen-kilobyte blocks, so a one-byte file consumed sixteen kilobytes, and a drive full of small files wasted most of itself.</p>\n\n<h3>Why this is a small collection</h3>\n<p>Most software that ran under Mac OS 8 also ran under System 7.5, because developers had no reason to abandon an installed base that large. A title genuinely needs Mac OS 8 only if it depends on the Appearance Manager or the newer filesystem, which is a short list.</p>\n<p>In practice, if something from this era will run under System 7, it is better off there — the emulation is lighter and the machine starts faster. This era matters most as the bridge to Mac OS 9 and, from there, to the end of the classic Mac OS entirely.</p>\n\n<h3>How it runs here</h3>\n<p>Basilisk II for the 68k releases, SheepShaver for anything that requires PowerPC. Both compiled to WebAssembly and both heavier than the System 6 and System 7 machines — worth it for titles that need them, unnecessary for anything that does not.</p>\n\n<h3>What a Power Macintosh costs to emulate</h3>\n<p>The compact Macs elsewhere on this site are small machines in every sense: a Macintosh SE is eight megahertz and its entire world fits in a few hundred kilobytes. A Power Macintosh 9500 is a PowerPC 604 with a real memory management unit, and Mac OS 8 expects a few hundred megabytes of disk to live on. Emulating one in a browser tab means fetching and running an operating system rather than an application.</p>\n<p>The disk is served in 256-kilobyte pieces, addressed by the hash of their contents, so nothing is downloaded twice and the empty two-thirds of a five-hundred-megabyte volume costs nothing at all. The emulator reports which pieces it wants first, and those are recorded so the next visitor's machine asks for them up front. It is still a slower start than a game that fits on a floppy, and it should be — you are booting a computer.</p>\n\n<h3>Where this era ends</h3>\n<p>Mac OS 8 was followed by Mac OS 9 in 1999, and then by nothing: Mac OS X was a different operating system wearing the family name, built on NeXTSTEP rather than on the lineage that began in 1984. Classic applications survived for a few more years inside an emulation layer, and then stopped running at all when Apple moved to Intel in 2006.</p>\n<p>That is the reason a site like this exists. Software from the System 6 and System 7 years has been unrunnable on Apple hardware for two decades, and the gap is now long enough that the machines themselves are museum pieces. An emulator in a browser is, for most people, the only remaining way to open these programs and find out what using them was actually like.</p>\n",
  "mac-os-9": "\n<p>Mac OS 9 shipped in October 1999 and was the end of a line that started in 1984. Apple knew it: Mac OS X was already in development, and 9 spent its last years as the Classic environment running inside its own successor, in a window, on machines that no longer needed it.</p>\n\n<h3>The last of its kind</h3>\n<p>It was also the best version of what it was. The Keychain arrived, and multiple user accounts, and Sherlock's internet search channels, and software update over the network. It was fast on the PowerPC G3 and G4 hardware of the time in a way no earlier classic system had been.</p>\n<p>What it never got was the thing it most needed. The classic Mac OS used cooperative multitasking: a program kept the processor until it chose to give it back, so one badly written application could freeze the entire machine. Every classic system had this flaw and none of them could fix it without starting over. Mac OS X, built on a Unix kernel, was the starting over.</p>\n\n<h3>Why this is the heaviest emulation here</h3>\n<p>Mac OS 9 needs a PowerPC processor, which means SheepShaver rather than the 68k emulators, and PowerPC emulation in a browser is substantially more work per instruction. Boots are slower and the frame rate is lower.</p>\n<p>So the rule for this era is simple: if a title will run under System 7, run it there. Use Mac OS 9 for software that genuinely requires it — later games, PowerPC-only applications, anything shipped after about 1998.</p>\n\n<h3>Where the line falls</h3>\n<p>Mac OS 9 is the last system this site emulates, and the boundary is not arbitrary. Mac OS X is a different operating system on a different foundation, and while it can be emulated — the <a href=\"https://infinitemac.org/\" rel=\"noopener\">Infinite Mac</a> project does it — the result takes minutes to boot and is slow once there. The <a href=\"/guide/\">what runs page</a> explains the line in full.</p>\n"
};

const ERA_META = {
  "system-6": {
    "title": "Black-and-White Mac Games and Software — System 6 Online",
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
    <h1 class="page-title">${esc(u.h1 || u.crumb)}</h1>
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
${sectionsHtml(u.sections)}${faqHtml(u)}${relatedHtml(u.related, pages)}
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
    <h1 class="page-title">${esc(s.h1 || s.crumb)}</h1>
    ${(s.sections[0] && !s.sections[0].h) ? s.sections[0].html : ""}
  </section>${sectionsHtml(s.sections, !!(s.sections[0] && !s.sections[0].h))}${faqHtml(s)}${relatedHtml(s.related, pages)}
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
  // A post may name the titles it is about in `cardSlugs`; otherwise its card
  // borrows the head of the catalogue.
  const cardList = post.cardSlugs ? pages.filter((q) => post.cardSlugs.includes(q.slug)) : pages;
  const card = ogCard(`blog-${post.slug}`, { kind: "collage", title: post.title, tag: "macemu blog", shots: shotsFor(cardList, 4) });
  const headHtml = head({
    title: post.title, description: post.description,
    path: `/blog/${post.slug}/`, kind: "content", ogImage: card,
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
  "image": "${card}",
  "mainEntityOfPage": "${SITE}/blog/${post.slug}/"
}
</script>`,
    ],
  });
  const body = `${header()}

<main class="prose">
  ${crumbs([{ name: "Home", href: "/" }, { name: "Blog", href: "/blog/" }, { name: post.crumb }])}
  <article class="card">
    <h1 class="page-title">${esc(post.title)}</h1>
    <p class="muted small">${esc(monthYear(post.date))} · ${esc(post.author)}</p>
    ${post.body.replace(/<(\/?)h3>/g, "<$1h2>")}
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
    <h1 class="page-title">Blog</h1>
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
    <h1 class="page-title">That page isn't here</h1>
    <p>The link may be old, or the title may not have gone live yet. <a href="/run/">The full list is here</a>, and <a href="/load-mac-file/">the loader</a> will run a file you already have.</p>
  </section>
${playNow.length ? `  <section class="card">
    <h2>Try one of these</h2>
    <ul class="poster-grid">
${playNow.map((q) => posterCard(q, "404")).join("\n")}
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
    ...CATEGORY_HUBS.filter((h) => pages.some(h.match)).map((h) => ({ loc: `/${h.slug}/`, lastmod: maxDate(pages.filter(h.match).map((p) => p.updated)) })),
    { loc: `/${EMBED_HUB.slug}/`, lastmod: maxDate(pages.map((p) => p.updated)) },
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
function securityTxt() {
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    "Contact: mailto:hello@macemu.com",
    `Expires: ${expires.toISOString().replace(/\.\d+Z$/, "Z")}`,
    "Preferred-Languages: en",
    `Canonical: ${SITE}/.well-known/security.txt`,
    `Policy: ${SITE}/takedown/`,
    "",
  ].join("\n");
}

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

NOT HOSTED. Do not tell anyone they can play these here. Each page explains the
title, says where an original can be found, and runs it in the same emulator
once the visitor supplies the file themselves.

${guides.map((p) => `- ${p.appName}${p.year ? ` (${p.year})` : ""} — ${SITE}/run/${p.slug}/`).join("\n")}

## Browse by kind

${CATEGORY_HUBS.filter((h) => pages.some(h.match)).map((h) => `- ${h.name} — ${SITE}/${h.slug}/ — ${h.description}`).join("\n")}
${ERA_ORDER.filter((e) => pages.some((p) => p.era === e)).map((e) => `- ${ERA_LABELS[e]} — ${SITE}/collection/${e}/`).join("\n")}

## Writing

${posts.map((q) => `- ${q.title} — ${SITE}/blog/${q.slug}/ — ${q.description}`).join("\n")}

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
for (const h of CATEGORY_HUBS) if (pages.some(h.match)) write(`${h.slug}/index.html`, categoryPage(h));
write(`${EMBED_HUB.slug}/index.html`, embedHubPage());
write("og/cards.json", JSON.stringify(OG_CARDS, null, 1) + "\n");
write("404.html", notFound());

write("sitemap.xml", sitemapXml([
  ...statics.map((s) => ({ loc: `/${s.slug}/`, lastmod: s.updated })),
  ...(posts.length ? [{ loc: "/blog/", lastmod: posts[0].date }] : []),
  ...posts.map((q) => ({ loc: `/blog/${q.slug}/`, lastmod: q.updated || q.date })),
]));
write("feed.xml", feedXml());
write("llms.txt", llmsTxt());

// RFC 9116. A rights holder or a researcher who wants to report something
// looks here before hunting for a contact page, and the takedown promise on
// this site — 48 hours — is only worth anything if the message arrives. The
// expiry is deliberately short: a stale security.txt is a signal the address
// behind it has stopped being watched, which is exactly what happened to the
// last one.
write(".well-known/security.txt", securityTxt());

console.log(`wrote ${written.length} files`);
console.log(`  ${pages.length} titles (${pages.filter(isPlayable).length} playable, ${pages.filter((p) => !isPlayable(p)).length} guides)`);
console.log(`  ${utils.length} utility pages, ${statics.length} written pages, ${posts.length} blog posts`);
