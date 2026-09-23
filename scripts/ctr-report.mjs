#!/usr/bin/env node
// Which pages are shown in search but not clicked: the rewrite list for
// <title> and meta description.
//
//   node scripts/ctr-report.mjs <Pages.csv | export-folder> [--min 50]
//
// Input is Search Console's own export (Performance → Export → CSV). Point it
// at the unzipped folder or straight at Pages.csv. Bing Webmaster's page
// export works too if its columns are named Page/Clicks/Impressions/Position.
//
// A page is flagged when it has at least --min impressions and its CTR is
// under 60% of what its average position usually earns. The curve below is a
// rough industry average, not a law — it only has to rank pages against each
// other, and a page at position 30 is left out entirely because no title
// rewrite fixes that; the content has to rank first.
//
// Each flagged page is printed with the title and description it currently
// ships, read from scripts/app-pages.json and scripts/hub-pages.json, so the
// rewrite can start from what searchers actually saw.
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const minAt = args.indexOf("--min");
const MIN = minAt >= 0 ? Number(args[minAt + 1]) : 50;
let input = args.find((a, i) => !a.startsWith("--") && i !== minAt + 1);
if (!input) {
  console.error("usage: node scripts/ctr-report.mjs <Pages.csv | export-folder> [--min 50]");
  process.exit(2);
}
if (existsSync(input) && statSync(input).isDirectory()) input = join(input, "Pages.csv");
if (!existsSync(input)) { console.error(`no such file: ${input}`); process.exit(2); }

// Expected CTR by rounded position, positions 1–10.
const CURVE = [0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02];
const expected = (pos) => (pos > 15 ? null : CURVE[Math.min(Math.round(pos), 10) - 1] ?? 0.01);

// A minimal CSV reader: quoted fields, doubled quotes, commas inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const [header, ...body] = parseCsv(readFileSync(input, "utf8").replace(/^﻿/, ""));
const col = (re) => header.findIndex((h) => re.test(h));
const iPage = col(/page|url/i), iClicks = col(/^clicks$/i), iImpr = col(/impressions/i), iPos = col(/position/i);
if ([iPage, iClicks, iImpr, iPos].some((i) => i < 0)) {
  console.error(`unrecognised columns: ${header.join(", ")}`);
  process.exit(2);
}

const ROOT = process.cwd();
const titles = JSON.parse(readFileSync(resolve(ROOT, "scripts", "app-pages.json"), "utf8"));
const hubs = JSON.parse(readFileSync(resolve(ROOT, "scripts", "hub-pages.json"), "utf8"));
function snippetFor(url) {
  const path = new URL(url, "https://macemu.com").pathname;
  const run = path.match(/^\/run\/([^/]+)\/$/);
  if (run) {
    const p = titles.find((t) => t.slug === run[1]);
    if (p) return { file: "app-pages.json", title: p.title, description: p.description };
  }
  const h = hubs.find((x) => path === `/${x.slug}/`);
  if (h) return { file: "hub-pages.json", title: h.title, description: h.description };
  return null;
}

const rows = body.map((r) => {
  const clicks = Number(r[iClicks]) || 0, impressions = Number(r[iImpr]) || 0;
  const position = Number(String(r[iPos]).replace(",", ".")) || 0;
  return { page: r[iPage], clicks, impressions, position, ctr: impressions ? clicks / impressions : 0 };
});

const flagged = rows
  .filter((r) => r.impressions >= MIN && expected(r.position) !== null)
  .map((r) => ({ ...r, exp: expected(r.position) }))
  .filter((r) => r.ctr < r.exp * 0.6)
  // Most clicks lost first: the gap between what the position should earn
  // and what it did, in clicks.
  .map((r) => ({ ...r, lost: Math.round(r.impressions * (r.exp - r.ctr)) }))
  .sort((a, b) => b.lost - a.lost);

const pct = (x) => (x * 100).toFixed(1) + "%";
console.log(`${rows.length} pages read; ${flagged.length} under-clicked at ≥${MIN} impressions\n`);
for (const r of flagged) {
  console.log(`${r.page}`);
  console.log(`  ${r.impressions} impr · pos ${r.position.toFixed(1)} · CTR ${pct(r.ctr)} vs ~${pct(r.exp)} expected · ~${r.lost} clicks lost`);
  const s = snippetFor(r.page);
  if (s) {
    console.log(`  title (${s.file}): ${s.title}`);
    console.log(`  desc:  ${s.description}`);
  }
  console.log("");
}
const deep = rows.filter((r) => r.impressions >= MIN && r.position > 15).length;
if (deep) console.log(`${deep} more page(s) with ≥${MIN} impressions sit below position 15 — a ranking problem, not a snippet one.`);
