# Avara (Ambrosia Software, 1996) — Macintosh

## What this is

Avara 1.0.1, written by Juri Munkki and published by Ambrosia Software, exactly
as its own installer produced it.

## Licence — this one grants permission in terms

Most of this catalogue is hosted on an argument about abandonment. Avara is not.
Its licence agreement, shown by the installer and included in the copy here,
says:

> Unless explicitly stated in writing, Ambrosia Software, Inc. does not grant
> permission to distribute the software for profit in any form... Non-profit
> distribution of the software is acceptable without prior written notice,
> providing that the software is not modified in any way, and the complete
> works of the software are included in the distribution package.

Both conditions are met:

- **Unmodified.** The copy is what the installer wrote, untouched. In particular
  the shareware notice it shows at startup is still there. It would be trivial
  to pre-register the copy or patch the notice out, and doing either would break
  the licence and is not done.
- **Complete works.** The whole installed folder travels with the game —
  Documentation, Extras, Web Site urls, both level sets, and Register Avara.
  Nothing was trimmed to save space.

The remaining condition is "not for profit". **macemu carries no advertising
today. If that changes, Avara and the other Ambrosia titles have to be
revisited** — the licence permits non-profit distribution specifically, and an
ad-supported site is a different thing. This is written down here so the
decision is not quietly forgotten later.

Avara's source code was released by Juri Munkki in 2017, and a community port
exists. That release covers the source; what is hosted here is the 1996
Macintosh binary under the shareware licence above.

## Provenance

Internet Archive item `tucows_205595_Avara` — `avara.sit`, the Ambrosia
distribution. StuffIt gave up an Installer VISE archive (`SVCT`), which no tool
outside a Mac reads, so the installer was run inside emulated Mac OS 8.6 and the
result taken back out. See `scripts/author-disk.mjs`.

The game is then mounted beside a shared Mac OS 8.6 image rather than carrying
its own copy of the operating system.

On the title disk that mounts beside the shared Mac OS 8.6 image, the
application file is named "Start App" (with an alias, "Start") so the shared
system can launch it at boot. Only the file's name was changed; its contents
were copied unaltered.

## Takedown

If you hold rights and want it gone, say so at /takedown/ and it is removed
within 48 hours, without argument.
