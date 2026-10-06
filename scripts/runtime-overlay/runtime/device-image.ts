// Replacement for src/defs/device-image.ts (aliased in
// vite.runtime.config.ts).
//
// ui.ts fetches getDeviceImageHeaderPath(deviceImageType) unconditionally,
// even though the header (a 912 KB Apple partition map + drivers image) is
// only wrapped around disks for DingusPPC, PearPC and Snow. For Basilisk II,
// SheepShaver and Mini vMac emulatorDeviceImage() returns null, so serve an
// empty buffer in that case instead of downloading 912 KB on every boot.
// Everything else is re-exported from upstream unchanged.
import {getDeviceImageHeaderPath as upstreamGetDeviceImageHeaderPath} from "../src/defs/device-image";
import {type DeviceImageType} from "@/emulator/common/device-image";

export {
    emulatorDeviceImage,
    generateDeviceImageHeader,
} from "../src/defs/device-image";

const EMPTY_HEADER_URL = "data:application/octet-stream;base64,";

export function getDeviceImageHeaderPath(type: DeviceImageType | null): string {
    if (type === null) {
        return EMPTY_HEADER_URL;
    }
    return upstreamGetDeviceImageHeaderPath(type);
}
