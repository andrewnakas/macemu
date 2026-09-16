#!/usr/bin/env python3
"""Build a per-title boot disk: the base System install plus one application.

    python3 scripts/build-title-image.py \
        --base Images/system/hd1.img \
        --source Images/titles/Maelstrom.img \
        --folder "Maelstrom 1.4.3 f" \
        --as "Maelstrom" \
        --startapp "Maelstrom:Maelstrom" \
        --out Images/titles/maelstrom.img \
        --size 32 --volume-name "Maelstrom"

Needs machfs (`pip install machfs`), the same library Infinite Mac uses for its
own disk authoring. Everything else in this repo is zero-dependency Node; this
one step is Python because reading and writing HFS volumes properly — resource
forks, type and creator codes, the blessed System Folder, the boot blocks — is
not worth reimplementing.

WHY THIS EXISTS

A title page can only promise instant play if there is a disk that boots
straight into the game. Building one by hand means running an installer inside
the emulator and exporting the result, which is slow and unrepeatable. This does
it from the two images we already have: the System install, and whatever disk
the game was preserved on.

A note on storage, because the obvious guess is wrong. Content-addressed
chunking does NOT make a title cheap: machfs rewrites the entire volume when it
saves, so the allocation blocks move and a per-title image shares essentially
zero chunks with the base it was built from. Budget the full image size per
title — about 20 MB here — not the size of the game.

NOTES THAT WILL SAVE YOU AN HOUR

* `--startapp` sets the volume's startup application, which is how the Finder
  knows to launch something at boot. Give it a colon-separated path INSIDE the
  volume, e.g. "Maelstrom:Maelstrom" for the app "Maelstrom" in the folder
  "Maelstrom". Omit it to boot to the desktop instead.
* Folder names on classic Mac disks often end in the florin character. Pass
  --folder with a plain "f" and this will match the florin form too, because
  typing it is a nuisance.
* The output volume name becomes the manifest name you chunk it under, and that
  name keys the emulator's persistent storage. Change the image, change the
  name — see the comment in scripts/chunk-disk.mjs.
"""
import argparse
import os
import subprocess
import sys

try:
    import machfs
except ImportError:
    sys.exit("machfs is required: pip install machfs")

FLORIN = "ƒ"


# The classic Mac counts seconds from 1 January 1904; Unix counts from 1970.
MAC_EPOCH_OFFSET = 2082844800


def mac_time(unix_seconds, fallback):
    """A host mtime as a classic Mac timestamp, or `fallback` if it predates 1904."""
    t = int(unix_seconds) + MAC_EPOCH_OFFSET
    return t if t > 0 else fallback


def read_native_folder(host_path, date):
    """Import a folder from the host filesystem into a machfs.Folder.

    macOS keeps a file's resource fork and Finder metadata as extended
    attributes, reachable as `<file>/..namedfork/rsrc` and the FinderInfo
    xattr. machfs's own read_folder() expects the MPW convention instead —
    `.rdump` and `.idump` sidecar files — so it silently imports every
    application as a data fork with no code in it, which produces a volume full
    of files the Finder shows as generic documents and refuses to open.

    This reads the native forks, which is what `unar` writes when it expands a
    StuffIt archive on a Mac.
    """
    folder = machfs.Folder()
    folder.crdate = folder.mddate = folder.bkdate = mac_time(os.path.getmtime(host_path), date)
    for name in sorted(os.listdir(host_path)):
        if name.startswith("."):
            continue                      # .DS_Store and friends
        full = os.path.join(host_path, name)
        if os.path.isdir(full):
            folder[name] = read_native_folder(full, date)
            continue

        f = machfs.File()
        # Every file needs a plausible date. machfs defaults them to 0, which is
        # 1 January 1904, and a volume full of files from 1904 stops the Finder
        # dead while it builds the desktop database at boot: the machine shows a
        # grey screen forever, with no error from the emulator, no failed
        # request, and a disk that reads normally. That cost an evening.
        f.crdate = f.mddate = f.bkdate = mac_time(os.path.getmtime(full), date)
        with open(full, "rb") as fh:
            f.data = fh.read()
        rsrc_path = full + "/..namedfork/rsrc"
        if os.path.exists(rsrc_path):
            with open(rsrc_path, "rb") as fh:
                f.rsrc = fh.read()
        try:
            words = subprocess.run(
                ["xattr", "-px", "com.apple.FinderInfo", full],
                capture_output=True, text=True, check=True).stdout.split()
            if len(words) >= 8:
                raw = bytes(int(w, 16) for w in words[:8])
                f.type, f.creator = raw[:4], raw[4:8]
        except Exception:
            pass
        # A Desktop database copied from the host is stale the moment it lands
        # on a volume with different file ids; the writer builds a fresh one.
        if name in ("Desktop DB", "Desktop DF"):
            continue
        folder[name] = f
    return folder


