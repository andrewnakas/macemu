# Beyond Dark Castle (Silicon Beach Software, 1987) — Macintosh

## What this is

The 1987 Macintosh Beyond Dark Castle, by Jonathan Gay and Mark Stephen Pierce,
with both of its original floppies merged onto a single bootable volume.

## Rights

Silicon Beach Software was acquired by Aldus in 1990 and Aldus by Adobe in 1994.
Neither has ever published it. Console conversions and the later Return to Dark
Castle are separate programs. The Macintosh original has not been sold by anyone
in nearly forty years.

## Why it runs on its own System

Copied onto the System 7.5.3 disk the rest of the catalogue uses, Beyond Dark
Castle boots to a black screen and stays there — no error, no bomb, nothing to
diagnose. Clicking through it does nothing, because it is not waiting for input.

Its own disk runs it correctly. So this volume is built from the source disk's
1987 System rather than ours, with three consequences worth recording:

- The data from the second floppy (`BDC Data B`) is merged in, so nothing asks
  you to swap disks.
- The disk's own boot blocks are kept rather than regenerated. machfs writes
  boot blocks only when it can bless a System *Folder*, and a 1987 game disk
  keeps System and Finder at the volume root instead.
- The boot blocks' startup-program field is pointed at `BDC`, which is how a
  self-booting game disk of that era came up in the game with no Finder in the
  way. Rogue's disk does the same thing and says `Rogue` in that field.

## Provenance

Internet Archive item `beyonddarkcastle_202004` — two preserved Macintosh disks.
`.DS_Store` and `.Trashes`, left by whichever modern Mac imaged them, were
dropped rather than copied onto a 1987 desktop.

## Takedown

If you hold rights — Adobe included — say so at /takedown/ and it is removed
within 48 hours, without argument.
