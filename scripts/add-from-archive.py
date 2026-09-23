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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mfs          # the 1984 filesystem machfs does not read
import partitions   # the Apple Partition Map inside a Mac or hybrid CD

UA = {"User-Agent": "macemu-import/1.0"}

# Types the Finder will open in an editor if they are in Startup Items. A
# readme sitting beside the game is harmless in a folder and, in Startup Items,
# launches SimpleText on top of the running game.
DOCUMENT_TYPES = (b"TEXT", b"ttro", b"PICT", b"MooV", b"GIFf", b"WORD")

# A floppy's own System and Finder belong to the machine that booted it, not to
# the title, and the boot disk already has better ones. Other files of the same
# type are drivers the title may genuinely need — Reader Rabbit talks through
# MacinTalk, which is also type ZSYS — so those are filed in the System Folder
# rather than dropped or, worse, left in Startup Items for the Finder to open
# at boot.
BOOT_FILE_NAMES = ("system", "finder", "desktop")

# Litter left by the modern Mac that made the disk image, not by the title.
# A dot-file means nothing to System 7 and everything to the Finder that wrote
# it, and "Icon\r" is how macOS stores a custom folder icon. Copying them
# across puts invisible junk on a 1987 desktop.
HOST_LITTER = (".ds_store", ".trashes", ".fseventsd", ".spotlight-v100",
               ".apiddisk", ".vol", "icon\r", ".hidden")


def is_host_litter(name):
    n = name.strip().lower()
    return n in HOST_LITTER or n.startswith("._")
SYSTEM_FOLDER_TYPES = (b"ZSYS", b"FNDR", b"INIT", b"cdev", b"scri", b"appe",
                       b"PRES", b"PRER", b"RDEV")   # printer and chooser drivers


def split_off_system_files(items):
    """(what the title keeps, what goes in the System Folder). Drops the boot files."""
    keep, system = {}, {}
    for name, item in items.items():
        if is_host_litter(name):
            print(f"  dropped {name!r}: litter from the Mac that imaged the disk")
        elif isinstance(item, machfs.Folder) or item.type not in SYSTEM_FOLDER_TYPES:
            keep[name] = item
        elif name.strip().lower() in BOOT_FILE_NAMES:
            print(f"  dropped {name!r}: the source floppy's own boot file")
        else:
            system[name] = item
    return keep, system


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


def find_app(volume, wanted=None):
    """The application on a volume, wherever it is. Returns (path, File).

    Size picks the winner, because the small applications beside a game are
    installers, readers and "Double Click to Read" stubs. Except when it does
    not: Shanghai's floppy holds `Shanghai` at 15K and `P1` at 89K, and P1 is
    the second half of the same program, launched by the first. Starting P1
    directly gets you a board with no game around it. So a name that matches
    the volume wins over a bigger one, which is how a person picking by eye
    would do it too.
    """
    best = named = None
    stem = (wanted or volume.name or "").split(":")[-1].split()
    stem = stem[0].lower() if stem else ""
    def walk(folder, path):
        nonlocal best, named
        for name, item in folder.items():
            here = path + [name]
            if isinstance(item, machfs.Folder):
                if is_system_folder(name, item):
                    continue
                walk(item, here)
            elif item.type == b"APPL":
                size = len(item.data) + len(item.rsrc)
                if best is None or size > best[2]:
                    best = (here, item, size)
                # --app takes a bare name or a full colon path, because a disc
                # can carry the same application twice: the Marathon 2 CD has
                # "Marathon 2" in both "Marathon 2 Small Install" and
                # "Marathon 2 \u0192", and only the second has the full game
                # beside it.
                here_path = ":".join(here).lower()
                if wanted and (name.lower() == wanted.lower()
                               or here_path == wanted.lower()
                               or here_path.endswith(":" + wanted.lower())):
                    named = (here, item, size)
                elif stem and name.lower().startswith(stem) and named is None:
                    named = (here, item, size)
    walk(volume, [])
    if named and best and named[0] != best[0]:
        print(f"    picking {':'.join(named[0])} over the larger "
              f"{':'.join(best[0])}: it matches the volume name")
        best = named
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


# SHARED SYSTEM DISKS
#
# A Mac OS 8 title used to cost about 180 MB, nearly all of it a second copy of
# Mac OS 8, because building it rewrote the whole 500 MB volume and machfs does
# not preserve where file data sits — adding one five-byte file leaves only 163
# of 678 non-empty chunks intact. Content-addressed chunking, which would make
# the duplication free, has nothing to match.
#
# --title-disk builds the game on a disk of its own instead, to be mounted after
# a shared system image that is byte identical for every title. The visitor
# downloads the operating system once.
#
# Launching it needs one trick. The shared image cannot hold a title-specific
# alias, so it holds a generic one pointing at "Title:Start", and every title
# disk is built to match it: the same volume name, the same volume creation date
# as the shared image, the application created first so its catalogue id is
# always the same, and an alias named "Start" beside it. One alias in the shared
# image therefore resolves on every title disk.
#
# machfs writes an alias without kIsAlias set and the Finder ignores it, so the
# bit is set by hand — the same trap Reader Rabbit's application shipped with,
# in reverse.