def _match_one(parent, wanted):
    """One path segment, tolerating the trailing florin classic Mac uses."""
    candidates = [wanted, wanted + " " + FLORIN, wanted + FLORIN,
                  wanted.rstrip() + " " + FLORIN]
    if wanted.endswith(" f"):
        stem = wanted[:-2]
        candidates += [stem + " " + FLORIN, stem + FLORIN, stem]
    for name in candidates:
        item = parent.get(name)
        if isinstance(item, machfs.Folder):
            return name, item
    return None, None


def find_folder(volume, wanted):
    """Find a folder by name, or by a colon-separated path into the volume.

    Shareware CDs file their contents several folders deep — Games:Arcade:Arashi
    1.1 — so matching only at the root finds nothing on exactly the sources that
    carry the most titles.
    """
    parts = wanted.split(":")
    parent, found_name, found = volume, None, None
    for depth, part in enumerate(parts):
        found_name, found = _match_one(parent, part)
        if found is None:
            where = ":".join(parts[:depth]) or "the volume root"
            available = sorted(n for n, i in parent.items() if isinstance(i, machfs.Folder))
            sys.exit(f"no folder matching {part!r} in {where}. Contains: {available[:24]}")
        parent = found
    return found_name, found


def count(folder):
    files = dirs = size = 0
    for name, item in folder.items():
        if isinstance(item, machfs.Folder):
            dirs += 1
            f, d, s = count(item)
            files += f; dirs += d; size += s
        else:
            files += 1
            size += len(item.data) + len(item.rsrc)
    return files, dirs, size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="bootable System image")
    ap.add_argument("--source", help="image holding the title")
    ap.add_argument("--from-folder", help="host directory to import instead of --source")
    ap.add_argument("--folder", help="folder to copy out of --source")
    ap.add_argument("--as", dest="as_name", help="rename the folder on the way in")
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=32, help="output size in MB")
    ap.add_argument("--volume-name", required=True)
    ap.add_argument("--startapp", help='"Folder:App" to launch at boot')
    ap.add_argument("--no-desktopdb", action="store_true",
                    help="skip the Desktop database (the Finder needs it to show the volume)")
    ap.add_argument("--no-startup-alias", action="store_true",
                    help="do not put an alias to --startapp in System Folder:Startup Items")
    args = ap.parse_args()

    # macOS filesystems are case-insensitive, so --source Maelstrom.img and
    # --out maelstrom.img are the SAME FILE and the build silently eats its own
    # input. Caught the hard way.
    for label, path in (("--base", args.base), ("--source", args.source)):
        if not path:
            continue
        if os.path.exists(args.out) and os.path.samefile(path, args.out):
            sys.exit(f"{label} and --out are the same file ({path}). "
                     f"Pick a different output name — note that filenames here are case-insensitive.")
        if os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(args.out)):
            sys.exit(f"{label} and --out resolve to the same path ({args.out}).")

    base = machfs.Volume()
    base.read(open(args.base, "rb").read())

    if args.from_folder:
        found_name = os.path.basename(args.from_folder.rstrip("/"))
        # Anything without a usable host mtime inherits the volume's own date,
        # which is always sane because it came off a real disk image.
        folder = read_native_folder(args.from_folder, base.crdate)
    else:
        if not args.source or not args.folder:
            sys.exit("give either --from-folder, or both --source and --folder")
        source = machfs.Volume()
        source.read(open(args.source, "rb").read())
        found_name, folder = find_folder(source, args.folder)
    dest_name = args.as_name or found_name
    files, dirs, size = count(folder)
    print(f"copying {found_name!r} -> {dest_name!r}: {files} files, {dirs} folders, "
          f"{size/1048576:.2f} MB of forks")

    if dest_name in base:
        sys.exit(f"{dest_name!r} already exists on the base image")
    base[dest_name] = folder
    base.name = args.volume_name

    startapp = None
    if args.startapp:
        startapp = args.startapp.split(":")
        probe = base
        for part in startapp[:-1]:
            probe = probe.get(part)
            if not isinstance(probe, machfs.Folder):
                sys.exit(f"--startapp path {args.startapp!r}: {part!r} is not a folder")
        app = probe.get(startapp[-1])
        if app is None:
            sys.exit(f"--startapp path {args.startapp!r}: {startapp[-1]!r} not found")
        if app.type != b"APPL":
            sys.exit(f"--startapp target {startapp[-1]!r} has type "
                     f"{app.type.decode('mac_roman', 'replace')!r}, not APPL")
        print(f"startup application: {args.startapp}")

    # Belt and braces for auto-launch. `startapp` sets the volume's startup
    # application in the Finder's own record, but that alone has been seen to
    # boot to the desktop instead — the Finder rebuilds its preferences on a
    # freshly written volume and the setting does not always survive. An alias
    # in System Folder:Startup Items is the mechanism a person would use by
    # hand, and it is honoured unconditionally.
    if startapp and not args.no_startup_alias:
        sys_folder = base.get("System Folder")
        if not isinstance(sys_folder, machfs.Folder):
            sys.exit("no System Folder on the base image — cannot install a startup alias")
        items = sys_folder.get("Startup Items")
        if not isinstance(items, machfs.Folder):
            items = machfs.Folder()
            sys_folder["Startup Items"] = items
        target = base
        for part in startapp:
            target = target[part]
        alias = machfs.File()
        # machfs resolves aliastarget by OBJECT IDENTITY (it keys an internal
        # dict on id(obj)), not by path. Handing it a tuple of names looks
        # plausible, resolves to nothing, and the alias is dropped from the
        # written volume without a word — Startup Items ends up empty and the
        # machine boots to the desktop.
        alias.aliastarget = target
        alias.crdate = alias.mddate = target.crdate
        alias_name = startapp[-1]
        if len(alias_name) > 27:
            alias_name = alias_name[:27]
        items[alias_name + " alias"] = alias
        print(f"startup alias: System Folder:Startup Items:{alias_name} alias")

    total = args.size * 1024 * 1024
    # The Desktop database is not optional in practice. Written without one, the
    # volume boots but the Finder will not show it on the desktop and reports
    # that the disk "cannot be found" when anything refers to it by name.
    image = base.write(total, align=512, desktopdb=not args.no_desktopdb,
                       bootable=True, startapp=startapp)
    open(args.out, "wb").write(image)

    # Fail loudly rather than shipping an image that mounts but will not boot.
    mdb = 1024
    assert image[0:2] == b"LK", "boot blocks are missing — the volume will not boot"
    assert image[mdb:mdb+2] == b"BD", "not an HFS volume"
    blessed = int.from_bytes(image[mdb+92:mdb+96], "big")
    assert blessed, "no blessed System Folder — the Mac will show a blinking floppy"

    # Re-read what was written and refuse to ship a file dated 1904.
    check = machfs.Volume()
    check.read(image)
    def undated(folder, prefix=""):
        bad = []
        for name, item in folder.items():
            path = prefix + name
            if isinstance(item, machfs.Folder):
                bad += undated(item, path + ":")
            elif not item.crdate:
                bad.append(path)
        return bad
    stale = undated(check)
    if stale:
        sys.exit(f"{len(stale)} file(s) have no creation date, e.g. {stale[:3]}. "
                 f"The Finder hangs at boot on a volume like this.")
    print(f"wrote {args.out}: {len(image)/1048576:.1f} MB, volume {args.volume_name!r}, "
          f"blessed System Folder cnid {blessed}")


if __name__ == "__main__":
    main()
