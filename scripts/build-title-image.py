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
import sys

try:
    import machfs
except ImportError:
    sys.exit("machfs is required: pip install machfs")

FLORIN = "ƒ"


def find_folder(volume, wanted):
    """Match a folder name, tolerating the trailing florin classic Mac uses."""
    candidates = [wanted, wanted + " " + FLORIN, wanted + FLORIN,
                  wanted.rstrip() + " " + FLORIN]
    if wanted.endswith(" f"):
        stem = wanted[:-2]
        candidates += [stem + " " + FLORIN, stem + FLORIN, stem]
    for name in candidates:
        item = volume.get(name)
        if isinstance(item, machfs.Folder):
            return name, item
    available = sorted(n for n, i in volume.items() if isinstance(i, machfs.Folder))
    sys.exit(f"no folder matching {wanted!r}. Volume contains: {available}")


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
    ap.add_argument("--source", required=True, help="image holding the title")
    ap.add_argument("--folder", required=True, help="folder to copy out of --source")
    ap.add_argument("--as", dest="as_name", help="rename the folder on the way in")
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=32, help="output size in MB")
    ap.add_argument("--volume-name", required=True)
    ap.add_argument("--startapp", help='"Folder:App" to launch at boot')
    ap.add_argument("--no-desktopdb", action="store_true",
                    help="skip the Desktop database (the Finder needs it to show the volume)")
    args = ap.parse_args()

    # macOS filesystems are case-insensitive, so --source Maelstrom.img and
    # --out maelstrom.img are the SAME FILE and the build silently eats its own
    # input. Caught the hard way.
    for label, path in (("--base", args.base), ("--source", args.source)):
        if os.path.exists(args.out) and os.path.samefile(path, args.out):
            sys.exit(f"{label} and --out are the same file ({path}). "
                     f"Pick a different output name — note that filenames here are case-insensitive.")
        if os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(args.out)):
            sys.exit(f"{label} and --out resolve to the same path ({args.out}).")

    base = machfs.Volume()
    base.read(open(args.base, "rb").read())
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
    print(f"wrote {args.out}: {len(image)/1048576:.1f} MB, volume {args.volume_name!r}, "
          f"blessed System Folder cnid {blessed}")


if __name__ == "__main__":
    main()
