# Glider PRO — provenance and licence

**Hosted:** not yet — see "Why this is not playable here" below.
**Provenance:** released as open source by its author.

## Where the files came from

The Tucows software archive collection at the Internet Archive,
[`tucows_206047_Glider_Pro`](https://archive.org/details/tucows_206047_Glider_Pro),
which preserves `gliderpro9.sit` — the final Macintosh distribution of Glider
PRO. Expanded with `unar` (the XADMaster engine, the same reader the Infinite
Mac project uses) and imported into a System 7.5.3 boot image by
`scripts/build-title-image.py`, resource forks and Finder metadata intact.

Included: the application, the Houses folder with Slumberland and the Demo
House, their accompanying movies, and the serial number file the distribution
shipped with.

## Why it can be here

**John Calhoun released Glider PRO as open source.** The complete source code,
artwork and house files are published at
[softdorothy/GliderPRO](https://github.com/softdorothy/GliderPRO) under the GNU
General Public License version 2. Calhoun wrote the game; Casady & Greene, who
published it commercially in 1994, ceased trading in 2003.

That release is unusually clean for a Macintosh game of this era. Most
commercial titles from the 1990s are stuck: the publisher dissolved, and
whoever inherited the rights is either unknown or uninterested. Glider PRO is
free because the person who wrote it decided it should be.

The build served here is the original Macintosh binary rather than something
compiled from that source, because the point of this site is to run the
software as it shipped. The maintained modern port,
[Aerofoil](https://github.com/elasota/Aerofoil), is built from Calhoun's
release and is the better way to play the game seriously — it is linked from
the title page.

## A note on the serial number file

The distribution includes `Glider Serial Number.txt`, a relic of the
commercial release. It is left in place because the folder is copied as it was
preserved, unmodified. It is not a circumvention of anything: the game is GPL,
and there is nothing left to circumvent.

## Takedown

Anyone with standing to object can have this removed within 48 hours — see
`/takedown/`.


## Why this is not playable here (2026-09-15)

Glider PRO boots on the emulated Macintosh and reaches its title screen, then
puts up its own dialog: *"There are no houses on this drive!"* The houses are
present on the volume, in a folder beside the application, with the right type
(`gliH`) and creator (`ozm5`) and byte-identical resource forks. The game
cannot see them.

What was ruled out, each by building an image and booting it:

- **The folder name.** Tried both `Houses ƒ` as distributed and plain `Houses`.
- **Lost resource forks.** Verified: 1,041,112 bytes for Slumberland on the
  built volume, matching the host file exactly.
- **Lost type and creator codes.** Verified on the written volume.
- **The Desktop database.** Tried both machfs's generated one and omitting it
  so the Finder rebuilds its own.
- **Allocation block size.** Tried 512 and 1024 byte blocks.
- **File dates.** Fixed separately — files were being written dated 1904 — and
  it made no difference here.

The remaining suspect is the **startup alias**. Without it the game does not
launch at all, and with it the game launches but cannot find files sitting next
to its real location. Glider PRO's message says "on this drive", which suggests
a volume-wide search rather than a relative one, so this is not yet proven.

The better long-term answer is probably not to fix this at all.
[Aerofoil](https://github.com/elasota/Aerofoil) is a maintained port built from
Calhoun's GPL release, it has a browser build, and it plays better than the
1994 binary under emulation. That would make Glider PRO an `iframeUrl` title
rather than a disk image.
