// Cross-origin isolation for the whole site, except embeds.
//
// WHY THIS IS HERE, AND WHEN TO TURN IT OFF
//
// The emulator is dramatically faster and far more reliable when it can use
// SharedArrayBuffer, which a browser only grants to a cross-origin isolated
// document: COOP same-origin plus COEP require-corp on the TOP-LEVEL page.
// Without it the runtime falls back to a service-worker-mediated path that is
// several times slower and, on a content page, was observed locking up the
// renderer outright — a frozen tab is worse than a slow one.
//
// The cost of isolation is that COEP blocks every cross-origin iframe that has
// not opted in, which includes every advertising iframe. This site carries no
// advertising and is not applying for any until there is a real body of
// content, so today that costs nothing and buys a working emulator everywhere.
//
// TO REVERSE IT: set ISOLATE_CONTENT = false in scripts/site.mjs, delete this
// file, and re-run the generator. /run/ pages go back to a screenshot with a
// Launch button pointing at /play/, which stays isolated via
// functions/play/_middleware.js. check-consistency.mjs enforces whichever mode
// the flag says, so the two cannot drift apart.
//
// /embed/ is always excluded: an embed runs inside somebody else's page, which
// will not be isolated, and it has to stay framable by anyone.
//
// ONE HOST FOR SEARCH ENGINES
//
// www.macemu.com served a full copy of the site with a 200, and on 2026-10-01
// Bing's index held three pages, all under www. The canonical tags already
// point at the apex, but a 301 is the signal every crawler obeys. The
// macemu.pages.dev host is NOT redirected: deploy.sh, smoke-test, sync-disks,
// boot-test and author-disk all talk to it directly. It gets a noindex header
// instead, so it can never compete with the real domain.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === "www.macemu.com") {
    url.hostname = "macemu.com";
    return Response.redirect(url.toString(), 301);
  }
  const path = url.pathname;
  const response = await context.next();

  if (url.hostname.endsWith(".pages.dev")) {
    const h = new Headers(response.headers);
    h.set("X-Robots-Tag", "noindex");
    if (!path.startsWith("/embed/")) {
      h.set("Cross-Origin-Opener-Policy", "same-origin");
      h.set("Cross-Origin-Embedder-Policy", "require-corp");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
  }

  // Root middleware wraps the inner ones, so its headers would otherwise
  // overwrite what functions/embed/_middleware.js just set. Leave embeds alone.
  if (path.startsWith("/embed/")) return response;

  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
