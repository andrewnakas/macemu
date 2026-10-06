// Replacement for src/emulator/ui/emulators.ts (aliased in
// vite.runtime.config.ts). Only the Wasm binaries for the emulators this
// bundle supports are referenced, so only those get copied to public/mac/.
// The URLs resolve to /mac/<name>.wasm because the build uses base "/mac/"
// and a hash-free assetFileNames pattern.
import MinivMac128KWasmPath from "@/emulator/worker/emscripten/minivmac-128K.wasm?url";
import MinivMac512KeWasmPath from "@/emulator/worker/emscripten/minivmac-512Ke.wasm?url";
import MinivMacIIWasmPath from "@/emulator/worker/emscripten/minivmac-II.wasm?url";
import MinivMacIIxWasmPath from "@/emulator/worker/emscripten/minivmac-IIx.wasm?url";
import MinivMacPlusWasmPath from "@/emulator/worker/emscripten/minivmac-Plus.wasm?url";
import MinivMacSEWasmPath from "@/emulator/worker/emscripten/minivmac-SE.wasm?url";
import BasiliskIIWasmPath from "@/emulator/worker/emscripten/BasiliskII.wasm?url";
import SheepShaverWasmPath from "@/emulator/worker/emscripten/SheepShaver.wasm?url";
import {type EmulatorDef} from "@/emulator/common/emulators";

export function getEmulatorWasmPath(def: EmulatorDef): string {
    const {emulatorType, emulatorSubtype} = def;
    switch (emulatorType) {
        case "BasiliskII":
            return BasiliskIIWasmPath;
        case "SheepShaver":
            return SheepShaverWasmPath;
        case "Mini vMac":
            return {
                "128K": MinivMac128KWasmPath,
                "512Ke": MinivMac512KeWasmPath,
                "Plus": MinivMacPlusWasmPath,
                "SE": MinivMacSEWasmPath,
                "II": MinivMacIIWasmPath,
                "IIx": MinivMacIIxWasmPath,
            }[emulatorSubtype];
        default:
            throw new Error(
                `Emulator "${emulatorType}" is not included in the macemu runtime build`
            );
    }
}
