#!/usr/bin/env python3
"""Turn a preserved floppy set at the Internet Archive into a bootable title.

    python3 scripts/add-from-archive.py LodeRunner_v10_4amMacCrack lode-runner \
        --volume-name "Lode Runner"

Downloads the item's `00playable*.dc42` images, strips the DiskCopy headers,
finds the application across them, and builds a System 7.5.3 boot disk with a
Startup Items alias so it launches by itself.

WHY THIS EXISTS

Doing it by hand takes a dozen steps and I got several of them wrong at least
once: the DiskCopy header has to come off or the Mac calls the disk unreadable;
the application is usually on disk two while disk one is just a boot floppy;
and an application sitting at a volume root has to be wrapped in a folder before
it can be copied. Each of those is now done here rather than remembered.

It stops before writing any page copy. Deciding whether a title may be hosted,
and writing notices/<slug>.md, is the part that must not be automated.
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import urllib.request

try:
    import machfs
except ImportError:
    sys.exit("machfs is required: pip install machfs")

UA = {"User-Agent": "macemu-import/1.0"}

# Types the Finder will open in an editor if they are in Startup Items. A
# readme sitting beside the game is harmless in a folder and, in Startup Items,
# launches SimpleText on top of the running game.
DOCUMENT_TYPES = (b"TEXT", b"ttro", b"PICT", b"MooV", b"GIFf", b"WORD")


# LAUNCHING A TITLE AT BOOT: TWO WAYS, AND WHEN EACH BREAKS
#
# An alias in System Folder:Startup Items launches the application, and for most
# titles that is the end of it. But an application launched from an alias
# resolves "the folder I am in" to Startup Items, not to where it actually
# lives, so anything it expects to find beside itself is missing. That failure
# never says so plainly:
#
#   Glider PRO  -> "There are no houses on this drive!"
#   SimCity 1.2 -> "File IO Error-39"
#
# Both files were present, in the right folder, with the right types.
#
# The fix is to stop pretending: put the application AND its data files
# directly into Startup Items. The app launches, and "beside itself" is then
# true. SimCity goes from an error dialog to its full scenario picker.
#
# So: --in-startup-items for any title that reads data files from its own
# folder, and the alias for self-contained ones. The way to tell is to boot it
# and look.



def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"  cached {os.path.basename(dest)}")
        return dest
    print(f"  fetching {os.path.basename(dest)}")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def strip_dc42(raw):
    """Remove a DiskCopy 4.2 header, if there is one, and return the raw disk."""
    if len(raw) > 84 and struct.unpack(">H", raw[0x52:0x54])[0] == 0x0100:
        length = struct.unpack(">I", raw[0x40:0x44])[0]
        return raw[84:84 + length]
    return raw


# A System Folder on a game floppy is the machine that booted it, not part of
# the game. Copying one onto a disk that already has a System Folder gives the
# Mac two, which it does not enjoy.
SYSTEM_FOLDER_NAMES = ("system folder", "512ke system", "system", "boot")


def is_system_folder(name, folder):
    if name.strip().lower() in SYSTEM_FOLDER_NAMES:
        return True
    return any(getattr(i, "type", b"") == b"ZSYS" for i in folder.values())


def find_app(volume):
    """The application on a volume, wherever it is. Returns (path, File)."""
    best = None
    def walk(folder, path):
        nonlocal best
        for name, item in folder.items():
            here = path + [name]
            if isinstance(item, machfs.Folder):
                if is_system_folder(name, item):
                    continue
                walk(item, here)
            elif item.type == b"APPL":
                # The biggest application is the game; the small ones are
                # installers, readers and "Double Click to Read" stubs.
                size = len(item.data) + len(item.rsrc)
                if best is None or size > best[2]:
                    best = (here, item, size)
    walk(volume, [])
    return (best[0], best[1]) if best else (None, None)


def siblings_of(volume, app_path):
    """Everything that lives beside the application, minus the boot system.

    Copying the application alone is not enough and fails in a way that looks
    like a disk fault rather than a missing file: SimCity ships a `scenario`
    data file next to the binary, and without it the game launches, reads past
    the end of a file that is not there, and puts up "File IO Error-39".
    """
    parent = volume
    for part in app_path[:-1]:
        parent = parent[part]
    out = {}
    for name, item in parent.items():
        if name == app_path[-1]:
            continue
        if isinstance(item, machfs.Folder) and is_system_folder(name, item):
            continue
        out[name] = item
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("item", help="Internet Archive identifier")
    ap.add_argument("slug", help="macemu slug, used for file names")
    ap.add_argument("--volume-name", required=True)
    ap.add_argument("--size", type=int, default=32, help="output image size in MB")
    ap.add_argument("--base", default="Images/system/hd1.img")
    ap.add_argument("--folder-name", help="what to call the folder on the boot disk")
    ap.add_argument("--in-startup-items", action="store_true",
                    help="put the application and its data straight into Startup Items "
                         "so it can find files beside itself (see the note at the top)")
    ap.add_argument("--app-only", action="store_true",
                    help="copy only the application, not the files beside it (see the note on --app-only)")
    args = ap.parse_args()

    os.makedirs("Images/titles", exist_ok=True)
    meta_url = f"https://archive.org/metadata/{args.item}"
    with urllib.request.urlopen(urllib.request.Request(meta_url, headers=UA), timeout=120) as r:
        meta = json.load(r)
    names = [f["name"] for f in meta.get("files", [])
             if f["name"].startswith("00playable") and f["name"].endswith(".dc42")]
    if not names:
        sys.exit(f"{args.item} has no 00playable*.dc42 images")
    print(f"{args.item}: {len(names)} playable image(s)")

    app_path = app = app_volume = None
    for name in sorted(names):
        local = f"Images/titles/src-{args.slug}-{name}"
        fetch(f"https://archive.org/download/{args.item}/{urllib.parse.quote(name)}", local)
        raw = strip_dc42(open(local, "rb").read())
        if raw[1024:1026] != b"BD":
            # MFS, the 1984 filesystem used on 400K single-sided floppies.
            # machfs reads HFS only, and the titles still on MFS are the very
            # earliest ones — Lode Runner, MacGolf, Chessmaster 2000.
            kind = "MFS (400K, pre-1986)" if raw[1024:1026] == b"\xd2\xd7" else f"unknown {raw[1024:1026]!r}"
            print(f"    {name}: {kind}, cannot read — skipped")
            continue
        v = machfs.Volume(); v.read(raw)
        path, found = find_app(v)
        if found is None:
            print(f"    {name}: no application (probably the boot floppy)")
            continue
        size = len(found.data) + len(found.rsrc)
        print(f"    {name}: {':'.join(path)} ({size // 1024} KB)")
        if app is None or size > len(app.data) + len(app.rsrc):
            app_path, app, app_volume = path, found, v
    if app is None:
        sys.exit("no application found on any disk")

    app_name = app_path[-1]
    folder_name = args.folder_name or args.volume_name
    base = machfs.Volume(); base.read(open(args.base, "rb").read())
    folder = machfs.Folder()
    folder.crdate = folder.mddate = folder.bkdate = base.crdate
    folder[app_name] = app
    # Copying the whole folder is usually right, and occasionally wrong in a way
    # that is hard to guess at. SimCity 1.2 ships a `scenario` file beside the
    # binary with a null type and creator; copy it across and the game launches
    # and immediately puts up "File IO Error-39", while the application on its
    # own runs perfectly. Presumably it is a fragment the original installer
    # would have finished writing. So --app-only exists, and the way you find
    # out which you need is to boot it and look.
    extras = {} if args.app_only else siblings_of(app_volume, app_path)
    for name, item in extras.items():
        folder[name] = item
    if extras:
        print(f"  also copied: {', '.join(sorted(extras))}")
    elif args.app_only:
        print("  --app-only: nothing copied beside the application")
    if folder_name in base:
        sys.exit(f"{folder_name!r} already exists on the base image")
    base[folder_name] = folder
    base.name = args.volume_name

    sysf = base["System Folder"]
    items = sysf.get("Startup Items")
    if not isinstance(items, machfs.Folder):
        items = machfs.Folder(); sysf["Startup Items"] = items

    if args.in_startup_items:
        launched, kept = {}, {}
        for name, item in folder.items():
            if isinstance(item, machfs.Folder) or item.type not in DOCUMENT_TYPES:
                launched[name] = item
            else:
                kept[name] = item
        for name, item in launched.items():
            items[name] = item
        if kept:
            leftovers = machfs.Folder()
            leftovers.crdate = leftovers.mddate = leftovers.bkdate = base.crdate
            for name, item in kept.items():
                leftovers[name] = item
            base[folder_name] = leftovers
            print(f"  left on the desktop: {', '.join(sorted(kept))}")
        else:
            del base[folder_name]
        print(f"  launching from Startup Items: {', '.join(sorted(launched))}")
    else:
        alias = machfs.File()
        alias.aliastarget = app      # resolved by object identity, not by path
        alias.crdate = alias.mddate = alias.bkdate = app.crdate or base.crdate
        items[app_name[:27] + " alias"] = alias

    out = f"Images/titles/boot-{args.slug}.img"
    # machfs's startapp corrupts the volume for some names; the alias is enough.
    image = base.write(args.size * 1024 * 1024, align=512, desktopdb=True, bootable=True)
    assert image[0:2] == b"LK", "boot blocks missing"
    assert image[1024:1026] == b"BD", "not an HFS volume"
    blessed = struct.unpack(">I", image[1024 + 92:1024 + 96])[0]
    assert blessed, "no blessed System Folder"
    open(out, "wb").write(image)
    print(f"\nwrote {out}: {len(image) / 1048576:.0f} MB, volume {args.volume_name!r}, "
          f"launches {app_name!r}")
    print(f"\nnext:\n  node scripts/chunk-disk.mjs {out} {args.slug}-v1 --name \"{args.volume_name} v1\"")
    print(f"  write notices/{args.slug}.md, then add the catalogue entry")


if __name__ == "__main__":
    import urllib.parse
    main()
