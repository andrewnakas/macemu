#!/usr/bin/env python3
"""Turn a folder on a built image into a title disk for the shared system image.

    .venv/bin/python3 scripts/make-title-disk.py \
        --source Images/titles/work-avara-installed.img \
        --folder "Avara 1.0.1 ƒ" --app Avara --slug avara --size 32

The companion to add-from-archive.py's --title-disk, for software that had to be
installed inside the emulated Mac rather than copied off a disc. See
scripts/author-disk.mjs for how the installed folder gets here.

Everything in the folder comes across, not just the application: the Ambrosia
shareware licence these titles ship under permits redistribution only when the
software is unmodified and "the complete works" are included, so the
documentation and extras travel with the game.
"""
import argparse
import sys
import os
from importlib.machinery import SourceFileLoader

try:
    import machfs
except ImportError:
    sys.exit("machfs is required: pip install machfs")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="image holding the installed folder")
    ap.add_argument("--folder", help="folder on that image to take")
    ap.add_argument("--from-folder", dest="from_folder",
                    help="a host directory to read instead of --source, for the many "
                         "titles that ship as a plain folder and need no installer run")
    ap.add_argument("--app", required=True, help="the application inside it to launch")
    ap.add_argument("--slug", required=True)
    ap.add_argument("--size", type=int, default=32, help="output size in MB")
    ap.add_argument("--shared-base", default="Images/system/macos8-shared.img",
                    help="read only for its volume creation date, which the alias must match")
    args = ap.parse_args()

    if args.from_folder:
        # build-title-image.py already knows how to read a host folder with its
        # resource forks intact (macOS keeps them at <file>/..namedfork/rsrc).
        here = os.path.dirname(os.path.abspath(__file__))
        bti = SourceFileLoader("bti", os.path.join(here, "build-title-image.py")).load_module()
        shared_peek = machfs.Volume()
        shared_peek.read(open(args.shared_base, "rb").read())
        folder = bti.read_native_folder(args.from_folder, shared_peek.crdate)
    else:
        if not args.source or not args.folder:
            sys.exit("give either --from-folder, or both --source and --folder")
        src = machfs.Volume(); src.read(open(args.source, "rb").read())
        folder = src
        for part in args.folder.split(":"):
            folder = folder[part]
    if args.app not in folder:
        sys.exit(f"{args.app!r} is not in {args.folder!r}; it holds {sorted(folder.keys())}")

    shared = machfs.Volume(); shared.read(open(args.shared_base, "rb").read())
    t = machfs.Volume()
    t.name = "Title"
    t.crdate = t.mddate = t.bkdate = shared.crdate   # the alias matches on this
    t["Start App"] = folder[args.app]                # first, so its cnid is fixed
    alias = machfs.File()
    alias.aliastarget = t["Start App"]
    alias.crdate = alias.mddate = alias.bkdate = t.crdate
    t["Start"] = alias
    kept = 0
    for name, item in folder.items():
        # Some archives carry files whose names are nothing but tabs or spaces —
        # an easter egg on a few discs, junk from the unpacker on others. They
        # are invisible clutter on a 1999 desktop either way.
        if not name.strip():
            continue
        if name in (args.app, "Start", "Start App") or name.strip().lower() == "icon":
            continue
        t[name] = item
        kept += 1

    out = f"Images/titles/title-{args.slug}.img"
    os.makedirs("Images/titles", exist_ok=True)
    image = t.write(args.size * 1024 * 1024, align=512, desktopdb=True, bootable=False)
    assert image[1024:1026] == b"BD", "not an HFS volume"
    open(out, "wb").write(image)
    print(f"wrote {out}: {len(image) / 1048576:.0f} MB, launching {args.app!r} "
          f"with {kept} item(s) beside it")
    print(f"\nnext:\n  node scripts/chunk-disk.mjs {out} {args.slug}-title --name \"{args.app}\"")


if __name__ == "__main__":
    main()
