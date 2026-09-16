// Ping IndexNow so Bing, DuckDuckGo and Yandex pick up changes in hours rather
// than weeks. Bing was exebrowser's largest search channel by a factor of two, so
// this is the highest-leverage crawl signal available — Google ignores IndexNow
// and still has to be handled through Search Console.
//
//   node scripts/indexnow.mjs              # submit every URL in sitemap.xml
//   node scripts/indexnow.mjs /run/marathon/   # submit specific paths
//
// Run it after a deploy has gone live: the endpoint fetches the URLs to verify
// them, so submitting before the content is up wastes the ping.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const SITE = "https://macemu.com";
const HOST = "macemu.com";
const KEY = "86d9c9859feb9902285395e2f965627b";

const args = process.argv.slice(2);
const urls = args.length
  ? args.map((p) => (p.startsWith("http") ? p : SITE + (p.startsWith("/") ? p : "/" + p)))
  : [...readFileSync(resolve(ROOT, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

if (!urls.length) {
  console.error("nothing to submit");
  process.exit(1);
}

// The key file has to be reachable, or the endpoint rejects the whole batch.
const keyUrl = `${SITE}/${KEY}.txt`;
let keyRes;
try {
  keyRes = await fetch(keyUrl);
} catch (e) {
  // Almost always the same thing: the domain does not resolve yet. Say that,
  // rather than throwing a connect timeout stack at whoever ran the deploy.
  console.error(`Could not reach ${keyUrl}`);
  console.error(`  ${e.cause?.code ?? e.message}`);
  console.error("");
  console.error("IndexNow submits URLs to Bing by having it fetch them back, so it");
  console.error(`cannot run until ${HOST} resolves and serves this site. Nothing else`);
  console.error("is affected — the deploy itself is fine.");
  process.exit(0);   // not a deploy failure
}
const keyBody = (await keyRes.text()).trim();
if (!keyRes.ok || keyBody !== KEY) {
  console.error(`key file check failed: ${keyUrl} → ${keyRes.status} "${keyBody.slice(0, 40)}"`);
  console.error("deploy the key file before submitting.");
  process.exit(1);
}
console.log(`key file OK (${keyUrl})`);

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: keyUrl, urlList: urls }),
});

// 200 and 202 both mean accepted; 202 just means the key is still being verified.
console.log(`submitted ${urls.length} URLs → ${res.status} ${res.statusText}`);
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}
