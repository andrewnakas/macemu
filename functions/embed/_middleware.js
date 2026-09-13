// Headers for embeds running on other people's sites.
//
// The opposite of /play/: an embed must be framable by anyone, so
// X-Frame-Options has to go and the frame-ancestors directive has to be open.
// It also must NOT be cross-origin isolated, because the host page almost
// certainly is not — the emulator falls back to its slower non-SharedArrayBuffer
// mode, which is the honest trade for working anywhere.
//
// Embeds on other sites are the growth lever this whole site is built around:
// each one is a referring domain and each play lands on our own origin.
export async function onRequest(context) {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.delete("X-Frame-Options");
  headers.set("Cross-Origin-Opener-Policy", "unsafe-none");
  headers.delete("Cross-Origin-Embedder-Policy");
  headers.set("Content-Security-Policy", "frame-ancestors *");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
