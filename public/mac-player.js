// The page driver: turns a <div id="mac-embed" data-…> into a running Macintosh.
//
// Everything the emulator needs is declared as data-* attributes by the page
// generator, so the HTML stays static and this file stays generic. The actual
// emulation lives in /mac/mac-runtime.js — Mini vMac, Basilisk II and
// SheepShaver compiled to WebAssembly, from the Infinite Mac project — which is
// loaded lazily. Nobody should pay an eight-megabyte download for reading an
// article about a game they have not decided to play yet.
//
// Two speeds, chosen by what the browser actually grants rather than by what
// the page asked for:
//   SharedArrayBuffer available   full speed. The /play/ route sets COOP+COEP
//                                 to earn this.
//   not available                 a slower fallback path. What an embed on
//                                 somebody else's site gets, because that page
//                                 will not be cross-origin isolated.
(function (global) {
  "use strict";

  var RUNTIME_URL = "/mac/mac-runtime.js";
  var state = { loading: null, instances: [] };

  function loadRuntime() {
    if (global.MacEmulator) return Promise.resolve(global.MacEmulator);
    if (state.loading) return state.loading;
    state.loading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = RUNTIME_URL;
      s.async = true;
      s.onload = function () {
        if (!global.MacEmulator) reject(new Error("the runtime loaded but defined no MacEmulator"));
        else resolve(global.MacEmulator);
      };
      s.onerror = function () { reject(new Error("could not load /mac/mac-runtime.js")); };
      document.head.appendChild(s);
    });
    return state.loading;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ── the poster / play overlay ────────────────────────────────────────────
  function buildStage(mount, cfg) {
    var stage = document.createElement("div");
    stage.className = "embed-stage";
    stage.style.aspectRatio = cfg.width + " / " + cfg.height;

    var screen = document.createElement("div");
    screen.className = "embed-console-wrap";

    var overlay = document.createElement("div");
    overlay.className = "embed-overlay";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "embed-play";
    btn.innerHTML = "▶ Start " + esc(cfg.appName);
    var hint = document.createElement("p");
    hint.className = "embed-hint";
    hint.textContent = (cfg.emulator ? cfg.emulator + " · " : "") + cfg.width + "×" + cfg.height +
      " · nothing is installed or uploaded";
    overlay.appendChild(btn);
    overlay.appendChild(hint);

    var progress = document.createElement("div");
    progress.className = "dos-progress";
    progress.hidden = true;
    var fill = document.createElement("div");
    fill.className = "dos-progress-fill";
    progress.appendChild(fill);

    stage.appendChild(screen);
    stage.appendChild(overlay);
    stage.appendChild(progress);
    mount.appendChild(stage);
    return { stage: stage, overlay: overlay, btn: btn, progress: progress, fill: fill, screen: screen, hint: hint };
  }

  function readConfig(mount) {
    var d = mount.dataset;
    return {
      slug: d.slug || "",
      appName: d.appName || "a Macintosh",
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
  function boot(cfg, ui, extra) {
    extra = extra || {};
    if (ui.booted) return ui.booted;
    ui.btn.disabled = true;
    ui.progress.hidden = false;
    ui.hint.textContent = "Starting…";

    ui.booted = loadRuntime().then(function (MacEmulator) {
      var disks = extra.disks || (cfg.disk ? [{ name: cfg.disk, persistent: true }] : []);
      if (!disks.length && !(extra.diskFiles && extra.diskFiles.length)) {
        // A machine with no disk boots to a blinking floppy icon, which looks
        // exactly like a bug. Say what is actually wrong.
        throw new Error("no disk image is configured for this title yet");
      }

      var handle = MacEmulator.create({
        parent: ui.screen,
        machine: cfg.machine,
        disks: disks,
        diskFiles: extra.diskFiles,
        screen: { width: cfg.width, height: cfg.height },
        ramMB: cfg.ramMB,
        pixelated: true,
        flags: { autoPause: true },
        onProgress: function (done, total) {
          if (total) ui.fill.style.width = Math.round((done / total) * 100) + "%";
        },
        onLoaded: function (h) {
          ui.overlay.hidden = true;
          ui.progress.hidden = true;
          global.__macBooted = true;
          if (!h.useSharedMemory && cfg.mode === "isolated") {
            // Asked for full speed and did not get it. Better to say so than to
            // let someone conclude the emulator is simply slow.
            showNote(ui, "Running in compatibility mode — this browser did not grant shared memory, so it is slower than it should be.");
          }
          if (typeof extra.onLoaded === "function") extra.onLoaded(h);
        },
        onError: function (message) {
          ui.progress.hidden = true;
          ui.btn.disabled = false;
          ui.overlay.hidden = false;
          ui.hint.textContent = "Could not start: " + message;
        },
      });
      state.instances.push(handle);
      return handle.ready;
    }).catch(function (err) {
      ui.progress.hidden = true;
      ui.btn.disabled = false;
      ui.overlay.hidden = false;
      ui.hint.textContent = "Could not start: " + (err && err.message ? err.message : String(err));
      ui.booted = null;
      if (global.console) console.error("[macemu]", err);
      throw err;
    });
    return ui.booted;
  }

  function showNote(ui, text) {
    var p = document.createElement("p");
    p.className = "muted small";
    p.textContent = text;
    ui.stage.parentNode.insertBefore(p, ui.stage.nextSibling);
  }

  // ── public API, used by mac-loader.js ────────────────────────────────────
  global.MacPlayer = {
    /**
     * Mount an emulator into an element.
     * opts may carry: machine, appName, width, height, ramMB, disks,
     * diskFiles, onLoaded. Returns a promise for the MacEmulator handle.
     */
    start: function (mount, opts) {
      opts = opts || {};
      var cfg = readConfig(mount);
      for (var k in opts) if (cfg.hasOwnProperty(k) && opts[k] !== undefined) cfg[k] = opts[k];
      var ui = buildStage(mount, cfg);
      ui.btn.addEventListener("click", function () { boot(cfg, ui, opts); });
      return boot(cfg, ui, opts);
    },
    instances: function () { return state.instances.slice(); },
    loadRuntime: loadRuntime,
  };

  // ── auto-wire the title pages ────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    var mount = document.getElementById("mac-embed");
    if (!mount) return;
    var cfg = readConfig(mount);
    var ui = buildStage(mount, cfg);
    ui.btn.addEventListener("click", function () { boot(cfg, ui, null); });

    // Inside an embed on somebody else's page there is no article to read, so
    // waiting for a second click is just friction.
    if (cfg.mode === "fallback" && global.self !== global.top) boot(cfg, ui, null);
  });
})(typeof window !== "undefined" ? window : globalThis);
