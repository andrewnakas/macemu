// The page driver: turns a <div id="mac-embed" data-…> into a running Macintosh.
//
// Everything the emulator needs is declared as data-* attributes by the page
// generator, so the HTML stays static and this file stays generic. The actual
// emulation lives in /mac/mac-runtime.js (a bundle of Mini vMac, Basilisk II
// and SheepShaver compiled to WebAssembly, from the Infinite Mac project),
// which is loaded lazily — nobody should pay a multi-megabyte download for
// reading an article.
//
// Two speeds:
//   isolated  SharedArrayBuffer available (the /play/ route sets COOP+COEP).
//             Full speed.
//   fallback  No SharedArrayBuffer. Slower, works anywhere, and is what an
//             embed on somebody else's site gets, because that page will not be
//             cross-origin isolated.
// The mode is decided by what the browser actually grants, not by what the page
// asked for — a page can request isolation and not get it.
(function (global) {
  "use strict";

  const RUNTIME_URL = "/mac/mac-runtime.js";
  const state = { runtime: null, loading: null, instances: [] };

  const T = (k, fallback) => (global.__I18N && global.__I18N[k]) || fallback;

  function loadRuntime() {
    if (state.runtime) return Promise.resolve(state.runtime);
    if (state.loading) return state.loading;
    state.loading = new Promise(function (resolve, reject) {
      if (global.MacEmulator) return resolve(global.MacEmulator);
      const s = document.createElement("script");
      s.src = RUNTIME_URL;
      s.async = true;
      s.onload = function () {
        if (!global.MacEmulator) return reject(new Error("runtime loaded but MacEmulator is not defined"));
        state.runtime = global.MacEmulator;
        resolve(global.MacEmulator);
      };
      s.onerror = function () { reject(new Error("could not load the emulator runtime")); };
      document.head.appendChild(s);
    });
    return state.loading;
  }

  // ── the poster / play overlay ────────────────────────────────────────────
  // The emulator does not start on page load. It is several megabytes and a
  // pinned CPU core, and most people who land on a title page from a search
  // result are reading, not playing. One click starts it.
  function buildStage(mount, cfg) {
    const stage = document.createElement("div");
    stage.className = "embed-stage";
    stage.style.aspectRatio = cfg.width + " / " + cfg.height;

    const overlay = document.createElement("div");
    overlay.className = "embed-overlay";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "embed-play";
    btn.innerHTML = "▶ " + T("play", "Play") + " " + escapeHtml(cfg.appName);
    const hint = document.createElement("p");
    hint.className = "embed-hint";
    hint.textContent = cfg.emulator
      ? cfg.emulator + " · " + cfg.width + "×" + cfg.height + " · nothing is installed or uploaded"
      : "nothing is installed or uploaded";
    overlay.appendChild(btn);
    overlay.appendChild(hint);

    const progress = document.createElement("div");
    progress.className = "dos-progress";
    progress.hidden = true;
    const fill = document.createElement("div");
    fill.className = "dos-progress-fill";
    progress.appendChild(fill);

    const screen = document.createElement("div");
    screen.className = "embed-console-wrap";

    stage.appendChild(screen);
    stage.appendChild(overlay);
    stage.appendChild(progress);
    mount.appendChild(stage);
    return { stage, overlay, btn, progress, fill, screen, hint };
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function readConfig(mount) {
    const d = mount.dataset;
    return {
      slug: d.slug || "",
      appName: d.appName || "this Macintosh",
      machine: d.machine || "Quadra-650",
      emulator: d.emulator || "",
      disk: d.disk || "",
      width: parseInt(d.width, 10) || 640,
      height: parseInt(d.height, 10) || 480,
      ramMB: d.ram ? parseInt(d.ram, 10) : undefined,
      mode: d.mode || "isolated",
    };
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function boot(mount, cfg, ui, extra) {
    ui.btn.disabled = true;
    ui.progress.hidden = false;
    ui.hint.textContent = "Starting…";

    return loadRuntime().then(function (MacEmulator) {
      const isolated = !!global.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
      if (!isolated && cfg.mode === "isolated") {
        // Asked for full speed and did not get it. Say so rather than letting
        // someone conclude the emulator is just slow.
        ui.hint.textContent = "Running in compatibility mode — slower. Open the full-speed page for better performance.";
      }
      const emu = MacEmulator.create({
        parent: ui.screen,
        machine: cfg.machine,
        disks: (extra && extra.disks) || (cfg.disk ? [cfg.disk] : []),
        screen: { width: cfg.width, height: cfg.height },
        ramMB: cfg.ramMB,
        onProgress: function (done, total) {
          if (!total) return;
          ui.fill.style.width = Math.round((done / total) * 100) + "%";
        },
        onLoaded: function () {
          ui.overlay.hidden = true;
          ui.progress.hidden = true;
          global.__macBooted = true;
          try { global.parent.postMessage({ type: "emulator_loaded" }, "*"); } catch (e) {}
          if (extra && typeof extra.onLoaded === "function") extra.onLoaded(emu);
        },
        onError: function (err) {
          ui.progress.hidden = true;
          ui.btn.disabled = false;
          ui.hint.textContent = "Could not start: " + (err && err.message ? err.message : String(err));
          if (global.console) console.error("[macemu]", err);
        },
      });
      state.instances.push(emu);

      // Stop burning a CPU core when the page is not being looked at. An
      // emulator left running in a background tab is the single rudest thing a
      // page like this can do to a laptop battery.
      const onVisibility = function () {
        if (document.hidden) { try { emu.pause(); } catch (e) {} }
        else { try { emu.unpause(); } catch (e) {} }
      };
      document.addEventListener("visibilitychange", onVisibility);

      if ("IntersectionObserver" in global) {
        const io = new IntersectionObserver(function (entries) {
          for (const en of entries) {
            try { en.isIntersecting ? emu.unpause() : emu.pause(); } catch (e) {}
          }
        }, { threshold: 0.05 });
        io.observe(ui.stage);
      }

      return emu;
    }).catch(function (err) {
      ui.progress.hidden = true;
      ui.btn.disabled = false;
      ui.hint.textContent = "Could not load the emulator: " + err.message;
      if (global.console) console.error("[macemu]", err);
      throw err;
    });
  }

  // ── public API, used by mac-loader.js ────────────────────────────────────
  const MacPlayer = {
    /** Mount an emulator into an element, returning a promise for the handle. */
    start: function (mount, overrides) {
      const cfg = Object.assign(readConfig(mount), overrides || {});
      const ui = buildStage(mount, cfg);
      return boot(mount, cfg, ui, overrides);
    },
    /** Every running instance on this page. */
    instances: function () { return state.instances.slice(); },
    loadRuntime: loadRuntime,
  };
  global.MacPlayer = MacPlayer;

  // ── auto-start on title pages ────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    const mount = document.getElementById("mac-embed");
    if (!mount) return;
    const cfg = readConfig(mount);
    const ui = buildStage(mount, cfg);

    // In an embed on someone else's site there is no article to read, so start
    // straight away rather than making the visitor click twice.
    const autostart = cfg.mode === "fallback" && global.self !== global.top;
    if (autostart) boot(mount, cfg, ui, null);
    ui.btn.addEventListener("click", function () { boot(mount, cfg, ui, null); });
  });
})(typeof window !== "undefined" ? window : globalThis);