# SELF-BOOTING DISKS, AND WHY A TITLE SOMETIMES NEEDS ONE
#
# Most titles are happiest copied onto a System 7.5.3 hard disk. Some are not,
# and they do not say so politely: Rogue and Shanghai reset the machine, and
# Beyond Dark Castle comes up to a black screen and stays there.
#
# Those titles shipped on disks that carry their own System, from the era they
# were written for. Booting that instead of ours fixes them. The only piece
# missing is the launch: a 1987 disk has no Startup Items folder, because that
# is a System 7 idea. What it has is a field in the boot blocks naming the
# program the machine should start — normally "Finder", and on a self-booting
# game disk the game itself. Rogue's disk says "Rogue" there. So we write the
# title's name into the same field and the machine comes up in the game.
SHELL_OFFSET = 0x1A          # boot block: the program the Finder's job is given to
STARTUP_OFFSET = 0x5A        # boot block: the startup program


# The boot-block name field is a Str15: one length byte and fifteen characters,
# with no way to say more. A longer name used to be truncated here, which built
# a disk that looked right and booted to "Can't load the finder!" — the ROM was
# asking the volume for "Balance of Powe", which is not a file that exists.
# Silently producing that is worse than refusing, so the truncation now happens
# once, deliberately, by renaming the application on the volume to the name the
# boot blocks can actually hold. Nobody sees the shortened name: these disks
# come up in the game without ever drawing a Finder.
BOOT_NAME_MAX = 15


def fit_boot_name(vol, app_name):
    """Return a name for `app_name` that fits the boot blocks, renaming if needed."""
    if len(app_name.encode("mac_roman")) <= BOOT_NAME_MAX:
        return app_name
    stem = app_name
    while len(stem.encode("mac_roman")) > BOOT_NAME_MAX:
        stem = stem[:-1]
    stem = stem.rstrip()
    # Two long names could shorten onto each other, or onto something already
    # on the disk. Walk a digit in from the end until the name is free.
    candidate, n = stem, 1
    while candidate in vol and candidate != app_name:
        suffix = str(n)
        candidate = stem[:BOOT_NAME_MAX - len(suffix)].rstrip() + suffix
        n += 1
    vol[candidate] = vol.pop(app_name)
    print(f"  renamed {app_name!r} to {candidate!r}: the boot blocks hold "
          f"{BOOT_NAME_MAX} characters and no more")
    return candidate


