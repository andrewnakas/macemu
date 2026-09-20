# Glider PRO — provenance and licence

**Hosted:** yes, as `glider-pro-v8`.
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

## The houses, and why they went missing for a while

Glider PRO spent several days on this site as a guide page because it booted,
reached its title screen, and then reported *"There are no houses on this
drive!"* — with the houses sitting beside it, right types, intact forks.

The cause was the launch mechanism, not the disk. An application started from
an alias in System Folder:Startup Items resolves "the folder I am in" to
Startup Items rather than to where it actually lives, so anything it expects to
find beside itself is missing. SimCity 1.2 fails the same way with a different
message (*File IO Error-39*).

The fix is to put the application and its data directly into Startup Items, so
that "beside itself" becomes true — `--in-startup-items` in both builders.
Documents are deliberately left out of that move, because the Finder opens
every item in Startup Items at boot and a readme in there launches SimpleText
on top of the running game.

## Takedown

Anyone with standing to object can have this removed within 48 hours — see
`/takedown/`.
