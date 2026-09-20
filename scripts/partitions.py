"""Find the Macintosh filesystem inside a disc image.

A floppy image is the filesystem and nothing else, so for years the importer
could assume the volume started at byte zero. Discs are not like that. A Mac
CD-ROM carries an Apple Partition Map, and a *hybrid* disc — the kind a
publisher pressed once and sold to both platforms — carries an ISO 9660
filesystem for the PC and an Apple_HFS partition for the Mac, interleaved on
the same disc so each machine sees only its own.

Number Munchers is one of those: a SoftKey pressing whose ISO 9660 side is what
most tools show you, with the Macintosh version sitting in a partition further
in. Reading byte zero finds 'ER', not 'BD', and the old code gave up there.

The map itself is simple. Block 0 is a driver descriptor naming the block size.
Block 1 begins an array of partition entries, each one naming its type, and the
one we want says "Apple_HFS".
"""
import struct

DDR_SIGNATURE = b"ER"
MAP_SIGNATURE = b"PM"


def partitions(raw):
    """Every partition in an Apple Partition Map, as (type, name, offset, length)."""
    if raw[0:2] != DDR_SIGNATURE:
        return []
    block_size = struct.unpack_from(">H", raw, 2)[0] or 512
    out = []
    index, count = 1, 1
    while index <= count:
        entry = index * block_size
        if raw[entry:entry + 2] != MAP_SIGNATURE:
            break
        count = struct.unpack_from(">I", raw, entry + 4)[0]
        start, blocks = struct.unpack_from(">II", raw, entry + 8)
        name = raw[entry + 16:entry + 48].split(b"\0")[0].decode("mac_roman", "replace")
        kind = raw[entry + 48:entry + 80].split(b"\0")[0].decode("mac_roman", "replace")
        out.append((kind, name, start * block_size, blocks * block_size))
        index += 1
    return out


def hfs_volumes(raw):
    """Every Macintosh volume in `raw`, outermost first, as raw byte strings.

    A plain floppy or hard-disk image is returned unchanged. A partitioned disc
    gives back each Apple_HFS partition in map order.
    """
    parts = partitions(raw)
    if not parts:
        return [raw]
    out = []
    for kind, name, offset, length in parts:
        if not kind.startswith("Apple_HFS"):
            continue
        blob = raw[offset:offset + length] if length else raw[offset:]
        if blob[1024:1026] in (b"BD", b"H+") or blob[1024:1026] == b"\xd2\xd7":
            out.append(blob)
    return out
