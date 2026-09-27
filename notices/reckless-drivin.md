# Reckless Drivin' (Jonas Echterhoff, 2000–2003) — Macintosh

## What this is

Reckless Drivin' version 1.44 (27 January 2003), © 2000–2003 Jonas
Echterhoff, the last release of his top-down driving game for Mac OS 8.1+ and
Mac OS X. It runs here on an emulated Power Macintosh under the shared Mac OS
8.6 image with CarbonLib installed (`macos8-carbon`).

## Licence

Shareware. Section 9 of the included Readme, "Legal Stuff":

> Reckless Drivin' may be freely distributed, as long as all the files that
> came with the original package are included.

and

> Modified versions of Reckless Drivin' or any of it's files may not be
> distributed without my permission.

Every file from the package is on the title disk: the Readme, Register, the
Reckless Drivin' Homepage link, and the `Reckless Drivin'.app` package with
its Info.plist, icon, HID bundle and alias. The copy is unregistered, the
shareware notice appears on every launch, and it plays the three levels an
unregistered copy allows. No registration code is present or needed.

## What was changed, and why

Nothing inside any file was altered. Two things about the layout differ from
the archive, and both are disclosed here:

1. **The application was moved and renamed.** The game's code lives at
   `Reckless Drivin'.app:Contents:MacOS:Reckless Drivin'`. On the title disk
   that file sits at the top level as "Start App", with an alias, "Start", so
   the shared system can launch it at boot, the same arrangement as every other
   Mac OS 8 title on this site. Its data and resource forks are byte for byte
   as distributed. A version that left it inside the package, with the alias
   pointing into it, was tried first and the shared system could not resolve
   it.
2. **Apple's DrawSprocketLib 1.7.3 was added beside it.** The game requires
   DrawSprocket, part of Apple's Game Sprockets, which Mac OS 8.6 does not
   include. The library is Apple system software and sits beside the game
   rather than in the shared System Folder; the Mac OS loader looks in the
   application's own folder first. It comes from Apple's DrawSprocket 1.7.3
   SDK, Internet Archive item `draw-sprocket-sdk`. It is hosted on the same
   footing as the Mac OS 8.6 image itself.

The player on this page also sends the arrow keys to the numeric-keypad keys
the game uses by default. That happens in the browser, not in the software.

## Provenance

Internet Archive item `tucows_205727_Reckless_Drivin`, the Tucows mirror copy,
a StuffIt archive expanding to a plain folder. Played on 2026-09-27 from the
shareware notice through the main menu into the first level: accelerating,
steering and crashing off the road.

## Takedown

If you are Jonas Echterhoff, or hold rights in the game, say so at /takedown/
and it is removed within 48 hours, without argument.
