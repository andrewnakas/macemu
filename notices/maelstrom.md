# Maelstrom — provenance and licence

**Hosted:** yes, as `maelstrom-v3`.
**Provenance:** shareware, redistributed under the terms its author published.

## Where the files came from

The Macintosh releases of Maelstrom, preserved at the Internet Archive as
[`maelstrom-68k`](https://archive.org/details/maelstrom-68k). The disk image
there carries versions 1.0 through 1.4.3; macemu uses **1.4.3**, the last
Macintosh release, copied wholesale into a System 7.5.3 boot image by
`scripts/build-title-image.py`.

## Why it can be here

Two independent reasons, either of which would be enough.

**1. The shareware licence permits it.** `Maelstrom License.text`, shipped
inside the 1.4.3 folder and still present on the disk we serve, states that
"Non-profit distribution of the software is acceptable without prior written
notice", subject to two conditions:

- *the software is not modified in any way* — nothing here is modified. The
  application, its data files and its documentation are copied byte for byte,
  and the registration notice it opens with is left exactly as Ambrosia wrote
  it. It is not stripped, patched or pre-registered.
- *the complete works of the software are included* — the whole 1.4.3 folder is
  present, including the Documentation folder, the FAQ, the licence itself and
  the Register Maelstrom application.

The same licence grants the *user* a 30-day trial and asks for registration
beyond that. That obligation runs between the player and Ambrosia Software,
which ceased trading in the 2010s. macemu does not and cannot register anyone,
and does not pretend the notice is not there — the title page says plainly that
it appears and what to click.

**2. The authors later freed it outright.** Ambrosia gave the source to Sam
Lantinga in 1995; it was released under the GNU General Public License in 1999.
In 2010 Andrew Welch and Ian Gilman released the game's artwork under a
Creative Commons Attribution licence. The SDL port at libsdl.org descends from
that release.

## The one open question

The shareware licence forbids distribution *for profit*. macemu carries no
advertising today. If that changes, this title should be reviewed: the safest
reading is that an ad-supported page is not "distribution for profit", but it is
not the only reading, and the honest move would be to keep shareware titles out
of any ad-carrying layout rather than argue the point.

## Takedown

Anyone with standing to object can have this removed within 48 hours — see
`/takedown/`.
