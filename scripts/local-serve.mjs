#!/usr/bin/env node
// Serve the built site locally, with the disk chunks and ROMs coming straight
// off the filesystem instead of R2.
//
//   node scripts/local-serve.mjs --port 8791
//
// Why this exists: boot-test.mjs talks to a URL, and until now the only URL
// that could serve a title was the deployed one. That made "does this disk
// boot?" cost a full generate → gate → deploy → R2 sync, which is minutes per
// title and uploads chunks for images that may turn out to be broken. Adding
// sixty-odd titles that way is not practical.
//
// What it must reproduce from production, or the emulator will not start:
//   * /Disk/<hash>.chunk out of Images/build, /rom/<name> out of Images/rom.
//     These are the R2-backed Pages Functions.
//   * the isolation headers. /play/ is cross-origin isolated by
//     functions/play/_middleware.js and the root middleware isolates everything
//     except /embed/; /mac/* needs COEP of its own for the worker script, and
//     the service worker needs Service-Worker-Allowed so it can claim '/'.
//   * /embed/ deliberately gets NONE of that.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = resolve(ROOT, "public");
const BUILD = resolve(ROOT, "Images", "build");
const ROMS = resolve(ROOT, "Images", "rom");

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(flag("port", 8791));

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json", ".data": "application/octet-stream",
};

// Mirrors functions/_middleware.js + functions/play/_middleware.js + _headers.
// Everything but /embed/ is isolated; /mac/* and the served binaries also carry
// CORP, because a require-corp document refuses a subresource without it.
function isolation(path) {
  const h = {};
  if (path.startsWith("/embed/")) return h;
  h["Cross-Origin-Opener-Policy"] = "same-origin";
  h["Cross-Origin-Embedder-Policy"] = "require-corp";
  if (path.startsWith("/play/") || path.startsWith("/mac/") ||
      path.startsWith("/Disk/") || path.startsWith("/rom/")) {
    h["Cross-Origin-Resource-Policy"] = "same-origin";
  }
  if (path === "/mac/emulator-service-worker.js") h["Service-Worker-Allowed"] = "/";
  return h;
}

// Path traversal guard: the resolved file must still sit under its base.
const under = (base, p) => {
  const full = resolve(base, "." + normalize(p));
  return full.startsWith(base + "/") || full === base ? full : null;
};

function send(res, file, path, extra = {}) {
  const headers = { "Content-Type": TYPES[extname(file)] || "application/octet-stream",
                    "Content-Length": statSync(file).size, ...isolation(path), ...extra };
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);

  if (path.startsWith("/Disk/")) {
    const f = under(BUILD, path.slice("/Disk".length));
    if (f && /\.chunk$/.test(f) && existsSync(f)) return send(res, f, path);
    res.writeHead(404); return res.end("no chunk");
  }
  if (path.startsWith("/rom/")) {
    const f = under(ROMS, path.slice("/rom".length));
    if (f && existsSync(f)) return send(res, f, path);
    res.writeHead(404); return res.end("no rom");
  }

  let f = under(PUB, path);
  if (!f) { res.writeHead(400); return res.end("bad path"); }
  if (existsSync(f) && statSync(f).isDirectory()) f = resolve(f, "index.html");
  else if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
  if (!existsSync(f)) {
    const notFound = resolve(PUB, "404.html");
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...isolation(path) });
    return existsSync(notFound) ? createReadStream(notFound).pipe(res) : res.end("not found");
  }
  send(res, f, path);
}).listen(PORT, () => console.log(`serving ${PUB} (chunks from Images/build) on http://localhost:${PORT}`));
