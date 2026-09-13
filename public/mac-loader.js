// The drop-your-own-file zone.
//
// Turns <div id="mac-loader" data-accepts="…"> into a dropzone that works out
// what the visitor gave it, boots a Macintosh, and hands the file over. On
// exebrowser.com the equivalent utility pages — "run exe online", "open an exe
// file" — convert at around 27%, several times better than any single game
// page, because somebody searching for a way to open a file has a problem right
// now rather than a passing interest.
//
// Division of labour: macbin.js identifies the file from its bytes and strips a
// DiskCopy header when there is one; the emulator runtime does the actual
// mounting and copying. Decoding BinHex or expanding StuffIt in JavaScript
// would be the wrong place to do it — StuffIt Expander is sitting on the boot
// disk and reads every one of these formats natively, resource forks included.
(function (global) {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    var mount = document.getElementById("mac-loader");
    if (!mount) return;

    var accepts = (mount.dataset.accepts || "").split(",").filter(Boolean);
    var machine = mount.dataset.machine || "Quadra-650";
    var compact = machine === "Mac-Plus" || machine === "Mac-SE";

    var zone = document.createElement("div");
    zone.className = "dropzone";
    zone.innerHTML =
      '<p class="dz-title">Drop a file here</p>' +
      '<p class="dz-sub">' + (accepts.length ? accepts.join("  ") : "any classic Mac file") + "</p>" +
      '<button type="button" class="cta-btn dz-pick">Choose a file</button>' +
      '<p class="dz-note muted small">It is read on your own computer. Nothing is uploaded.</p>';
    var input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    if (accepts.length) input.accept = accepts.join(",");
    zone.appendChild(input);

    var status = document.createElement("p");
    status.className = "dz-status muted small";
    status.setAttribute("role", "status");

    var stage = document.createElement("div");
    stage.className = "dz-stage";

    mount.appendChild(zone);
    mount.appendChild(status);
    mount.appendChild(stage);

    zone.querySelector(".dz-pick").addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) handle(input.files[0]);
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("is-over"); });
    });
    zone.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handle(f);
    });

    // Reading only the head is enough to identify every format here, and it
    // means a 600 MB CD image does not have to sit in memory twice before the
    // page can even say what it is.
    var SNIFF = 1024 * 1024;

    function handle(file) {
      status.textContent = "Reading " + file.name + "…";
      var head = file.slice(0, Math.min(file.size, SNIFF));
      var reader = new FileReader();
      reader.onerror = function () { status.textContent = "Could not read that file."; };
      reader.onload = function () {
        var id;
        try {
          id = global.MacBin.identify(new Uint8Array(reader.result), file.name);
        } catch (err) {
          status.textContent = "That looks like a Macintosh file, but it would not decode: " +
            err.message + " It was probably truncated or mangled in transit.";
          return;
        }
        // identify() only saw the first megabyte, so a large raw image can look
        // like an unrecognised blob. Fall back to the file's real size, which
        // is the only evidence a raw image ever offers.
        if (id.kind === "opaque" && file.size > SNIFF && file.size % 512 === 0 && /\.(img|dsk|hfv|iso|toast|cdr|image|hda)$/i.test(file.name)) {
          id = { kind: /\.(iso|toast|cdr)$/i.test(file.name) ? "cdrom" : "disk",
                 isFloppy: global.MacBin.FLOPPY_SIZES.has(file.size), raw: true };
        }
        describe(id, file);
        launch(id, file);
      };
      reader.readAsArrayBuffer(head);
    }

    function describe(id, file) {
      var what = {
        macbinary: "a MacBinary file — both forks intact",
        binhex: "a BinHex file",
        disk: id.isFloppy ? "a floppy disk image" : "a hard disk image",
        cdrom: "a CD-ROM image",
        opaque: "an archive or a document",
      }[id.kind] || "a file";
      var extra = id.file && id.file.name ? ' holding "' + id.file.name + '"' : "";
      var vol = id.volumeName ? ', volume "' + id.volumeName + '"' : "";
      status.textContent = file.name + " is " + what + extra + vol + ". Starting a Macintosh…";
    }

    function launch(id, file) {
      if (!global.MacPlayer) {
        status.textContent = "The emulator did not load. Try reloading the page.";
        return;
      }
      zone.classList.add("is-busy");

      var opts = {
        machine: machine,
        appName: file.name,
        // Mini vMac's screen is fixed by the machine it emulates; Basilisk II
        // and SheepShaver take whatever they are given.
        width: compact ? 512 : 640,
        height: compact ? 342 : 480,
        onLoaded: function () {
          status.textContent = (id.kind === "disk" || id.kind === "cdrom")
            ? "Mounted. Look for it on the desktop."
            : 'Copied across. Open the "Downloads" folder on the desktop' +
              (/\.(sit|sea|cpt|hqx|bin)$/i.test(file.name)
                ? " and double-click it — StuffIt Expander is on the disk and reads all of these."
                : ".");
        },
      };

      if (id.kind === "disk" || id.kind === "cdrom") {
        // A DiskCopy 4.2 header has to come off before the emulator sees the
        // image, or it reads the header as the first sector and calls the disk
        // unreadable. Stripping it means re-wrapping the bytes as a File.
        var payload = file;
        if (id.bytes && !id.raw && id.bytes.length !== file.size) {
          payload = new File([id.bytes], file.name.replace(/\.(dc42|image)$/i, ".img"),
            { type: "application/octet-stream" });
        }
        opts.diskFiles = [{ file: payload, isCDROM: id.kind === "cdrom", isFloppy: !!id.isFloppy }];
        // A disk with a System Folder can boot on its own; one without needs a
        // system disk underneath it or there is nothing to mount it into.
        opts.disks = [];
      }

      global.MacPlayer.start(stage, opts).then(function (h) {
        if (id.kind !== "disk" && id.kind !== "cdrom") {
          return h.uploadFiles([file]).catch(function (err) {
            status.textContent = "The Macintosh started, but the file would not go in: " + err.message;
          });
        }
      }).catch(function (err) {
        zone.classList.remove("is-busy");
        status.textContent = "Could not start the emulator: " + (err && err.message ? err.message : String(err));
      });
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
