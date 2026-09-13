// Cross-origin isolation for the full-speed player.
//
// The emulator is far faster when it can use SharedArrayBuffer, and a browser
// only hands that out to a document that is cross-origin isolated: COOP
// same-origin plus COEP require-corp. Both have to be on the TOP-LEVEL
// document, which is why the fast player lives on its own route instead of
// inside the article page.
//
// The cost of that isolation is that COEP blocks any cross-origin iframe that
// does not opt in — including every ad iframe. On exebrowser a site-wide COEP
// header meant an AdSense reviewer loaded the site and saw no ads at all, which
// contributed to three rejections. So: isolation here, never on /run/.
//
// _headers can only add headers, never replace one the catch-all already set,
// and a page with two conflicting COOP values behaves as neither. Middleware
// replaces, so this is the only reliable place to do it.
export async function onRequest(context) {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
