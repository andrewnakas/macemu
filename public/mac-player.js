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

  // ── analytics ────────────────────────────────────────────────────────────
  // GA sees page views and nothing inside the emulator, so without these a
  // title that never boots looks exactly like one someone played for an hour.
  // gtag is defined by the page head (scripts/site.mjs) on every page that
  // mounts a player; where it is missing, or blocked, this does nothing.
  function track(cfg, name, params) {
    try {
      if (typeof global.gtag !== "function") return;
      var p = { slug: cfg.slug || "", mode: cfg.mode, os: cfg.era || "" };
      for (var k in params) if (params.hasOwnProperty(k)) p[k] = params[k];
      global.gtag("event", name, p);
    } catch (e) { /* analytics is never allowed to break a boot */ }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ── the poster / play overlay ────────────────────────────────────────────
  // ── saved progress ───────────────────────────────────────────────────────
  // A persistent disk lives in the origin private file system as <name>.data
  // plus a <name>.dirtychunks bitmap. The bitmap is the useful one: it exists
  // only once something has actually been written, so its presence is a
  // reliable "this visitor has progress here" without opening the disk.
  function opfsRoot() {
    if (!global.navigator || !navigator.storage || !navigator.storage.getDirectory) {
      return Promise.resolve(null);
    }
    return navigator.storage.getDirectory().catch(function () { return null; });
  }

  // The emulator names its OPFS files after each manifest's `name` field
  // ("Archon v2"), not the manifest filename ("archon-v2"). gen-pages resolves
  // those and sends them down; falling back to the slugs would look for saves
  // that are not there and delete nothing when asked to.
  function diskNames(cfg) {
    var names = (cfg.diskNames && cfg.diskNames.length)
      ? cfg.diskNames.slice()
      : [cfg.disk].concat(cfg.extraDisks).filter(Boolean);
    // Drop the shared system image: it is never persisted (see boot()), so
    // reporting or deleting a save against it would be wrong in both
    // directions. data-disk-names lists the boot disk first.
    if (cfg.extraDisks.length > 0 && names.length > 1) names.shift();
    return names;
  }

  function hasSavedState(cfg) {
    return opfsRoot().then(function (root) {
      if (!root) return false;
      var names = diskNames(cfg);
      var checks = names.map(function (n) {
        return root.getFileHandle(n + ".dirtychunks").then(function () { return true; },
                                                           function () { return false; });
      });
      return Promise.all(checks).then(function (found) {
        return found.some(Boolean);
      });
    }).catch(function () { return false; });
  }

  function clearSavedState(cfg) {
    return opfsRoot().then(function (root) {
      if (!root) return;
      var jobs = [];
      diskNames(cfg).forEach(function (n) {
        [".data", ".dirtychunks"].forEach(function (ext) {
          jobs.push(root.removeEntry(n + ext).catch(function () {}));
        });
      });
      return Promise.all(jobs);
    });
  }

  // Closing a tab is not shutting a Macintosh down. System 7.5 creates an
  // empty file called "Shutdown Check" at the root of the startup disk when it
  // boots and deletes it when it shuts down; finding it already there at
  // startup is how it knows to put "This computer may not have been shut down
  // properly" over the game. Every saved disk comes back with that file on it.
  //
  // So before the emulator opens a saved disk, delete the file's catalog
  // record, which is what Shut Down would have done. (Setting the MDB's
  // "unmounted cleanly" bit was tried first and changes nothing: 7.5 does not
  // look at it.) Only 512-byte blocks the Mac itself has written are read or
  // touched — the file was created on this visitor's machine, so every block
  // that mentions it is in the saved copy. Anything unexpected — a partitioned
  // image, a non-empty file, a leaf node that would be left empty, a record
  // the index points at — and nothing is written: the dialog is a nuisance, a
  // damaged catalog would lose the save.
  function markCleanShutdown(cfg) {
    var name = cfg.diskNames && cfg.diskNames[0];
    if (!name || !cfg.disk) return Promise.resolve();
    var TARGET = "shutdown check";
    return opfsRoot().then(function (root) {
      if (!root) return;
      return Promise.all([
        root.getFileHandle(name + ".dirtychunks").then(function (h) { return h.getFile(); })
          .then(function (f) { return f.arrayBuffer(); }),
        root.getFileHandle(name + ".data"),
        fetch("/mac/disks/" + encodeURIComponent(cfg.disk) + ".json").then(function (r) { return r.json(); }),
      ]).then(function (got) {
        var dirty = new Uint8Array(got[0]), dataHandle = got[1], chunkSize = got[2].chunkSize;
        var isDirty = function (off) {
          var c = Math.floor(off / chunkSize);
          return !!(dirty[c >> 3] & (1 << (c & 7)));
        };
        if (!isDirty(1024)) return;
        return dataHandle.getFile().then(function (file) {
          var read = function (off) {
            return file.slice(off, off + 512).arrayBuffer().then(function (b) { return new Uint8Array(b); });
          };
          return read(1024).then(function (mdb) {
            var dv = new DataView(mdb.buffer);
            if (dv.getUint16(0) !== 0x4244) return;              // not a bare HFS volume
            var alBlkSiz = dv.getUint32(20), alBlSt = dv.getUint16(28);
            // Catalog file extents: three (start, count) pairs at +150.
            var nodes = [];
            for (var e = 0; e < 3; e++) {
              var start = dv.getUint16(150 + e * 4), count = dv.getUint16(152 + e * 4);
              var base = alBlSt * 512 + start * alBlkSiz;
              for (var b = 0; b < count * alBlkSiz; b += 512) nodes.push(base + b);
            }
            nodes = nodes.slice(0, Math.floor(dv.getUint32(146) / 512));   // drCTFlSize
            if (!nodes.length || !isDirty(nodes[0])) return;
            var saved = nodes.filter(isDirty);
            return Promise.all(saved.map(read)).then(function (blocks) {
              var byOff = {};
              saved.forEach(function (off, i) { byOff[off] = blocks[i]; });
              var u16 = function (b, o) { return (b[o] << 8) | b[o + 1]; };
              var u32 = function (b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; };
              var put16 = function (b, o, v) { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
              var put32 = function (b, o, v) { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); };
              var recOff = function (node, i) { return u16(node, 512 - 2 * (i + 1)); };
              var keyName = function (node, r) {
                var len = node[r + 6], s = "";
                for (var k = 0; k < len; k++) s += String.fromCharCode(node[r + 7 + k]);
                return s.toLowerCase();
              };
              var dataAt = function (node, r) { var d = r + 1 + node[r]; return d + (d & 1); };
              var hit = null, rootDir = null;
              saved.forEach(function (off) {
                var node = byOff[off];
                if (node[8] !== 0xff) return;                       // leaf nodes only
                var n = u16(node, 10);
                for (var i = 0; i < n; i++) {
                  var r = recOff(node, i), d = dataAt(node, r), parent = u32(node, r + 2);
                  if (parent === 2 && node[d] === 2 && keyName(node, r) === TARGET) hit = { off: off, i: i, d: d };
                  if (parent === 1 && node[d] === 1 && u32(node, d + 6) === 2) rootDir = { off: off, d: d };
                }
              });
              if (!hit || !rootDir || hit.i === 0) return;
              var node = byOff[hit.off], n = u16(node, 10);
              // Physical lengths of both forks must be zero: nothing to free.
              if (u32(node, hit.d + 30) || u32(node, hit.d + 40)) return;
              if (n < 2) return;
              var from = recOff(node, hit.i), to = recOff(node, hit.i + 1), end = recOff(node, n), gap = to - from;
              node.copyWithin(from, to, end);
              node.fill(0, end - gap, end);
              for (var j = hit.i + 1; j <= n; j++) put16(node, 512 - 2 * j, recOff(node, j) - gap);
              put16(node, 512 - 2 * (n + 1), 0);
              put16(node, 10, n - 1);
              var header = byOff[nodes[0]];
              put32(header, 14 + 6, u32(header, 14 + 6) - 1);       // bthNRecs
              var dir = byOff[rootDir.off];
              put16(dir, rootDir.d + 4, u16(dir, rootDir.d + 4) - 1); // dirVal
              put16(mdb, 12, u16(mdb, 12) - 1);                      // drNmFls
              put32(mdb, 84, u32(mdb, 84) - 1);                      // drFilCnt
              var writes = [[1024, mdb]];
              [hit.off, nodes[0], rootDir.off].forEach(function (off) {
                if (!writes.some(function (w) { return w[0] === off; })) writes.push([off, byOff[off]]);
              });
              return dataHandle.createWritable({ keepExistingData: true }).then(function (w) {
                return writes.reduce(function (p, wr) {
                  return p.then(function () { return w.write({ type: "write", position: wr[0], data: wr[1] }); });
                }, Promise.resolve()).then(function () { return w.close(); });
              });
            });
          });
        });
      });
    }).catch(function (e) {
      // NotFoundError is simply "no save yet", the ordinary first visit.
      if (e && e.name !== "NotFoundError" && global.console) console.warn("[macemu] could not tidy the saved disk", e);
    });
  }

  // ── what this visitor has played ─────────────────────────────────────────
  // A small registry so the homepage can offer to carry on. It records only
  // what is needed to draw a card — slug, name, when — and only for titles
  // that actually persist, because offering to "continue" a title whose
  // progress was never saved is a promise the site cannot keep.
  var RECENT_KEY = "macemu:recent";
  var RECENT_MAX = 12;

  function rememberPlayed(cfg) {
    if (!cfg.slug) return;
    try {
      var list = JSON.parse(global.localStorage.getItem(RECENT_KEY) || "[]");
      if (!Array.isArray(list)) list = [];
      list = list.filter(function (r) { return r && r.slug !== cfg.slug; });
      list.unshift({ slug: cfg.slug, name: cfg.appName || cfg.slug, at: Date.now() });
      global.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) { /* private mode, quota, disabled storage — never fatal */ }
  }

  // Persistence can stop a machine booting. Rather than refuse it everywhere,
  // treat it as revocable per title: the first failure disables it for that
  // title on this device and the retry goes through unpersisted.
  function persistKey(cfg) { return "macemu:nopersist:" + (cfg.slug || cfg.disk || "?"); }

  function persistBlocked(cfg) {
    try { return global.localStorage.getItem(persistKey(cfg)) === "1"; }
    catch (e) { return false; }
  }

  function blockPersist(cfg) {
    try { global.localStorage.setItem(persistKey(cfg), "1"); } catch (e) {}
  }

  function parseJsonList(raw) {
    if (!raw) return [];
    try { var v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }

  function parseControls(raw) {
    if (!raw) return [];
    try {
      var rows = JSON.parse(raw);
      return Array.isArray(rows) ? rows.filter(function (r) { return r && r.length >= 2; }) : [];
    } catch (e) { return []; }
  }

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
    if (cfg.poster) {
      overlay.classList.add("has-poster");
      // Dimmed, so the Start button and its hint stay readable over any picture.
      overlay.style.backgroundImage = "linear-gradient(rgba(0,0,0,0.62), rgba(0,0,0,0.8)), url(\"" +
        cfg.poster.replace(/"/g, "%22") + "\")";
    }
    overlay.appendChild(btn);
    overlay.appendChild(hint);
    // A phone can start the machine but cannot press an arrow key, and finding
    // that out after a minute of booting is worse than being told up front.
    // Only where the device has no fine pointer at all: a touchscreen laptop
    // has a keyboard.
    if (cfg.needsKeyboard && global.matchMedia &&
        global.matchMedia("(pointer: coarse)").matches &&
        !global.matchMedia("(any-pointer: fine)").matches) {
      var kb = document.createElement("p");
      kb.className = "embed-touch";
      kb.textContent = "This one needs a keyboard — it plays best on a computer.";
      overlay.appendChild(kb);
    }

    var progress = document.createElement("div");
    progress.className = "dos-progress";
    progress.hidden = true;
    var fill = document.createElement("div");
    fill.className = "dos-progress-fill";
    progress.appendChild(fill);

    // The controls sheet. Hidden until asked for, and the only copy of this
    // information that survives going fullscreen.
    // What to do once the machine is up, shown over the screen rather than
    // under it. Most titles need a first action and the visitor cannot be
    // expected to have read a grey line below the fold — still less to see it
    // in fullscreen, where the page is not on screen at all.
    var note = document.createElement("div");
    note.className = "embed-note";
    note.hidden = true;
    if (cfg.launchNote || cfg.persist) {
      if (cfg.launchNote) note.innerHTML = "<p>" + esc(cfg.launchNote) + "</p>";
      var dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "embed-note-x";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.innerHTML = "&times;";
      dismiss.addEventListener("click", function () { note.hidden = true; });
      note.appendChild(dismiss);
      // The note is pointer-transparent (see the stylesheet) so a click aimed
      // at the menu bar behind it still reaches the Macintosh. That same click
      // is the signal the visitor has started, so the note steps aside.
      // pointerdown rather than mousedown, so a tap counts on a touchscreen.
      var step = function () { note.hidden = true; };
      screen.addEventListener("pointerdown", step, { once: true });
      global.addEventListener("keydown", step, { once: true });
    }

    var sheet = document.createElement("div");
    sheet.className = "embed-sheet";
    sheet.hidden = true;
    if (cfg.controls.length) {
      var rows = cfg.controls.map(function (c) {
        return "<tr><td><kbd>" + esc(c[0]) + "</kbd></td><td>" + esc(c[1]) + "</td></tr>";
      }).join("");
      sheet.innerHTML = "<h4>Controls</h4><table>" + rows + "</table>";
    }

    stage.appendChild(screen);
    stage.appendChild(overlay);
    stage.appendChild(note);
    stage.appendChild(sheet);
    stage.appendChild(progress);

    // Chrome under the screen. Built now, revealed once the machine is up —
    // there is nothing to go fullscreen with before that.
    var bar = document.createElement("div");
    bar.className = "embed-bar";
    bar.hidden = true;

    var full = mkbtn("⛶", "Fullscreen", "Fullscreen");
    var ctrls = mkbtn("⌨", "Controls", "Show the controls");
    var wipe = mkbtn("↺", "Reset save", "Delete saved progress for this title");
    var status = document.createElement("span");
    status.className = "embed-status";

    bar.appendChild(full);
    if (cfg.controls.length) bar.appendChild(ctrls);
    bar.appendChild(wipe);
    bar.appendChild(status);
    // Somewhere to go next once this title has had its turn. Not inside an
    // embed: a link there would navigate someone else's iframe.
    var next = null;
    if (cfg.nextSlug && global.self === global.top) {
      next = document.createElement("a");
      next.className = "embed-ctl embed-next";
      next.href = "/run/" + encodeURIComponent(cfg.nextSlug) + "/";
      next.setAttribute("data-rec", "next");
      next.setAttribute("data-slug", cfg.nextSlug);
      next.textContent = "Play next: " + (cfg.nextName || cfg.nextSlug) + " →";
      bar.appendChild(next);
    }
    mount.appendChild(stage);
    mount.appendChild(bar);

    return { stage: stage, overlay: overlay, btn: btn, progress: progress, fill: fill,
             screen: screen, hint: hint, bar: bar, full: full, ctrls: ctrls, wipe: wipe,
             status: status, sheet: sheet, note: note };
  }

  function mkbtn(glyph, label, title) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "embed-ctl";
    b.title = title;
    b.innerHTML = '<span aria-hidden="true">' + glyph + "</span> " + esc(label);
    return b;
  }

  function readConfig(mount) {
    var d = mount.dataset;
    return {
      slug: d.slug || "",
      appName: d.appName || "a Macintosh",
      machine: d.machine || "Quadra-650",
      emulator: d.emulator || "",
      disk: d.disk || "",
      // Disks mounted after the boot disk. A title that runs on a shared
      // operating-system image lives on one of these: the OS disk is byte
      // identical for every such title, so a visitor downloads it once and
      // every later title reuses the chunks already in their cache.
      extraDisks: (d.extraDisks || "").split(",").filter(Boolean),
      width: parseInt(d.width, 10) || 640,
      height: parseInt(d.height, 10) || 480,
      ramMB: d.ram ? parseInt(d.ram, 10) : undefined,
      mode: d.mode || "isolated",
      persist: d.persist === "true",
      // Authoring only (scripts/author-disk.mjs pages, never a title page):
      // save the boot disk even with other disks mounted, so a system image
      // can have software installed into it from a second disk.
      persistBoot: d.persistBoot === "true",
      controls: parseControls(d.controls),
      launchNote: d.launchNote || "",
      era: d.era || "",
      // The title's own screenshot, drawn behind the Start button so the first
      // thing a visitor sees is the game rather than an empty grey box.
      poster: d.poster || "",
      // Where to send someone once this title has had its turn.
      nextSlug: d.nextSlug || "",
      nextName: d.nextName || "",
      needsKeyboard: d.needsKeyboard === "true",
      // What the emulator calls this title's persistent files in the origin
      // private file system: each manifest's `name`, not its filename.
      diskNames: parseJsonList(d.diskNames),
    };
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function boot(cfg, ui, extra) {
    extra = extra || {};
    if (ui.booted) return ui.booted;
    ui.btn.disabled = true;
    ui.progress.hidden = false;
    ui.hint.textContent = "Starting…";
    // A retry after a failed persistent boot is the same visit, not a new one:
    // keep the first start time so boot_ms is what the visitor actually waited.
    if (!ui.t0) {
      ui.t0 = Date.now();
      track(cfg, "game_start", { resumed: !!ui.resuming, persist: !!cfg.persist });
    }
    startLoadingReadout(cfg, ui);

    // A missing disk chunk does not raise an error — the emulator simply waits
    // for bytes that never arrive. Without a watchdog that failure looks
    // identical to a slow machine, and the visitor stares at a progress bar
    // until they leave.
    var watchdog = setTimeout(function () {
      if (global.__macBooted) return;
      // The documented way persistence goes wrong is not an error — it is a
      // machine that never finishes starting. That never rejects, so the
      // catch below would not see it; the watchdog has to revoke persistence
      // and retry, or the visitor just gets a dead screen and a Try again
      // button that fails the same way for ever.
      if (ui.triedPersist && !ui.persistRetry) {
        ui.persistRetry = true;
        blockPersist(cfg);
        global.__macPersistFellBack = true;
        track(cfg, "persist_fallback", { cause: "hang" });
        if (global.console) {
          console.warn("[macemu] persistent boot hung; retrying without saved progress");
        }
        ui.booted = null;
        boot(cfg, ui, extra).then(function () {
          setStatus(ui, "Saving is unavailable for this title in this browser");
        }, function () {});
        return;
      }
      stopLoadingReadout(ui);
      track(cfg, "game_timeout", { boot_ms: Date.now() - ui.t0, mb_read: mbRead(ui) });
      ui.progress.hidden = true;
      ui.overlay.hidden = false;
      ui.btn.disabled = false;
      ui.btn.innerHTML = "Try again";
      ui.hint.innerHTML = "This machine did not finish starting. That usually means a disk is " +
        "incomplete on our side rather than anything wrong at yours. " +
        (cfg.slug ? '<a href="/contact/" style="color:#9cf">Tell us</a> and it gets fixed.' : "");
    }, 90000);

    ui.booted = loadRuntime().then(function (MacEmulator) {
      // A saved boot disk is marked as cleanly shut down before the emulator
      // opens it. Not for shared-system titles: their boot disk is never saved.
      if (!(cfg.persist && !persistBlocked(cfg) && !cfg.extraDisks.length)) return MacEmulator;
      return markCleanShutdown(cfg).then(function () { return MacEmulator; });
    }).then(function (MacEmulator) {
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
      var disks = extra.disks || [];
      if (!disks.length && cfg.disk) {
        // The boot disk first — the runtime boots the first bootable one — then
        // any title disks after it.
        var wantPersist = cfg.persist && !persistBlocked(cfg);
        ui.triedPersist = wantPersist;
        // A Mac OS 8 title boots the SHARED system image and mounts its own
        // small disk after it. Persisting the shared one would hand every
        // such title the same mutable operating system: writes from one would
        // show up in another, and a single corrupted copy would take out
        // twenty-odd titles at once. Persist only what belongs to this title.
        var sharedBoot = cfg.extraDisks.length > 0 && !cfg.persistBoot;
        disks.push({ name: cfg.disk, persistent: wantPersist && !sharedBoot });
        for (var i = 0; i < cfg.extraDisks.length; i++) {
          disks.push({ name: cfg.extraDisks[i], persistent: wantPersist });
        }
      }
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
        // Fires once per 256 KB disk chunk the machine asks for, from the
        // network or the cache. The runtime's own progress counts its files,
        // not bytes, so this is the only honest measure of a long first boot.
        onDiskActivity: function (busy) { if (busy) ui.chunks = (ui.chunks || 0) + 1; },
        onQuiescent: function () {
          if (ui.ready) return;
          ui.ready = true;
          stopLoadingReadout(ui);
          setStatus(ui, ui.triedPersist ? "Progress is saved in this browser" : "");
          track(cfg, "game_ready", {
            ready_ms: Date.now() - ui.t0,
            mb_read: mbRead(ui),
            resumed: !!ui.resuming,
          });
        },
        // "Loaded" is the emulator process starting — a fraction of a second
        // in, before the Mac has read most of its disk. The wait a visitor
        // actually sits through comes after it, on screen, and ends when the
        // worker reports the machine has gone quiet: boot writes done.
        onLoaded: function (h) {
          clearTimeout(watchdog);
          ui.loadedAt = Date.now();
          track(cfg, "emulator_started", {
            boot_ms: ui.loadedAt - ui.t0,
            shared_memory: !!h.useSharedMemory,
            resumed: !!ui.resuming,
            persist: !!ui.triedPersist,
          });
          watchPlay(cfg, ui);
          ui.overlay.hidden = true;
          ui.progress.hidden = true;
          global.__macBooted = true;
          // Only remember it if progress is actually being saved — see
          // rememberPlayed().
          if (ui.triedPersist) rememberPlayed(cfg);
          // Closing a tab is not shutting a Macintosh down, so a visitor who
          // comes back to saved progress is met by "This computer may not have
          // been shut down properly" sitting over the game. The machine is
          // fine — the volume simply was not unmounted — but nothing on screen
          // says so, and the dialog has to be cleared before anything works.
          // markCleanShutdown() is what keeps that dialog away; the note only
          // says that progress was picked up.
          if (ui.resuming && ui.note) {
            var r = document.createElement("p");
            r.className = "embed-note-resume";
            r.textContent = "Picking up your saved disk where you left it.";
            ui.note.insertBefore(r, ui.note.firstChild);
          }
          if (ui.note && (cfg.launchNote || ui.resuming)) ui.note.hidden = false;
          if (ui.bar) {
            ui.bar.hidden = false;
            ui.full.hidden = false;
            if (ui.ctrls) ui.ctrls.hidden = false;
            if (ui.ready) setStatus(ui, ui.triedPersist ? "Progress is saved in this browser" : "");
          }
          if (!h.useSharedMemory && cfg.mode === "isolated") {
            // Asked for full speed and did not get it. Better to say so than to
            // let someone conclude the emulator is simply slow.
            showNote(ui, "Running in compatibility mode — this browser did not grant shared memory, so it is slower than it should be.");
          }
          if (typeof extra.onLoaded === "function") extra.onLoaded(h);
        },
        onError: function (message) {
          clearTimeout(watchdog);
          stopLoadingReadout(ui);
          trackError(cfg, ui, message);
          global.__macBootError = message;
          ui.progress.hidden = true;
          ui.btn.disabled = false;
          ui.overlay.hidden = false;
          ui.hint.textContent = "Could not start: " + message;
        },
      });
      state.instances.push(handle);
      // Authoring (scripts/author-disk.mjs) needs to stop the machine before it
      // can read the persistent disk the worker is holding a lock on. Harmless
      // otherwise, and useful when debugging a boot by hand from the console.
      global.__macInstances = state.instances;
      return handle.ready;
    }).catch(function (err) {
      clearTimeout(watchdog);
      // A persistent disk can stop a machine booting outright. If that is what
      // just happened, revoke persistence for this title on this device and go
      // again unpersisted — one dead boot is a bad visit, two is a lost one.
      // __macPersistFellBack is here for scripts/author-disk.mjs, which needs
      // to know it captured nothing rather than silently writing no changes.
      if (ui.triedPersist && !ui.persistRetry) {
        ui.persistRetry = true;
        blockPersist(cfg);
        global.__macPersistFellBack = true;
        track(cfg, "persist_fallback", { cause: "error" });
        if (global.console) {
          console.warn("[macemu] persistent boot failed; retrying without saved progress");
        }
        ui.booted = null;
        return boot(cfg, ui, extra).then(function (h) {
          setStatus(ui, "Saving is unavailable for this title in this browser");
          return h;
        });
      }
      global.__macBootError = err && err.message ? err.message : String(err);
      stopLoadingReadout(ui);
      trackError(cfg, ui, global.__macBootError);
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

  function setStatus(ui, text) {
    if (ui.status) ui.status.textContent = text || "";
  }

  // ── while it starts ──────────────────────────────────────────────────────
  // A first Mac OS 8 boot pulls a large shared system image and can take a
  // minute, most of it after the emulator has started and the Mac is drawing
  // its own startup screen. Behind a bare progress bar that looks like a hang, and a visitor
  // who thinks it has hung leaves. A clock and a running total say otherwise.
  function mbRead(ui) { return Math.round((ui.chunks || 0) / 4); }

  function startLoadingReadout(cfg, ui) {
    stopLoadingReadout(ui);
    ui.readout = setInterval(function () {
      var s = Math.round((Date.now() - ui.t0) / 1000);
      if (s < 3) return;
      var text = "Starting… " + s + " s";
      var mb = mbRead(ui);
      if (mb) text += " · " + mb + " MB loaded";
      if (cfg.extraDisks.length && s >= 8) {
        text += ". The first Mac OS 8 title downloads the system once; the rest start much faster.";
      }
      // Before the emulator is up the overlay is on screen; after it, the
      // overlay is gone and the Mac is booting, so the bar under it speaks.
      if (ui.loadedAt) setStatus(ui, text); else ui.hint.textContent = text;
    }, 1000);
  }

  function stopLoadingReadout(ui) {
    if (ui.readout) { clearInterval(ui.readout); ui.readout = null; }
  }

  // The runtime both calls onError and rejects its ready promise for the same
  // failure. Count it once.
  function trackError(cfg, ui, message) {
    if (ui.errorTracked) return;
    ui.errorTracked = true;
    track(cfg, "game_error", {
      reason: String(message || "").slice(0, 100),
      boot_ms: Date.now() - ui.t0,
    });
  }

  // What happened after it booted: did the visitor touch it, and for how
  // long did they stay. play_time goes once, when the page is hidden or left,
  // as a beacon so it survives the tab closing.
  function watchPlay(cfg, ui) {
    if (ui.watching) return;
    ui.watching = true;
    var loadedAt = Date.now();
    var touched = false;
    var first = function () {
      if (touched) return;
      touched = true;
      track(cfg, "first_input", { ms_after_load: Date.now() - loadedAt });
    };
    ui.screen.addEventListener("pointerdown", first, { once: true });
    global.addEventListener("keydown", first, { once: true });

    var sent = false;
    var send = function () {
      if (sent) return;
      sent = true;
      var s = Math.round((Date.now() - loadedAt) / 1000);
      track(cfg, "play_time", {
        seconds: s,
        bucket: s < 60 ? "<1m" : s < 300 ? "1-5m" : s < 900 ? "5-15m" : "15m+",
        interacted: touched,
        ready: !!ui.ready,
        transport_type: "beacon",
      });
    };
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") send();
    });
    global.addEventListener("pagehide", send);
  }

  // ── chrome behaviour ─────────────────────────────────────────────────────
  function wireControls(cfg, ui) {
    if (!ui.bar) return;

    // Fullscreen. The stage is capped at the Macintosh's real resolution with
    // an inline max-width, which would otherwise pin a 512-pixel screen to the
    // middle of a 4K display; lift it while fullscreen and put it back after.
    var capped = ui.stage.style.maxWidth;
    function onFsChange() {
      var on = document.fullscreenElement === ui.stage;
      ui.stage.style.maxWidth = on ? "none" : capped;
      ui.full.innerHTML = '<span aria-hidden="true">⛶</span> ' + (on ? "Exit fullscreen" : "Fullscreen");
      // Fullscreen takes the element out of the document flow, so the bar and
      // its buttons go with it or they are simply gone.
      if (on) ui.stage.appendChild(ui.bar); else ui.stage.parentNode.appendChild(ui.bar);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    ui.full.addEventListener("click", function () {
      if (document.fullscreenElement === ui.stage) {
        document.exitFullscreen();
      } else if (ui.stage.requestFullscreen) {
        track(cfg, "fullscreen", {});
        ui.stage.requestFullscreen().catch(function () {
          setStatus(ui, "This browser would not allow fullscreen here");
        });
      }
    });
    // An embed inside someone else's page only gets fullscreen if they allowed
    // it. Hide the button rather than offer one that does nothing.
    if (global.self !== global.top && !document.fullscreenEnabled) ui.full.hidden = true;

    if (ui.ctrls) {
      ui.ctrls.addEventListener("click", function () {
        ui.sheet.hidden = !ui.sheet.hidden;
        ui.ctrls.setAttribute("aria-pressed", String(!ui.sheet.hidden));
        if (!ui.sheet.hidden) track(cfg, "controls_open", {});
      });
    }

    // Deleting saved progress is the escape hatch for a save that has gone
    // bad — without it a corrupted disk is a title the visitor can never load
    // again, and they have no way to know why.
    ui.wipe.addEventListener("click", function () {
      if (!global.confirm("Delete saved progress for this title? The next start begins fresh.")) return;
      track(cfg, "reset_save", { booted: !!global.__macBooted });
      clearSavedState(cfg).then(function () {
        try { global.localStorage.removeItem(persistKey(cfg)); } catch (e) {}
        setStatus(ui, "Saved progress deleted — reload to start fresh");
      });
    });

    // Reveal the bar before boot when there is a save, with only the controls
    // that mean anything yet. This is not cosmetic: a save that has gone bad
    // is a title that will not start, and if the only way to delete it is a
    // button that appears after a successful boot, the visitor is stuck for
    // good with no way to find out why.
    hasSavedState(cfg).then(function (found) {
      ui.resuming = found;
      if (!found || ui.booted) return;
      ui.full.hidden = true;
      if (ui.ctrls) ui.ctrls.hidden = true;
      ui.bar.hidden = false;
      setStatus(ui, "Saved progress found — starting continues it");
    });
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
      wireControls(cfg, ui);
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
    wireControls(cfg, ui);
    ui.btn.addEventListener("click", function () { boot(cfg, ui, null); });

    // Inside an embed on somebody else's page there is no article to read, so
    // waiting for a second click is just friction.
    if (cfg.mode === "fallback" && global.self !== global.top) boot(cfg, ui, null);
  });
})(typeof window !== "undefined" ? window : globalThis);
