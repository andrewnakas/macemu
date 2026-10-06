// Replacement for src/emulator/worker/emulators.ts (aliased in
// vite.runtime.config.ts). Same contract as upstream -- a dynamic import of
// the Emscripten ES-module glue (`-s MODULARIZE -s EXPORT_ES6`) -- restricted
// to the emulators this bundle ships. Each import becomes its own chunk next
// to worker.js (BasiliskII.js, SheepShaver.js, minivmac-<model>.js) and is
// only fetched for the machine actually being booted.
import {type EmulatorDef} from "@/emulator/common/emulators";

export function importEmulator(def: EmulatorDef): Promise<{default: any}> {
    switch (def.emulatorType) {
        case "BasiliskII":
            return import("@/emulator/worker/emscripten/BasiliskII");
        case "SheepShaver":
            return import("@/emulator/worker/emscripten/SheepShaver");
        case "Mini vMac":
            switch (def.emulatorSubtype) {
                case "128K":
                    return import("@/emulator/worker/emscripten/minivmac-128K");
                case "512Ke":
                    return import("@/emulator/worker/emscripten/minivmac-512Ke");
                case "Plus":
                    return import("@/emulator/worker/emscripten/minivmac-Plus");
                case "SE":
                    return import("@/emulator/worker/emscripten/minivmac-SE");
                case "II":
                    return import("@/emulator/worker/emscripten/minivmac-II");
                case "IIx":
                    return import("@/emulator/worker/emscripten/minivmac-IIx");
            }
        // falls through
        default:
            return Promise.reject(
                new Error(
                    `Emulator "${def.emulatorType}" is not included in the macemu runtime build`
                )
            );
    }
}
