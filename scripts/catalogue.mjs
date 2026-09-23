// Pure helpers shared by gen-app-pages.mjs and gen-home-grid.mjs.
//
// Lifted from exebrowser.com, where the same file keeps the homepage and the
// /run/ hub from disagreeing about what the catalogue is. The Mac-specific
// changes are the playable predicate (a boot disk, not an app zip), the
// bring-your-own card (a .sit, not an .exe) and the chip vocabulary.
//
// These two generators had drifted into keeping seven private copies of the
// same definitions — esc, isPlayable, the screenshot filename rule, the NEW
// window, the rank comparator, the poster card, and the filter-chip order,
// the last of which carried a "must match" comment because nothing enforced
// it. Every copy is a chance for the homepage and the hub to disagree about
// what the catalogue is. They live here now, defined once.
//
// Side-effect free on purpose: no file reads, no writes, no process.cwd().
// Import it from anywhere without wondering what it does on the way in.

export const SITE = "https://macemu.com";

// ── Escaping ──────────────────────────────────────────────────────────────
// HTML text/attribute escaping. Note this is NOT safe for XML — see xmlEsc.
export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// XML escaping for sitemap.xml and feed.xml. Differs from esc() by also
// escaping the apostrophe, which matters inside single-quoted XML attributes.
// Never run esc() on XML and never run this on HTML — mixing them is how you
// get &amp;amp; in a feed reader.
export const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

// Undo HTML escaping. Needed when scraping <title>/description back out of
// generated HTML: those strings are already escaped on disk, so re-escaping
// them for XML would double-encode ("&amp;" → "&amp;amp;").
export const unesc = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last, or it would re-decode the entities above

// ── Catalogue predicates ──────────────────────────────────────────────────
// A page may only promise instant play when a boot disk actually exists for it.
// `bootDisk` names a manifest in public/mac/disks/; check-consistency.mjs
// verifies the manifest and every chunk it lists are really there, so this
// predicate cannot drift into a promise the site can't keep. (On exebrowser the
// equivalent `hostable` flag was informational and lied more than once — hence
// deriving the signal from the payload instead of from a boolean.)
export const isPlayable = (p) => !!(p.bootDisk || p.iframeUrl);

// How a title came to be here. "shareware" is its own case and a large one:
// shareware licences were written to encourage copying, and most of them
// explicitly permit non-profit redistribution of the unregistered version. That
// makes a sizeable chunk of the 1985-2000 Macintosh catalogue hostable on the
// author's own stated terms — provided nothing is modified, which means leaving
// the registration nag exactly where it is.
export const PROVENANCE = ["clean", "shareware", "grey", "byo-only"];

// Titles still sold today are never hosted, whatever else the catalogue says.
// A `sold` URL turns the page into a bring-your-own-copy guide, and
// check-consistency.mjs fails the build if one ever gains a bootDisk.
export const isSold = (p) => !!p.sold;

// Which emulator a title boots under, derived from the machine so the JSON
// can't state a combination that doesn't exist.
// Machine → emulator, and the screen the machine actually has. These mirror
// vendor/infinite-mac/src/defs/machines.ts exactly; getting one wrong means the
// page advertises an emulator the runtime will not use. Mini vMac covers more
// than the compact Macs — the Mac II and IIx run under it too, with a fixed
// 640×480 screen — and only the Quadra and the Power Macs need the heavier
// emulators.
export const EMULATORS = {
  "Mac-Plus": "Mini vMac",
  "Mac-SE": "Mini vMac",
  "Mac-II": "Mini vMac",
  "Mac-IIx": "Mini vMac",
  "Mac-IIfx": "Basilisk II",
  "Quadra-650": "Basilisk II",
  "Power-Macintosh-9500": "SheepShaver",
  "Power-Macintosh-G3": "SheepShaver",
};

// Machines whose screen size is a property of the hardware, not a setting. Ask
// Mini vMac for 800×600 and you get 512×342 anyway, so a page that claims
// otherwise is simply wrong.
export const FIXED_SCREENS = {
  "Mac-Plus": { w: 512, h: 342 },
  "Mac-SE": { w: 512, h: 342 },
  "Mac-II": { w: 640, h: 480 },
  "Mac-IIx": { w: 640, h: 480 },
};
export const emulatorFor = (p) => p.emulator || EMULATORS[p.machine] || null;

