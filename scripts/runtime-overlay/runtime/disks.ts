// Replacement for src/defs/disks.ts (aliased in vite.runtime.config.ts).
//
// The upstream module defines Infinite Mac's built-in disk catalogue with a
// dynamic import of every generated src/Data/*.dsk.json manifest -- none of
// which exist in this checkout (they are produced by import-disks.py) and
// none of which macemu uses. ui.ts only needs the two type guards below; the
// types are re-exported from upstream (erased at build time).
export type {
    EmulatorDiskDef,
    SystemDiskDef,
    PlaceholderDiskDef,
    DiskFile,
    SystemFamily,
} from "../src/defs/disks";
import type {
    EmulatorDiskDef,
    SystemDiskDef,
    PlaceholderDiskDef,
} from "../src/defs/disks";

export function isPlaceholderDiskDef(
    disk: SystemDiskDef | PlaceholderDiskDef
): disk is PlaceholderDiskDef {
    return "type" in disk && disk.type === "placeholder";
}

export function isSystemDiskDef(
    disk: EmulatorDiskDef | SystemDiskDef | PlaceholderDiskDef
): disk is SystemDiskDef {
    return "displayName" in disk && !("type" in disk);
}
