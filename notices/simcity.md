# SimCity (1989, Macintosh) — provenance and licence

**Hosted:** yes, as `simcity-v1`.
**Provenance:** abandoned commercial software, with an unusual wrinkle.

## Where the files came from

The [`SimCity_v12_4amMacCrack`](https://archive.org/details/SimCity_v12_4amMacCrack)
item at the Internet Archive: version 1.2 of the original Macintosh release,
preserved as a DiskCopy 4.2 floppy image with its copy protection removed. The
header was stripped and the application copied into a System 7.5.3 boot image by
`scripts/add-from-archive.py`, resource fork intact.

## Why it is here, and why this one deserves a longer note

SimCity is the most commercially alive brand of anything hosted on this site,
so the reasoning matters more than usual.

**The 1989 Macintosh release is not sold by anyone.** Maxis was acquired by
Electronic Arts in 1997. EA has sold many SimCity games since and continues to;
none of them is this. The black-and-white Macintosh original has not been
commercially available in any form for over thirty years.

**The original SimCity engine was released as open source.** In 2008, for the
One Laptop Per Child project, EA released the source of SimCity Classic under
the GNU GPL version 3, renamed *Micropolis* because EA retained the SimCity
trademark. That release covers the code lineage this binary descends from,
though not this specific build or its artwork.

Taken together: the code has been freed, the trademark has not, and the artefact
itself is thirty-five years out of commerce. It is preserved here on the same
practical footing as the rest of the abandoned software on this site. That is a
position, not a legal claim, and this is the title most likely to attract an
objection — which is exactly why the takedown promise is 48 hours and
unconditional.

**If EA asks, it goes the same day.**

## A note on the build

The preserved floppy carries a `scenario` file beside the application, with a
null type and creator code. Copying it onto the boot disk makes SimCity launch
and then fail immediately with *File IO Error-39*; the application on its own
runs correctly. It is most likely a fragment the original installer would have
completed. The disk served here therefore contains the application only, which
is why `scripts/add-from-archive.py` has an `--app-only` switch.

## Takedown

See `/takedown/`.