// A captured screenshot of the app running in-browser. `screenshot: true` uses
// the conventional /run/<slug>/screenshot.png; a string overrides the filename.
// Returns null when no screenshot is set (pages fall back to the site og.png).
export const screenshotFile = (p) =>
  p.screenshot ? (typeof p.screenshot === "string" ? p.screenshot : "screenshot.png") : null;

// A game counts as "new" for two weeks after its addedDate, which drives the
// badge on the hub and homepage. Dates are plain YYYY-MM-DD in app-pages.json.
export const NEW_DAYS = 14;
export function isNew(p) {
  if (!p.addedDate) return false;
  const added = Date.parse(p.addedDate + "T00:00:00Z");
  if (Number.isNaN(added)) return false;
  return (Date.now() - added) / 86400000 < NEW_DAYS;
}

// Hand-assigned running order (lower = earlier); the two derived keys only
// break ties among unranked titles. Ranking has to be explicit because the old
// screenshot/new-badge pair silently decayed into raw JSON order once every
// addedDate aged past the 14-day NEW window.
export const rankOf = (p) => (typeof p.rank === "number" ? p.rank : Infinity);
export const sortPlayable = (pages) =>
  pages.filter(isPlayable).sort((a, b) => {
    const r = rankOf(a) - rankOf(b);
    if (r) return r;
    const s = (screenshotFile(b) ? 1 : 0) - (screenshotFile(a) ? 1 : 0);
    if (s) return s;
    return (isNew(b) ? 1 : 0) - (isNew(a) ? 1 : 0);
  });

// Screenshot alt text. A hand-written `shotAlt` wins; otherwise say what the
// picture actually is — which title, whose, when, on what — rather than the
// same "X running in the browser" on a hundred images.
const MACHINE_NAME = { "Mac-Plus": "Macintosh Plus", "Mac-SE": "Macintosh SE", "Mac-II": "Macintosh II",
  "Mac-IIx": "Macintosh IIx", "Mac-IIfx": "Macintosh IIfx", "Quadra-650": "Quadra 650",
  "Power-Macintosh-G3": "Power Macintosh G3", "Power-Macintosh-9500": "Power Macintosh 9500" };
export function shotAlt(p) {
  if (p.shotAlt) return p.shotAlt;
  const who = [p.author, p.year].filter(Boolean).join(", ");
  const on = MACHINE_NAME[p.machine] || "a Macintosh";
  return `Screenshot of ${p.appName}${who ? ` (${who})` : ""} running on an emulated ${on}`;
}

// ── Poster card ───────────────────────────────────────────────────────────
export const NEW_BADGE = ` <span class="badge-new">NEW</span>`;
// Titles whose engine *and* assets are freely licensed — no shareware episode,
// no bring-your-own-copy. Worth calling out: it's the difference between "try
// the first three levels" and "this is the whole game, free".
export const FREE_BADGE = ` <span class="badge-free" title="Free and complete — no shareware episode, nothing held back">FREE</span>`;

// Poster-style card for the visual grids: real screenshot when we have one,
// otherwise a lettered placeholder tile so the grid never looks broken.
// `rec` names the list a card sits in ("also", "hub", …). It rides on the link
// as data-rec so one delegated click listener (scripts/site.mjs) can report
// which recommendations people actually follow.
export function posterCard(p, rec) {
  const shot = screenshotFile(p);
  const art = shot
    ? `<img class="pc-shot" src="/run/${p.slug}/${shot}" width="320" height="240" loading="lazy" alt="${esc(shotAlt(p))}" />`
    : `<span class="pc-shot pc-placeholder" aria-hidden="true">${esc((p.appName || "?").trim().charAt(0))}</span>`;
  // Categories and a search haystack ride on the <li> so filtering is a pure
  // client-side attribute match — no data duplicated into a JS blob, and the
  // grid stays fully populated for crawlers with JS off.
  const cats = ((p.categories || []).concat(p.fullyFree ? ["Free & complete"] : [])).join("|");
  const hay = [p.appName, p.author, ...(p.genre || []), ...(p.categories || []),
    p.fullyFree ? "free complete open source freeware" : ""]
    .filter(Boolean).join(" ").toLowerCase();
  return `        <li class="pc-item" data-cats="${esc(cats)}" data-search="${esc(hay)}"><a class="poster-card" href="/run/${p.slug}/"${rec ? ` data-rec="${esc(rec)}" data-slug="${esc(p.slug)}"` : ""}>
          ${art}
          <span class="pc-body"><span class="pc-title">${esc(p.appName)}${isNew(p) ? NEW_BADGE : ""}${p.fullyFree ? FREE_BADGE : ""}</span><span class="pc-play">▶ Play free</span></span>
        </a></li>`;
}

