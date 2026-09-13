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
export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  const response = await context.next();

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