def patch_boot_shell(image, app_name):
    """Name `app_name` as the disk's startup program, the way a game disk does."""
    name = app_name.encode("mac_roman")
    assert len(name) <= BOOT_NAME_MAX, (
        f"{app_name!r} is {len(name)} bytes; call fit_boot_name() before writing "
        f"the boot blocks")
    field = bytes([len(name)]) + name + b"\0" * (BOOT_NAME_MAX - len(name))
    out = bytearray(image)
    for off in (SHELL_OFFSET, STARTUP_OFFSET):
        out[off:off + 16] = field
    return bytes(out)


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
    ap.add_argument("--title-disk", action="store_true",
                    help="build a small disk holding only the title, to be mounted beside a "
                         "shared operating-system image rather than carrying its own copy "
                         "of one (see the note on shared system disks)")
    ap.add_argument("--shared-base", default="Images/system/macos8-shared.img",
                    help="the shared system image --title-disk is built to sit beside; read "
                         "only for its volume creation date, which the alias must match")
    ap.add_argument("--use-source-system", action="store_true",
                    help="keep the source disk's own System instead of copying the title "
                         "onto a System 7.5.3 boot disk, and patch the boot blocks so it "
                         "launches the title directly. For anything that will not survive "
                         "System 7 — see the note on self-booting disks.")
    ap.add_argument("--app", metavar="NAME",
                    help="the application to launch, by name. Needed on the SoftKey-era "
                         "CDs, which bundled an AOL installer and Acrobat Reader that are "
                         "both several times the size of the game.")
    ap.add_argument("--file", action="append", metavar="NAME",
                    help="a file in the item to read instead of its 00playable*.dc42 "
                         "floppies — a .iso or .img of a Mac or hybrid CD, say. "
                         "Repeatable.")
    ap.add_argument("--no-launch", action="store_true",
                    help="build the disk but do not launch anything at startup, which is "
                         "how you find out whether a title is crashing the Mac or never "
                         "reaching it")
    ap.add_argument("--app-only", action="store_true",
                    help="copy only the application, not the files beside it (see the note on --app-only)")
    args = ap.parse_args()

    os.makedirs("Images/titles", exist_ok=True)
    meta_url = f"https://archive.org/metadata/{args.item}"
    with urllib.request.urlopen(urllib.request.Request(meta_url, headers=UA), timeout=120) as r:
        meta = json.load(r)
    if args.file:
        # --file normally names a file inside the Internet Archive item. It may
        # also be a path to a disk image already on this machine, which is how
        # a title reaches us when the item ships a zip rather than a raw image:
        # unpack it by hand, point --file at what came out. Local paths are
        # taken as-is and never fetched.
        have = {f["name"] for f in meta.get("files", [])}
        missing = [n for n in args.file if n not in have and not os.path.exists(n)]
        if missing:
            sys.exit(f"{args.item} has no file named {missing[0]!r}, "
                     f"and there is no such file on disk either")
        names = list(args.file)
    else:
        names = [f["name"] for f in meta.get("files", [])
                 if f["name"].startswith("00playable") and f["name"].endswith(".dc42")]
    if not names:
        sys.exit(f"{args.item} has no 00playable*.dc42 images "
                 f"(pass --file to name one yourself)")
    print(f"{args.item}: {len(names)} image(s)")

    app_path = app = app_volume = app_blob = None
    loose = {}

    def consider(name, v, blob=None):
        """Keep this volume's application if it beats the best one so far.

        A disk with no application on it is not always the boot floppy. A title
        that shipped on two disks often put the application on one and its data
        on the other, and Carmen Sandiego is the clean example: disk two holds
        nothing but `Carmen Europe Graphics`, 653K of it, and without that file
        the game starts and immediately says so. So the files on such a disk are
        kept and folded in beside the application later.
        """
        nonlocal app_path, app, app_volume, app_blob
        path, found = find_app(v, args.app)
        if found is None:
            spare = {n: i for n, i in v.items()
                     if not (isinstance(i, machfs.Folder) and is_system_folder(n, i))}
            spare, _ = split_off_system_files(spare)
            if spare:
                loose.update(spare)
                print(f"    {name}: no application, kept {', '.join(sorted(spare))}")
            else:
                print(f"    {name}: no application (probably the boot floppy)")
            return
        size = len(found.data) + len(found.rsrc)
        print(f"    {name}: {':'.join(path)} ({size // 1024} KB)")
        if app is None or size > len(app.data) + len(app.rsrc):
            app_path, app, app_volume, app_blob = path, found, v, blob

    for name in sorted(names):
        if os.path.exists(name):
            local = name                      # a local image; nothing to fetch
            print(f"  reading {os.path.basename(name)} from disk")
        else:
            local = f"Images/titles/src-{args.slug}-{os.path.basename(name)}"
            fetch(f"https://archive.org/download/{args.item}/{urllib.parse.quote(name)}", local)
        raw = strip_dc42(open(local, "rb").read())
        # A disc can hold several volumes, a floppy holds exactly one, and a
        # hybrid CD hides the Mac one behind an ISO 9660 filesystem meant for
        # the PC. hfs_volumes() returns whichever applies.
        blobs = partitions.hfs_volumes(raw)
        if len(blobs) > 1:
            print(f"    {name}: {len(blobs)} Macintosh partitions")
        for blob in blobs:
            if mfs.looks_like_mfs(blob):
                v = mfs.read(blob)      # a 400K floppy from before HFS existed
            elif blob[1024:1026] == b"BD":
                v = machfs.Volume(); v.read(blob)
            else:
                print(f"    {name}: unknown filesystem {blob[1024:1026]!r} — skipped")
                continue
            consider(name, v, blob)
        continue
    if app is None:
        sys.exit("no application found on any disk")

    app_name = app_path[-1]
    folder_name = args.folder_name or args.volume_name

    if args.title_disk:
        shared = machfs.Volume()
        shared.read(open(args.shared_base, "rb").read())
        t = machfs.Volume()
        t.name = "Title"
        t.crdate = t.mddate = t.bkdate = shared.crdate
        t["Start App"] = app                 # first, so its catalogue id is fixed
        alias = machfs.File()
        alias.aliastarget = t["Start App"]
        alias.crdate = alias.mddate = alias.bkdate = t.crdate
        t["Start"] = alias
        extras = {} if args.app_only else siblings_of(app_volume, app_path)
        extras, _ = split_off_system_files(extras)
        for name, item in loose.items():
            extras.setdefault(name, item)
        for name, item in extras.items():
            if name not in ("Start", "Start App"):
                t[name] = item
        out = f"Images/titles/title-{args.slug}.img"
        image = t.write(args.size * 1024 * 1024, align=512, desktopdb=True, bootable=False)
        assert image[1024:1026] == b"BD", "not an HFS volume"
        open(out, "wb").write(image)
        print(f"\nwrote {out}: {len(image) / 1048576:.0f} MB holding {app_name!r} "
              f"and {len(extras)} file(s) beside it, to mount after the shared system disk")
        print(f"\nnext:\n  node scripts/chunk-disk.mjs {out} {args.slug}-title --name \"{args.volume_name}\"")
        return

    if args.use_source_system:
        vol = app_volume
        added = []
        for name, item in loose.items():
            if name not in vol and not is_host_litter(name):
                vol[name] = item
                added.append(name)
        if added:
            print(f"  merged from the other disk(s): {', '.join(sorted(added))}")
        vol.name = args.volume_name
        # Some 1985-86 disks (the Miles Computing titles among them) carry no
        # launchable application at all: the game is started by the disk's own
        # boot blocks, and the only APPL on the volume is a "Reset & 'Boot'
        # disk" stub. Naming that as the startup program boots into the stub.
        # --no-launch leaves the original boot arrangement exactly as it was.
        if not args.no_launch:
            app_name = fit_boot_name(vol, app_name)
        out = f"Images/titles/boot-{args.slug}.img"
        image = vol.write(args.size * 1024 * 1024, align=512, desktopdb=True, bootable=True)
        # machfs writes boot blocks only when it can bless a System *Folder*, and
        # a 1987 game disk keeps System and Finder at the root instead. Its own
        # boot blocks already work, so carry those across rather than synthesise
        # new ones, and bless the root directory (ID 2), which is where its
        # System actually lives.
        if image[0:2] != b"LK" and app_blob and app_blob[0:2] == b"LK":
            image = app_blob[:1024] + image[1024:]
            print("  kept the source disk's own boot blocks")
        if not struct.unpack(">I", image[1024 + 92:1024 + 96])[0]:
            image = (image[:1024 + 92] + struct.pack(">I", 2) + image[1024 + 96:])
            print("  blessed the root directory, where this disk's System lives")
        if not args.no_launch:
            image = patch_boot_shell(image, app_name)
        else:
            print("  left the source disk's own startup arrangement alone")
        assert image[0:2] == b"LK", "boot blocks missing"
        assert image[1024:1026] == b"BD", "not an HFS volume"
        open(out, "wb").write(image)
        print(f"\nwrote {out}: {len(image) / 1048576:.0f} MB on the source disk's own "
              f"System, booting straight into {app_name!r}")
        return

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
    # An application is not an alias, whatever its Finder flags say. Reader
    # Rabbit's shipped with kIsAlias set — harmless on a floppy that booted
    # straight into it, and fatal under System 7, whose Finder looks at the
    # flag first and answers "this item is really not an alias (oops!)".
    if app.flags & 0x8000:
        app.flags &= ~0x8000
        print(f"  cleared the alias bit on {app_name!r}, which is an application")

    extras = {} if args.app_only else siblings_of(app_volume, app_path)
    extras, system_files = split_off_system_files(extras)
    for name, item in loose.items():
        if name not in extras and name != app_name:
            extras[name] = item
    if loose:
        print(f"  from the other disk(s): {', '.join(sorted(loose))}")
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

    for name, item in system_files.items():
        sysf[name] = item
    if system_files:
        print(f"  into the System Folder: {', '.join(sorted(system_files))}")

    if args.no_launch:
        print("  --no-launch: nothing will open at startup")
    elif args.in_startup_items:
        launched, kept = {}, {}
        for name, item in folder.items():
            if isinstance(item, machfs.Folder) or item.type not in DOCUMENT_TYPES:
                launched[name] = item
            else:
                kept[name] = item
        # The Finder opens every VISIBLE item in Startup Items, so a title with
        # a lot of data beside it cannot simply be poured in here: Shanghai
        # brings 24 tile layouts and a second application, P1, which it loads
        # itself when it needs it. Left visible, the Finder would open all 25 on
        # top of the game. Invisible, they are skipped by the startup scan and
        # still found by the application, which asks for them by name.
        for name, item in launched.items():
            if name != app_name:
                item.flags |= 0x4000        # kIsInvisible
            items[name] = item
        hidden = [n for n in launched if n != app_name]
        if hidden:
            print(f"  hidden from the startup scan: {len(hidden)} item(s) beside the application")
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
