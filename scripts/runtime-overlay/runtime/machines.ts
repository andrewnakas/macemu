// Machine table for the macemu runtime bundle.
//
// Only machines that run on Basilisk II, SheepShaver and Mini vMac are
// exposed: those are the emulators whose Wasm builds this bundle ships (see
// ui-emulators.ts / worker-emulators.ts). The definitions themselves are the
// upstream ones; the runtime only rewrites `romPath` at create() time so ROMs
// come from /rom/<file> instead of a bundled asset.
import {
    MAC_128K,
    MAC_512KE,
    MAC_PLUS,
    MAC_SE,
    MAC_II,
    MAC_IIx,
    MAC_IIFX,
    QUADRA_650,
    POWER_MACINTOSH_9500,
    POWER_MACINTOSH_G3_BW,
    type MachineDef,
} from "@/defs/machines";

export const SUPPORTED_MACHINES: readonly MachineDef[] = [
    MAC_128K,
    MAC_512KE,
    MAC_PLUS,
    MAC_SE,
    MAC_II,
    MAC_IIx,
    MAC_IIFX,
    QUADRA_650,
    POWER_MACINTOSH_9500,
    POWER_MACINTOSH_G3_BW,
];

// Extra spellings accepted by create({machine}). Keys are normalized (see
// normalizeMachineName): lower-case with everything but [a-z0-9] removed, so
// "Quadra-650", "quadra 650" and "Quadra650" all resolve to the same entry.
const ALIASES: {[key: string]: MachineDef} = {
    "128k": MAC_128K,
    "512ke": MAC_512KE,
    "512k": MAC_512KE,
    "plus": MAC_PLUS,
    "se": MAC_SE,
    "ii": MAC_II,
    "iix": MAC_IIx,
    "iifx": MAC_IIFX,
    "quadra": QUADRA_650,
    "q650": QUADRA_650,
    "9500": POWER_MACINTOSH_9500,
    "pm9500": POWER_MACINTOSH_9500,
    "powermac9500": POWER_MACINTOSH_9500,
    "g3": POWER_MACINTOSH_G3_BW,
    "g3bw": POWER_MACINTOSH_G3_BW,
    "pmg3": POWER_MACINTOSH_G3_BW,
    "powermacg3": POWER_MACINTOSH_G3_BW,
    "powermacintoshg3": POWER_MACINTOSH_G3_BW,
    "bluewhite": POWER_MACINTOSH_G3_BW,
    "blueandwhite": POWER_MACINTOSH_G3_BW,
};

export function normalizeMachineName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const BY_KEY = new Map<string, MachineDef>();
for (const machine of SUPPORTED_MACHINES) {
    BY_KEY.set(normalizeMachineName(machine.name), machine);
}
for (const [key, machine] of Object.entries(ALIASES)) {
    if (!BY_KEY.has(key)) {
        BY_KEY.set(key, machine);
    }
}

export function findMachine(name: string): MachineDef | undefined {
    return BY_KEY.get(normalizeMachineName(name));
}

export type MachineInfo = {
    name: string;
    emulator: MachineDef["emulatorType"];
    cpu: MachineDef["cpu"];
    ramSizes: readonly string[];
    fixedScreenSize?: {width: number; height: number};
    romFile: string;
};

export function listMachines(): MachineInfo[] {
    return SUPPORTED_MACHINES.map(machine => ({
        name: machine.name,
        emulator: machine.emulatorType,
        cpu: machine.cpu,
        ramSizes: machine.ramSizes,
        fixedScreenSize: machine.fixedScreenSize,
        romFile: machine.romPath.split("/").pop()!,
    }));
}
