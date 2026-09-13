// The drop-your-own-file zone.
//
// Turns <div id="mac-loader" data-accepts="…"> into a dropzone that identifies
// what a visitor gave it, boots a Macintosh, and puts the file where the Mac
// will see it. On exebrowser.com the equivalent utility pages — "run exe
// online", "open an exe file" — convert at around 27%, several times better
// than any individual game page, because someone searching for a way to open a
// file has a problem right now rather than a passing interest.
//
// Needs macbin.js (format identification) and mac-player.js (the emulator).
(function (global) {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    const mount = document.getElementById("mac-loader");
    if (!mount) return;

    const accepts = (mount.dataset.accepts || "").split(",").filter(Boolean);
    const machine = mount.dataset.machine || "Quadra-650";

    const zone = document.createElement("div");
    zone.className = "dropzone";
    zone.innerHTML =
      '<p class="dz-title">Drop a file here</p>' +
      '<p class="dz-sub">' + (accepts.length ? accepts.join("  ") : "any classic Mac file") + "</p>" +
      '<button type="button" class="cta-btn dz-pick">Choose a file</button>' +
      '<p class="dz-note muted small">It is read on your own computer. Nothing is uploaded.</p>';
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    if (accepts.length) input.accept = accepts.join(",");
    zone.appendChild(input);

    const status = document.createElement("p");
    status.className = "dz-status muted small";
    status.setAttribute("role", "status");

    const stage = document.createElement("div");
    stage.className = "dz-stage";

    mount.appendChild(zone);
    mount.appendChild(status);
    mount.appendChild(stage);

    zone.querySelector(".dz-pick").addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () { if (input.files && input.files[0]) handle(input.files[0]); });

    ["dragenter", "dragover"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("is-over"); });
    });
    zone.addEventListener("drop", function (e) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handle(f);
    });

    // A visitor may reasonably drop a 600 MB CD image. Reading that into an
    // ArrayBuffer is fine; saying so first is politer than a frozen tab.
    const BIG = 64 * 1024 * 1024;

    function handle(file) {
      status.textContent = "Reading " + file.name + "…" + (file.size > BIG ? " (large file, this takes a moment)" : "");
      const reader = new FileReader();
      reader.onerror = function () { status.textContent = "Could not read that file."; };
      reader.onload = function () {
        let bytes;
        try {
          bytes = new Uint8Array(reader.result);
        } catch (err) {
          status.textContent = "Could not read that file.";
          return;
        }
        let id;
        try {
          id = global.MacBin.identify(bytes, file.name);
        } catch (err) {
          // A recognised format that failed to decode is worth saying out loud:
          // it usually means the file was truncated or mangled in transit, and
          // that is actionable information.
          status.textContent = "That looks like a Macintosh file but it would not decode: " + err.message;
          return;
        }
        describe(id, file);
        launch(id, file);
      };
      reader.readAsArrayBuffer(file);
    }

    function describe(id, file) {
      const what = {
        macbinary: "MacBinary — both forks preserved",
        binhex: "BinHex 4.0 — decoded here in your browser",
        disk: id.isFloppy ? "a floppy disk image" : "a hard disk image",
        cdrom: "a CD-ROM image",
        opaque: "an archive or document",
      }[id.kind] || "a file";
      const extra = id.file && id.file.name ? " (" + id.file.name + ", type " + id.file.type + ")" : "";
      const vol = id.volumeName ? ' — volume "' + id.volumeName + '"' : "";
      status.textContent = file.name + " is " + what + extra + vol + ". Starting a Macintosh…";
    }

    function launch(id, file) {
      if (!global.MacPlayer) {
        status.textContent = "The emulator did not load. Try reloading the page.";
        return;
      }
      zone.classList.add("is-busy");
      global.MacPlayer.start(stage, {
        machine: machine,
        appName: file.name,
        width: machine === "Mac-Plus" ? 512 : 640,
        height: machine === "Mac-Plus" ? 342 : 480,
        onLoaded: function (emu) {
          try {
            if (id.kind === "disk" || id.kind === "cdrom") {
              // Raw images go in as a disk the Mac mounts itself.
              emu.mountDisk(new Blob([id.bytes]), {
                name: file.name,
                isFloppy: !!id.isFloppy,
                isCDROM: id.kind === "cdrom",
              });
              status.textContent = "Mounted. Look for it on the desktop.";
            } else if (id.kind === "macbinary" || id.kind === "binhex") {
              // Decoded already: hand over both forks so the application keeps
              // its icon, its type and creator, and its code.
              emu.putFile({
                name: id.file.name || file.name,
                type: id.file.type,
                creator: id.file.creator,
                data: id.file.data,
                rsrc: id.file.rsrc,
              });
              status.textContent = 'Copied to the Mac as "' + (id.file.name || file.name) + '". Open the Downloads folder on the desktop.';
            } else {
              emu.putFile({ name: file.name, data: id.bytes });
              status.textContent = "Copied to the Mac. Open the Downloads folder on the desktop" +
                (/\.(sit|sea|cpt)$/i.test(file.name) ? " and double-click it — StuffIt Expander is on the disk." : ".");
            }
          } catch (err) {
            status.textContent = "The Macintosh started but the file would not go in: " + err.message;
            if (global.console) console.error("[macemu]", err);
          }
        },
      }).catch(function (err) {
        zone.classList.remove("is-busy");
        status.textContent = "Could not start the emulator: " + err.message;
      });
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
