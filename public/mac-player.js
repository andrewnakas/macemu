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

  // Fallback mode (no SharedArrayBuffer) works by having the emulator's Web
  // Worker make synchronous requests that a service worker answers. If that
  // service worker is not yet CONTROLLING when the worker starts, those
  // requests go to the network instead, 404, and after a hundred of them the
  // runtime gives up with "Too many fetch failures, disabling fallback
  // endpoint" — a machine that sits at a black screen forever.
  //
  // It is a startup race, so it fails intermittently and on whichever title
  // happens to lose it. Registering the worker and waiting for it to take
  // control before starting the emulator closes it. A freshly installed service
  // worker does not control the page that installed it until it claims those
  // clients, which is why waiting on `ready` alone is not enough.
  function serviceWorkerReady() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(false);
    return navigator.serviceWorker
      .register("/mac/emulator-service-worker.js", { scope: "/" })
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function () {
        if (navigator.serviceWorker.controller) return true;
        return new Promise(function (resolve) {
          var done = false;
          var finish = function (v) { if (!done) { done = true; resolve(v); } };
          navigator.serviceWorker.addEventListener("controllerchange", function () { finish(true); });
          // Do not block the boot forever on this. Without control the emulator
          // will still try, and may still succeed on a fast connection.
          setTimeout(function () { finish(false); }, 8000);
        });
      })
      .catch(function () { return false; });
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
    // A Macintosh screen has a fixed size. Letting the stage stretch past it
    // just paints black bars around a small picture, so cap it at the real
    // resolution and centre it.
    stage.style.maxWidth = cfg.width + "px";

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
      persist: d.persist === "true",
    };
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function boot(cfg, ui, extra) {
    extra = extra || {};
    if (ui.booted) return ui.booted;
    ui.btn.disabled = true;
    ui.progress.hidden = false;
    ui.hint.textContent = "Starting…";

    // A missing disk chunk does not raise an error — the emulator simply waits
    // for bytes that never arrive. Without a watchdog that failure looks
    // identical to a slow machine, and the visitor stares at a progress bar
    // until they leave.
    var watchdog = setTimeout(function () {
      if (global.__macBooted) return;
      ui.progress.hidden = true;
      ui.overlay.hidden = false;
      ui.btn.disabled = false;
      ui.btn.innerHTML = "Try again";
      ui.hint.innerHTML = "This machine did not finish starting. That usually means a disk is " +
        "incomplete on our side rather than anything wrong at yours. " +
        (cfg.slug ? '<a href="/contact/" style="color:#9cf">Tell us</a> and it gets fixed.' : "");
    }, 90000);

    ui.booted = loadRuntime().then(function (MacEmulator) {
      // Only fallback mode depends on the service worker; with shared memory
      // the emulator talks to its worker directly and waiting would be dead
      // time on every boot.
      var sab = !!global.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
      return sab ? MacEmulator : serviceWorkerReady().then(function (controlled) {
        if (!controlled && global.console) {
          console.warn("[macemu] the service worker is not controlling this page; " +
            "the emulator may fail to load its disk");
        }
        return MacEmulator;
      });
    }).then(function (MacEmulator) {
      // Persistence is opt-in per page (data-persist="true"). It routes the
      // disk through an origin-private-file-system saver, which is what a
      // hosted game wants so progress survives, and which has been seen to stop
      // a machine booting at all. Off unless a page asks for it.
      var disks = extra.disks ||
        (cfg.disk ? [{ name: cfg.disk, persistent: cfg.persist }] : []);
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
        // Register the emulator's service worker at the ROOT, not at the
        // default scope derived from the page's first path segment.
        //
        // Fallback mode (no SharedArrayBuffer) works by having the emulator's
        // Web Worker make synchronous requests that the service worker answers.
        // The worker script is served from /mac/, while the page is /embed/ or
        // /load-mac-file/ — and a service worker only controls clients under
        // its own scope. Scoped to /embed/, it controls the page and not the
        // worker, so every worker-commands request goes to the network and
        // returns 404, and the machine sits at a black screen forever with no
        // error. Only "/" covers both. public/_headers sends
        // Service-Worker-Allowed: / on the script so this scope is permitted.
        serviceWorker: { scope: "/" },
        onProgress: function (done, total) {
          if (total) ui.fill.style.width = Math.round((done / total) * 100) + "%";
        },
        onLoaded: function (h) {
          clearTimeout(watchdog);
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
          clearTimeout(watchdog);
          global.__macBootError = message;
          ui.progress.hidden = true;
          ui.btn.disabled = false;
          ui.overlay.hidden = false;
          ui.hint.textContent = "Could not start: " + message;
        },
      });
      state.instances.push(handle);
      return handle.ready;
    }).catch(function (err) {
      clearTimeout(watchdog);
      global.__macBootError = err && err.message ? err.message : String(err);
      ui.progress.hidden = true;
      ui.btn.disabled = false;
      ui.overlay.hidden = false;
      ui.hint.textContent = "Could not start: " + global.__macBootError;
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
