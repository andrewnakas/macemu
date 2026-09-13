// The drop-your-own-file zone, and the "just give me a Macintosh" button.
//
// On exebrowser.com the equivalent utility pages — "run exe online", "open an
// exe file" — convert at around 27%, several times better than any single game
// page, because somebody searching for a way to open a file has a problem right
// now rather than a passing interest. These pages are the same bet for the Mac
// side, so the emulator has to be the first thing on the page, not a reward for
// reading it.
//
// Division of labour: macbin.js identifies the file from its bytes and strips a
// DiskCopy header when there is one; the runtime mounts and copies. Decoding
// BinHex or expanding StuffIt in JavaScript would be the wrong place for it —
// StuffIt Expander is on the boot disk and reads every one of these formats
// natively, resource forks and Finder metadata included.
//
// The machine is always a Quadra 650 running Basilisk II, whatever era the
// surrounding page is about. That is not arbitrary: Mini vMac has no host file
// sharing at all, so on a Mac Plus the only way in is to mount a disk image.
// Basilisk II exposes a Downloads folder on the desktop, which is what makes
// dropping a .sit work.
(function (global) {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    var mount = document.getElementById("mac-loader");
    if (!mount) return;

    var accepts = (mount.dataset.accepts || "").split(",").filter(Boolean);
    var machine = mount.dataset.machine || "Quadra-650";
    var bootDisk = mount.dataset.disk || "";

    var zone = document.createElement("div");
    zone.className = "dropzone";
    zone.innerHTML =
      '<p class="dz-title">Drop a file here</p>' +
      '<p class="dz-sub">' + (accepts.length ? accepts.join("  ") : "any classic Mac file") + "</p>" +
      '<p class="dz-buttons">' +
      '<button type="button" class="cta-btn dz-pick">Choose a file</button>' +
      (bootDisk ? '<button type="button" class="linklike dz-bare">or just start a Macintosh</button>' : "") +
      "</p>" +
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
    var bare = zone.querySelector(".dz-bare");
    if (bare) bare.addEventListener("click", function () { launch(null, null); });

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
    // keeps a 600 MB CD image from sitting in memory twice before the page can
    // even say what it is.
    var SNIFF = 1024 * 1024;

    function handle(file) {
      status.textContent = "Reading " + file.name + "…";
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
        // identify() only saw the first megabyte, so a large raw image looks
        // like an unrecognised blob. Fall back to the file's real size, which
        // is the only evidence a raw image ever offers.
        if (id.kind === "opaque" && file.size > SNIFF && file.size % 512 === 0 &&
            /\.(img|dsk|hfv|iso|toast|cdr|image|hda)$/i.test(file.name)) {
          id = {
            kind: /\.(iso|toast|cdr)$/i.test(file.name) ? "cdrom" : "disk",
            isFloppy: global.MacBin.FLOPPY_SIZES.has(file.size),
            raw: true,
          };
        }
        describe(id, file);
        launch(id, file);
      };
      reader.readAsArrayBuffer(file.slice(0, Math.min(file.size, SNIFF)));
    }

    function describe(id, file) {
      var what = {
        macbinary: "a MacBinary file — both forks intact",
        binhex: "a BinHex file",
        disk: id.isFloppy ? "a floppy disk image" : "a hard disk image",
        cdrom: "a CD-ROM image",
        opaque: "an archive or a document",
      }[id.kind] || "a file";
      var holding = id.file && id.file.name ? ' holding "' + id.file.name + '"' : "";
      var vol = id.volumeName ? ', volume "' + id.volumeName + '"' : "";
      status.textContent = file.name + " is " + what + holding + vol + ". Starting a Macintosh…";
    }

    var started = false;

    function launch(id, file) {
      if (started) {
        // Two emulators on one page means two machines competing for the CPU
        // and, worse, two writers on the same persistent disk.
        status.textContent = file
          ? "A Macintosh is already running — drop the file onto its screen, or reload to start over."
          : "A Macintosh is already running on this page.";
        return;
      }
      if (!global.MacPlayer) {
        status.textContent = "The emulator did not load. Try reloading the page.";
        return;
      }
      if (!bootDisk) {
        status.textContent = "No system disk is configured on this page yet.";
        return;
      }
      started = true;
      zone.classList.add("is-busy");
      if (!file) status.textContent = "Starting a Macintosh…";

      var isImage = !!id && (id.kind === "disk" || id.kind === "cdrom");
      var opts = {
        machine: machine,
        appName: file ? file.name : "a Macintosh",
        width: 640,
        height: 480,
        // The system disk always boots. A dropped image is mounted beside it,
        // not instead of it — even a bootable image needs something to fall
        // back to, and a non-bootable one would otherwise leave the machine
        // staring at a blinking floppy.
        //
        // Deliberately NOT persistent. The loader is a scratch machine: you
        // bring a file, you look at it, you leave. Mounting the system disk
        // through the origin-private-file-system saver made it fail to boot at
        // all — blinking floppy, no error — and nothing here is worth keeping
        // between visits anyway. Persistence belongs on hosted titles, where a
        // saved game actually matters.
        disks: [{ name: bootDisk }],
        onLoaded: function () {
          zone.classList.remove("is-busy");
          if (!file) {
            status.textContent = "Ready. Drop a file in at any time and it will appear on the desktop.";
          } else if (isImage) {
            status.textContent = "Mounted. Look for it on the desktop.";
          } else {
            status.textContent = 'Copied across. Open the "Downloads" folder on the desktop' +
              (/\.(sit|sea|cpt|hqx|bin)$/i.test(file.name)
                ? " and double-click it — StuffIt Expander is on the disk and reads all of these."
                : ".");
          }
        },
      };

      if (isImage) {
        // A DiskCopy 4.2 header has to come off before the emulator sees the
        // image, or it reads the header as the first sector and calls the disk
        // unreadable. Stripping it means re-wrapping the bytes as a File.
        var payload = file;
        if (id.bytes && !id.raw && id.bytes.length !== file.size) {
          payload = new File([id.bytes], file.name.replace(/\.(dc42|image)$/i, ".img"),
            { type: "application/octet-stream" });
        }
        opts.diskFiles = [{ file: payload, isCDROM: id.kind === "cdrom", isFloppy: !!id.isFloppy }];
      }

      global.MacPlayer.start(stage, opts).then(function (h) {
        if (file && !isImage) {
          return h.uploadFiles([file]).catch(function (err) {
            status.textContent = "The Macintosh started, but the file would not go in: " + err.message;
          });
        }
      }).catch(function (err) {
        started = false;
        zone.classList.remove("is-busy");
        status.textContent = "Could not start the emulator: " + (err && err.message ? err.message : String(err));
      });
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
