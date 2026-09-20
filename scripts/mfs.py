"""Read the 1984 Macintosh File System, which machfs does not.

machfs handles HFS, and HFS arrived with the Hard Disk 20 in September 1985.
Everything shipped on a 400K single-sided floppy before that is MFS, and on the
Internet Archive that is a long list of the titles people actually search for:
Lode Runner, Shanghai, Rogue, Math Blaster, Excel 1.0, the Infocom catalogue,
and most of the early EA games. The importer used to print "cannot read" and
skip them, which quietly capped the catalogue at 1986.

MFS is small enough to read in one sitting. It is flat — no folders at all, the
Finder faked those with a folder number in each entry's Finder info — and the
allocation map is a single array of 12-bit block pointers, each entry naming
the next block of the file or 1 to mean "this was the last one".

What comes back is a machfs.Volume holding machfs.File objects, so everything
downstream treats an MFS floppy exactly like an HFS one.
"""
import struct

import machfs

SIGNATURE = b"\xd2\xd7"


def looks_like_mfs(raw):
    return raw[1024:1026] == SIGNATURE


def _alloc_entry(mapbytes, index):
    """The 12-bit allocation-map entry at `index`, packed two per three bytes."""
    off = (index * 3) // 2
    if off + 1 >= len(mapbytes):
        return 0
    if index % 2 == 0:
        return (mapbytes[off] << 4) | (mapbytes[off + 1] >> 4)
    return ((mapbytes[off] & 0x0F) << 8) | mapbytes[off + 1]


def read(raw):
    """An MFS image as a machfs.Volume. Raises ValueError if it is not MFS."""
    if not looks_like_mfs(raw):
        raise ValueError("not an MFS volume")

    (sig, crdate, lsbkup, atrb, nmfls, dirst, bllen, nmalblks,
     alblksiz, clpsiz, alblst, nxtfnum, freebks) = struct.unpack_from(
        ">2sIIHHHHHIIHIH", raw, 1024)
    namelen = raw[1024 + 36]
    volname = raw[1024 + 37:1024 + 37 + namelen].decode("mac_roman")

    # The map follows the 64-byte MDB header and runs to the start of the
    # directory. Two entries per three bytes, first entry describing allocation
    # block 2 — blocks 0 and 1 are the boot blocks and have no map entry.
    mapbytes = raw[1024 + 64:dirst * 512]

    def fork(start_block, length):
        """Follow the allocation chain from `start_block` and cut to `length`."""
        if not length or start_block < 2:
            return b""
        out = bytearray()
        block, seen = start_block, set()
        while block >= 2 and len(out) < length:
            if block in seen:
                raise ValueError(f"allocation chain loops at block {block}")
            seen.add(block)
            off = alblst * 512 + (block - 2) * alblksiz
            out += raw[off:off + alblksiz]
            block = _alloc_entry(mapbytes, block - 2)
        return bytes(out[:length])

    volume = machfs.Volume()
    volume.name = volname
    volume.crdate = crdate
    volume.mddate = lsbkup or crdate

    pos = dirst * 512
    end = pos + bllen * 512
    found = 0
    while pos < end and found < nmfls:
        flags = raw[pos]
        if not flags & 0x80:
            # Unused slot. Entries never straddle a 512-byte block, so the rest
            # of this block is padding and the next entry starts in the next.
            pos = (pos // 512 + 1) * 512
            continue
        (flnum, stblk, lglen, pylen,
         rstblk, rlglen, rpylen, crdat, mddat) = struct.unpack_from(
            ">18xIHIIHIIII", raw, pos)
        usrwds = raw[pos + 2:pos + 18]
        namelen = raw[pos + 50]
        name = raw[pos + 51:pos + 51 + namelen].decode("mac_roman")

        f = machfs.File()
        f.type = usrwds[0:4]
        f.creator = usrwds[4:8]
        f.flags = struct.unpack_from(">H", usrwds, 8)[0]
        # Unsigned, because that is how machfs packs them again on the way
        # out. A few MFS floppies carry a Finder position of -1 meaning "never
        # placed", and signing it here makes machfs refuse to write the volume.
        f.x, f.y = struct.unpack_from(">HH", usrwds, 10)
        f.crdate = crdat
        f.mddate = mddat
        f.bkdate = 0
        f.data = fork(stblk, lglen)
        f.rsrc = fork(rstblk, rlglen)
        volume[name] = f
        found += 1

        pos += 51 + namelen
        pos += pos % 2          # entries are word-aligned
    return volume
