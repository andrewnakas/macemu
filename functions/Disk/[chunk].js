// Serves one 256 KB disk chunk out of R2, same-origin.
//
// Same-origin is the whole point. The /play/ routes are cross-origin isolated
// (COOP + COEP: require-corp), and under require-corp a cross-origin subresource
// must carry Cross-Origin-Resource-Policy, which an R2 public bucket does not
// set. Rather than fight that, the chunks are fetched from this origin and the
// question never arises.
//
// Chunk names are content hashes, so a name always means the same bytes. That
// makes them immutable for a year and lets the edge cache do nearly all the
// work: a title that has been played once is served almost entirely from cache.
async function serve(context) {
  const { params, env, request } = context;
  const name = String(params.chunk || "");

  // Content-addressed names only. Anything else is either a mistake or someone
  // probing for a path traversal.
  if (!/^[0-9a-f]{8,64}\.chunk$/.test(name)) {
    return new Response("bad chunk name", { status: 400 });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  if (!env.DISK_BUCKET) return new Response("no bucket binding", { status: 503 });
  const object = await env.DISK_BUCKET.get(name);
  if (!object) return new Response("not found", { status: 404 });

  const res = new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
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
