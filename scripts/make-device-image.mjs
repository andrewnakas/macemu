#!/usr/bin/env node
// Turn a bare HFS volume into a bootable hard disk image.
//
//   node scripts/make-device-image.mjs <input.img> <output.img> [--scsi-4.3]
//
// WHY THIS EXISTS
//
// Most classic Mac disk images found in the wild — including the ones the
// Internet Archive serves for in-browser emulation — are *bare HFS partitions*:
// 1024 bytes of boot blocks, then the volume.
//
// YOU PROBABLY DO NOT NEED THIS SCRIPT. Basilisk II, SheepShaver and Mini vMac
// all boot a bare partition perfectly well, and Infinite Mac's runtime reflects
// that: `emulatorDeviceImage()` returns null for those three, so nothing is
// wrapped. Wrapping an image for them changes nothing useful. It is the PowerPC
// emulators — DingusPPC, PearPC, Snow — that need a real hard disk layout.
//
// What this does: prepend a prebuilt header containing a Driver Descriptor
// Record, a partition map and Apple's SCSI drivers, then patch two counts so
// the map describes an HFS partition of the right size. A Node port of
// vendor/infinite-mac/scripts/make-device-image.py, reading that project's
// header blobs from the vendored submodule.
//
// If a machine boots to a black screen, the header is very unlikely to be the
// cause — check the ROM first. This System 7.5 image reads 31 KB and halts on a
// Quadra 650 and boots in full on a Macintosh IIfx, same emulator, same disk.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BLOCK_SIZE = 512;
const DATA_DIR = resolve(process.cwd(), "vendor", "infinite-mac", "src", "Data");

// Two prebuilt headers. "All Drivers" is 912 KB and carries every Apple SCSI
// driver, which is the safe default. The SCSI 4.3 header is 48 KB and enough
// for most System 7-era machines if image size matters.
const HEADERS = {
  all: { file: "Device Image Header (All Drivers).hda", partitionIndex: 8 },
  "scsi4.3": { file: "Device Image Header (Apple SCSI 4.3 Driver).hda", partitionIndex: 2 },
};

const args = process.argv.slice(2);
const inputPath = args[0];
const outputPath = args[1];
const kind = args.includes("--scsi-4.3") ? "scsi4.3" : "all";

if (!inputPath || !outputPath) {
  console.error("usage: make-device-image.mjs <input.img> <output.img> [--scsi-4.3]");
  process.exit(2);
}

const { file, partitionIndex } = HEADERS[kind];
const headerPath = resolve(DATA_DIR, file);
if (!existsSync(headerPath)) {
  console.error(`missing ${headerPath}\nRun: git submodule update --init --depth 1 vendor/infinite-mac`);
  process.exit(1);
}

const input = readFileSync(inputPath);
const header = Buffer.from(readFileSync(headerPath));

// Refuse to double-wrap. A Driver Descriptor Record starts with "ER"; if the
// input already has one, prepending another produces an image that looks
// plausible and boots nothing.
if (input.length > 2 && input[0] === 0x45 && input[1] === 0x52) {
  console.error(`${inputPath} already begins with a Driver Descriptor Record ("ER") — it is already a device image.`);
  process.exit(1);
}
// And refuse anything that is not a bare HFS volume, for the same reason.
const sig = input.readUInt16BE(1024);
if (sig !== 0x4244 && sig !== 0x482b) {
  console.error(`${inputPath} has no HFS volume at offset 1024 (found 0x${sig.toString(16)}). Not a bare HFS partition.`);
  process.exit(1);
}

const totalBlocks = Math.floor((input.length + header.length) / BLOCK_SIZE);
const hfsBlocks = Math.floor(input.length / BLOCK_SIZE);
const partitionOffset = (partitionIndex + 1) * BLOCK_SIZE;

header.writeUInt32BE(totalBlocks, 0x4);                    // sbBlkCount on the DDR
header.writeUInt32BE(hfsBlocks, partitionOffset + 12);     // pmPartBlkCnt
header.writeUInt32BE(hfsBlocks, partitionOffset + 84);     // pmDataCnt

writeFileSync(outputPath, Buffer.concat([header, input]));

const mb = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`wrote ${outputPath}`);
console.log(`  header      ${file} (${mb(header.length)})`);
console.log(`  partition   ${mb(input.length)} of HFS, ${hfsBlocks} blocks`);
console.log(`  total       ${mb(input.length + header.length)}, ${totalBlocks} blocks`);
