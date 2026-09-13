// Shared page chrome: <head>, header, nav, footer, and the small pieces every
// page type repeats. Kept apart from gen-pages.mjs so that file stays a set of
// page templates rather than a pile of string constants, and so the /run/,
// /play/, /embed/ and utility templates cannot drift into three different
// footers — which is exactly what happened on exebrowser before catalogue.mjs
// existed.
//
// Side-effect free: no reads, no writes. Import from anywhere.

import { SITE, esc } from "./catalogue.mjs";

export const BRAND = "macemu";
export const TAGLINE = "Classic Mac software, running in your browser tab";
export const CSS_V = 1;   // bump when public/style.css changes
export const JS_V = 1;    // bump when any public/*.js changes

// Google Analytics. Empty means no tag is emitted at all — better than a
// half-configured property quietly collecting nothing. Fill in after the
// property exists.
export const GA_ID = "";

// AdSense publisher. Deliberately empty: the site ships ad-free and applies
// once there is a body of real content, which is the mistake exebrowser made in
// reverse (loader on every page, zero units, three rejections). When this is
// filled in, ADS_OK below decides which pages may carry it.
export const ADSENSE_CLIENT = "";

// Ads are never allowed on a cross-origin-isolated page (COEP blocks the ad
// iframe outright — one of the three things that sank exebrowser's AdSense
// application) and never inside an embed someone put on their own site.
export const adsAllowed = (kind) => !!ADSENSE_CLIENT && kind === "content";

const gaHtml = () => (GA_ID ? `
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}" crossorigin="anonymous"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  // Headless automation (scripts/boot-test.mjs, crawlers driving Chrome) shows
  // up otherwise as 0%-engaged sessions with fifty events. Don't report it.
  if (!navigator.webdriver) gtag('config', '${GA_ID}');
</script>` : "");

const adsHtml = (kind) => (adsAllowed(kind) ? `
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}" crossorigin="anonymous"></script>` : "");

/**
 * The document head.
 * kind: "content" (indexed, may carry ads) | "play" (isolated, noindex, never
 * ads) | "embed" (framed elsewhere, noindex, never ads).
 */
export function head({
  title, description, path, kind = "content", ogTitle, ogDescription,
  ogImage, canonical, ld = [], keywords = "", noindex = false, extraHead = "",
}) {
  const url = canonical || `${SITE}${path}`;
  return `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />${keywords ? `
<meta name="keywords" content="${esc(keywords)}" />` : ""}
<link rel="canonical" href="${url}" />${noindex || kind !== "content" ? `
<meta name="robots" content="noindex, follow" />` : ""}
<meta property="og:type" content="${kind === "content" ? "article" : "website"}" />
<meta property="og:url" content="${url}" />
<meta property="og:title" content="${esc(ogTitle || title)}" />
<meta property="og:description" content="${esc(ogDescription || description)}" />
<meta property="og:image" content="${ogImage || `${SITE}/og.png`}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="alternate icon" href="/favicon.ico" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="theme-color" content="#d8d4cc" />
<link rel="alternate" type="application/rss+xml" title="${BRAND} — new titles and posts" href="/feed.xml" />
<link rel="stylesheet" href="/style.css?v=${CSS_V}" />${adsHtml(kind)}${gaHtml()}${extraHead}
${ld.filter(Boolean).join("\n")}`;
}

export const nav = () => `<nav class="site-nav" aria-label="Primary">
    <a href="/">Home</a>
    <a href="/run/">All titles</a>
    <a href="/load-mac-file/">Open your own file</a>
    <a href="/guide/">What runs</a>
    <a href="/blog/">Blog</a>
    <a href="/about/">About</a>
  </nav>`;

export const header = () => `<header>
  <div class="brand">
    <span class="logo" aria-hidden="true">☺</span>
    <h1>${BRAND}</h1>
  </div>
  <p class="tagline">${TAGLINE}</p>
  ${nav()}
</header>`;

export const footer = () => `<footer>
  <p>Emulation by WebAssembly builds of Mini vMac, Basilisk II and SheepShaver, vendored from <a href="https://infinitemac.org/" rel="noopener">Infinite Mac</a>. If you want a whole machine rather than one title, go there — and <a href="https://infinitemac.org/donate" rel="noopener">support it</a>.</p>
  <nav class="footer-nav" aria-label="Footer">
    <a href="/">Home</a>
    <a href="/run/">All titles</a>
    <a href="/load-mac-file/">Open your own file</a>
    <a href="/guide/">What runs</a>
    <a href="/blog/">Blog</a>
    <a href="/about/">About</a>
    <a href="/contact/">Contact</a>
    <a href="/takedown/">Takedown</a>
    <a href="/privacy/">Privacy</a>
    <a href="/terms/">Terms</a>
  </nav>
  <p class="muted small">${BRAND} is not affiliated with Apple Inc. Macintosh, Mac OS and System 7 are trademarks of Apple Inc.</p>
</footer>`;

/** A complete document. `body` is everything between <body> and the footer. */
export const page = ({ headHtml, bodyHtml, scripts = "", lang = "en" }) => `<!DOCTYPE html>
<html lang="${lang}">
<head>
${headHtml}
</head>
<body>
${bodyHtml}
${scripts}
</body>
</html>
`;

export const crumbs = (trail) =>
  `<nav class="breadcrumb" aria-label="Breadcrumb">${trail
    .map((t, i) => (i === trail.length - 1 ? esc(t.name) : `<a href="${t.href}">${esc(t.name)}</a>`))
    .join(" › ")}</nav>`;

export function breadcrumbLd(trail) {
  const items = trail
    .map((t, i) => `    { "@type": "ListItem", "position": ${i + 1}, "name": ${JSON.stringify(t.name)}, "item": "${SITE}${t.href}" }`)
    .join(",\n");
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
${items}
  ]
}
</script>`;
}

// Month name for the "Guide updated" line. Intl gets the ordering right and
// costs nothing.
export function monthYear(iso) {
  const [y, m] = String(iso).split("-").map(Number);
  if (!(m >= 1 && m <= 12)) return String(iso);
  try {
    return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(y, m - 1, 1)));
  } catch {
    return `${["January","February","March","April","May","June","July","August","September","October","November","December"][m - 1]} ${y}`;
  }
}