// The shelf's one non-title: the visitor's own EXE. Running your own program
// is the premise of the whole site, and until now the only way to it was a
// section three screens below the grid — so the shelf, which is what people
// actually scan, never mentioned it. It's pinned (data-pin) so the category
// filter leaves it alone; a search that finds nothing is exactly when it is
// the right answer. Not in app-pages.json on purpose: it is not a catalogue
// entry, and putting it there would inflate every count, the ItemList schema
// and the /run/ hub with a page that hosts no software.
export const byoCard = () =>
  `        <li class="pc-item pc-byo" data-pin="1" data-search="load your own file upload sit hqx img dsk toast open mac disk image run my own program"><a class="poster-card" href="/load-mac-file/">
          <span class="pc-shot" aria-hidden="true">+</span>
          <span class="pc-body"><span class="pc-title">Your own Mac file</span><span class="pc-play">▶ Open a .sit, .hqx or disk image</span></span>
        </a></li>`;

// ── Categories ────────────────────────────────────────────────────────────
// Display order for the filter chips, on the homepage and the /run/ hub alike.
// "Free & complete" is derived from `fullyFree`, not written in categories[].
export const CATEGORY_ORDER = [
  "Free & complete", "Classroom classics", "Shooters", "Action",
  "Puzzle & strategy", "Creative tools", "Apps & utilities",
];

// Eras drive the /collection/ pages and the "what machine was this" line. The
// order is chronological because that is the only order a visitor expects.
export const ERA_ORDER = ["system-6", "system-7", "mac-os-8", "mac-os-9"];
export const ERA_LABELS = {
  "system-6": "System 6",
  "system-7": "System 7",
  "mac-os-8": "Mac OS 8",
  "mac-os-9": "Mac OS 9",
};

// Count titles per chip, including the derived "Free & complete".
export function categoryCounts(pages) {
  const counts = new Map();
  for (const p of pages) {
    // A set, not a running total: "Free & complete" is DERIVED from fullyFree,
    // and a title that also listed it in categories[] was counted twice — so a
    // grid of one title displayed "All 1" beside "Free & complete 2".
    const cats = new Set(p.categories || []);
    if (p.fullyFree) cats.add("Free & complete");
    for (const c of cats) counts.set(c, (counts.get(c) || 0) + 1);
  }
  return counts;
}

// The chip <button>s, in CATEGORY_ORDER, skipping categories with no titles.
export function categoryChips(counts) {
  return CATEGORY_ORDER.filter((c) => counts.has(c))
    .map((c) => `<button type="button" class="chip" data-cat="${esc(c)}">${esc(c)} <span class="chip-n">${counts.get(c)}</span></button>`)
    .join("\n        ");
}

// ── Dates ─────────────────────────────────────────────────────────────────
// Newest of a set of YYYY-MM-DD strings; ignores empties. Plain string compare
// is correct for ISO dates and avoids timezone surprises.
export const maxDate = (dates) =>
  dates.filter(Boolean).map(String).sort().pop() || null;

// RFC-822 date for RSS <pubDate>, e.g. "Mon, 17 Aug 2026 00:00:00 +0000".
// Fixed English tables rather than Intl: RSS requires English day/month names
// regardless of the build machine's locale.
const RFC_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function toRfc822(iso) {
  const d = new Date(String(iso) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new Error(`toRfc822: unparseable date ${iso}`);
  const pad = (n) => String(n).padStart(2, "0");
  return `${RFC_DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${RFC_MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} 00:00:00 +0000`;
}

// ── Structured data ───────────────────────────────────────────────────────
// For JSON-LD string values: strip tags, collapse whitespace, JSON-encode.
export const jsonText = (s) =>
  JSON.stringify(String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

// An ItemList describing a catalogue listing. URL-form ListItems rather than
// nested VideoGame objects: each game's own /run/ page already carries the full
// VideoGame schema, so repeating it here would be duplication, not detail.
export function itemListLd(items, { name, url }) {
  const els = items.map((p, i) => `      { "@type": "ListItem", "position": ${i + 1}, ` +
    `"url": "${SITE}/run/${p.slug}/", "name": ${jsonText(p.appName || p.crumb)} }`).join(",\n");
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": ${jsonText(name)},
  "url": "${url}",
  "numberOfItems": ${items.length},
  "itemListElement": [
${els}
  ]
}
</script>`;
}
