// Serves a Macintosh ROM out of R2.
//
// ROMs are Apple's, so they are not in this repo and never will be — they live
// in the R2 bucket, uploaded by scripts/sync-disks.sh. Same-origin for the same
// COEP reason as the disk chunks.
//
// Not immutable-cached as aggressively as chunks: a ROM name is a machine name,
// not a content hash, so a correction has to be able to take effect.
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,60}\.rom$/;

async function serve(context) {
  const { params, env, request } = context;
  const name = String(params.file || "");
  if (!ALLOWED.test(name)) return new Response("bad rom name", { status: 400 });

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  if (!env.DISK_BUCKET) return new Response("no bucket binding", { status: 503 });
  const object = await env.DISK_BUCKET.get(`rom/${name}`);
  if (!object) return new Response("not found", { status: 404 });

  const res = new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=604800",
      "Cross-Origin-Resource-Policy": "same-origin",
      "ETag": object.httpEtag,
    },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// GET and HEAD both, deliberately. A Pages Function that exports only
// onRequestGet returns 404 for HEAD, because the request falls through to the
// static asset handler and finds nothing — which makes the route look broken to
// crawlers, to link checkers, and to anything that probes with HEAD before
// fetching. Cloudflare strips the body from a HEAD response itself.
export const onRequestGet = serve;
export const onRequestHead = serve;
