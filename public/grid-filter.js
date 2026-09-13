// Client-side filtering for the poster grids.
//
// Everything it needs rides on the <li> elements as data-cats and data-search
// attributes, put there by posterCard() in scripts/catalogue.mjs. No JSON blob
// of the catalogue is shipped alongside the markup, so the grid cannot get out
// of step with itself, and with JavaScript off the grid is simply fully
// populated — which is also what a crawler sees.
(function () {
  "use strict";
  const root = document.querySelector(".grid-filter");
  if (!root) return;
  const grid = root.parentElement.querySelector(".poster-grid");
  if (!grid) return;

  const items = Array.from(grid.querySelectorAll(".pc-item"));
  const search = root.querySelector(".gf-search");
  const chips = Array.from(root.querySelectorAll(".chip"));
  const empty = root.querySelector(".gf-empty");
  const clear = root.querySelector("#gf-clear");
  let cat = "";

  function apply() {
    const q = (search && search.value || "").trim().toLowerCase();
    let shown = 0;
    for (const li of items) {
      // The "your own file" card is pinned: a search that matches nothing is
      // exactly the moment when running your own copy is the right answer.
      const pinned = li.hasAttribute("data-pin");
      const cats = (li.getAttribute("data-cats") || "").split("|");
      const hay = li.getAttribute("data-search") || "";
      const catOk = !cat || pinned || cats.indexOf(cat) !== -1;
      const qOk = !q || hay.indexOf(q) !== -1;
      const show = catOk && qOk;
      li.hidden = !show;
      if (show && !pinned) shown++;
    }
    if (empty) empty.hidden = shown > 0;
  }

  if (search) search.addEventListener("input", apply);
  for (const chip of chips) {
    chip.addEventListener("click", function () {
      cat = chip.getAttribute("data-cat") || "";
      for (const c of chips) c.classList.toggle("is-on", c === chip);
      apply();
    });
  }
  if (clear) clear.addEventListener("click", function () {
    cat = "";
    if (search) search.value = "";
    for (const c of chips) c.classList.toggle("is-on", !c.getAttribute("data-cat"));
    apply();
  });
})();
