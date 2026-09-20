import { chromium } from "playwright";
const slug = process.argv[2], secs = Number(process.argv[3] || 90);
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ channel: "chrome", headless: true }); }
const ctx = await browser.newContext();
const page = await ctx.newPage();
const seen = [];
page.on("console", m => seen.push(`[${m.type()}] ${m.text()}`.slice(0, 260)));
page.on("pageerror", e => seen.push(`[pageerror] ${e.message}`.slice(0, 260)));
page.on("requestfailed", r => seen.push(`[reqfail] ${r.url().slice(-70)} ${r.failure()?.errorText}`));
page.on("response", r => { if (r.status() >= 400) seen.push(`[http ${r.status()}] ${r.url().slice(-70)}`); });
await page.addInitScript(() => Object.defineProperty(document, "hidden", { get: () => false }));
await page.goto(`https://macemu.pages.dev/play/${slug}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(secs * 1000);
console.log(seen.join("\n") || "(no console output)");
await browser.close();
