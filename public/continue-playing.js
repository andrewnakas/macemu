// "Continue playing" — the other half of the save-resume feature.
//
// Titles persist their disk to the origin private file system, so a visitor's
// progress survives closing the tab. Until this existed nothing said so: you
// had to remember what you had been playing and navigate back to it yourself,
// which is precisely the friction that turns a return visit into no visit.
//
// The registry is written by mac-player.js on a successful persistent boot and
// holds only slug, name and timestamp. Everything else — the link, the
// screenshot — is derived, so this cannot drift out of step with the
// catalogue: a title that has been removed simply 404s its thumbnail and is
// dropped on the next render.
(function () {
  "use strict";
  var KEY = "macemu:recent";
  var mount = document.getElementById("continue-playing");
  if (!mount) return;

  var list;
  try {
    list = JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch (e) {
    return;                       // storage disabled or unreadable: show nothing
  }
  if (!Array.isArray(list) || !list.length) return;

  // Keep it to a single row's worth. Someone who has played thirty titles does
  // not want all thirty here; they want the one they were in the middle of.
  var shown = list.slice(0, 6).filter(function (r) { return r && r.slug && r.name; });
  if (!shown.length) return;

  var when = function (ts) {
    var mins = Math.round((Date.now() - ts) / 60000);
    if (!isFinite(mins) || mins < 0) return "";
    if (mins < 60) return "a few minutes ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs === 1 ? "an hour ago" : hrs + " hours ago";
    var days = Math.round(hrs / 24);
    if (days === 1) return "yesterday";
    if (days < 30) return days + " days ago";
    return "a while ago";
  };

  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  // Mirror posterCard() in scripts/catalogue.mjs exactly. Inventing a lighter
  // markup here was the first attempt and produced unstyled cards: the grid's
  // CSS hangs off .pc-item / .poster-card / .pc-shot / .pc-body, not on the
  // element names. data-cats and data-search are omitted deliberately — this
  // row is never filtered.
  mount.innerHTML =
    '<h2>Continue playing</h2>' +
    '<p class="muted small">Where you left off. Progress is saved in this browser.</p>' +
    '<ul class="poster-grid">' +
    shown.map(function (r) {
      var ago = when(r.at);
      return '<li class="pc-item"><a class="poster-card" href="/run/' + esc(r.slug) + '/" data-rec="continue" data-slug="' + esc(r.slug) + '">' +
        '<img class="pc-shot" src="/run/' + esc(r.slug) + '/screenshot.png" width="320" height="240" ' +
        'loading="lazy" alt="' + esc(r.name) + ' running in the browser" />' +
        '<span class="pc-body"><span class="pc-title">' + esc(r.name) + '</span>' +
        '<span class="pc-play">▶ ' + (ago ? esc("Resume · " + ago) : "Resume") + '</span></span>' +
        '</a></li>';
    }).join("") +
    "</ul>";
  mount.hidden = false;
})();
