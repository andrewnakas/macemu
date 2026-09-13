#!/usr/bin/env node
// Split a raw disk image into the content-addressed chunk format that the
// Infinite Mac worker (vendor/infinite-mac/src/emulator/worker/chunked-disk.ts)
// reads, and write the JSON manifest the runtime loads from /mac/disks/<name>.json.
//
// This is a zero-dependency port of write_chunked_image() from
// vendor/infinite-mac/scripts/import-disks.py and matches its output exactly:
//
//   - chunk size is 256 KiB (the last chunk may be shorter)
//   - a chunk's file name is blake2b(chunk, digest_size=16, salt=b"raw").hexdigest() + ".chunk"
//   - a chunk that is exactly 256 KiB of zero bytes is not written; its manifest
//     entry is the empty string and the worker synthesises zeros for it
//   - identical chunks are written once (content addressed)
//   - manifest fields: name, totalSize, chunks, chunkSize, and scrnResourceOffset
//     when the Infinite Mac placeholder 'scrn' resource is found exactly once
//
// Usage:
//   node scripts/chunk-disk.mjs <image-path> <manifest-name>
//        [--out Images/build] [--manifest-out public/mac/disks]
//        [--name "<disk name inside the emulator>"] [--prefetch 0,1,2] [--quiet]
//
// Writes <out>/<hash>.chunk files and <manifest-out>/<manifest-name>.json.
// Node's crypto module cannot do salted BLAKE2b, so a small BLAKE2b is inlined.

import fs from "node:fs";
import path from "node:path";

export const CHUNK_SIZE = 256 * 1024;
const SALT = new TextEncoder().encode("raw");

// Same bytes as scripts/placeholders.py SCRN_RESOURCE and
// PLACEHOLDER_SCRN_RESOURCE in src/emulator/ui/scrn-resource-overlay.ts.
const SCRN_RESOURCE_PLACEHOLDER = Uint8Array.from([
    0x00, 0x01, 0x42, 0x32, 0x00, 0x00, 0x08, 0x10, 0x00, 0x00, 0x00, 0x83,
    0x77, 0xfe, 0xa8, 0x01, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
    0x02, 0x58, 0x03, 0x20, 0x00, 0x00,
]);

// ---------------------------------------------------------------------------
// BLAKE2b (RFC 7693) on 32-bit word pairs, with salt support. Layout follows the
// public-domain blakejs implementation: h[2k] is the low word of state word k.
// ---------------------------------------------------------------------------

const BLAKE2B_IV32 = new Uint32Array([
    0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372,
    0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
    0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA8 = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15,
    13, 6, 1, 12, 0, 2, 11, 7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6,
    7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5,
    7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4,
    13, 7, 5, 15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8,
    11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9, 11,
    3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14,
    3, 12, 13, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10,
    4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
];
const SIGMA82 = new Uint8Array(SIGMA8.map(x => x * 2));

const v = new Uint32Array(32);
const m = new Uint32Array(32);

function ADD64AA(v, a, b) {
    const o0 = v[a] + v[b];
    let o1 = v[a + 1] + v[b + 1];
    if (o0 >= 0x100000000) {
        o1++;
    }
    v[a] = o0;
    v[a + 1] = o1;
}

function ADD64AC(v, a, b0, b1) {
    let o0 = v[a] + b0;
    if (b0 < 0) {
        o0 += 0x100000000;
    }
    let o1 = v[a + 1] + b1;
    if (o0 >= 0x100000000) {
        o1++;
    }
    v[a] = o0;
    v[a + 1] = o1;
}

function B2B_GET32(arr, i) {
    return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24);
}

function B2B_G(a, b, c, d, ix, iy) {
    const x0 = m[ix];
    const x1 = m[ix + 1];
    const y0 = m[iy];
    const y1 = m[iy + 1];

    ADD64AA(v, a, b);
    ADD64AC(v, a, x0, x1);
    let xor0 = v[d] ^ v[a];
    let xor1 = v[d + 1] ^ v[a + 1];
    v[d] = xor1;
    v[d + 1] = xor0;

    ADD64AA(v, c, d);
    xor0 = v[b] ^ v[c];
    xor1 = v[b + 1] ^ v[c + 1];
    v[b] = (xor0 >>> 24) ^ (xor1 << 8);
    v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);

    ADD64AA(v, a, b);
    ADD64AC(v, a, y0, y1);
    xor0 = v[d] ^ v[a];
    xor1 = v[d + 1] ^ v[a + 1];
    v[d] = (xor0 >>> 16) ^ (xor1 << 16);
    v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);

    ADD64AA(v, c, d);
    xor0 = v[b] ^ v[c];
    xor1 = v[b + 1] ^ v[c + 1];
    v[b] = (xor1 >>> 31) ^ (xor0 << 1);
    v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

function blake2bCompress(ctx, last) {
    let i;
    for (i = 0; i < 16; i++) {
        v[i] = ctx.h[i];
        v[i + 16] = BLAKE2B_IV32[i];
    }
    v[24] = v[24] ^ ctx.t;
    v[25] = v[25] ^ (ctx.t / 0x100000000);
    if (last) {
        v[28] = ~v[28];
        v[29] = ~v[29];
    }
    for (i = 0; i < 32; i++) {
        m[i] = B2B_GET32(ctx.b, 4 * i);
    }
    for (i = 0; i < 12; i++) {
        const s = i * 16;
        B2B_G(0, 8, 16, 24, SIGMA82[s + 0], SIGMA82[s + 1]);
        B2B_G(2, 10, 18, 26, SIGMA82[s + 2], SIGMA82[s + 3]);
        B2B_G(4, 12, 20, 28, SIGMA82[s + 4], SIGMA82[s + 5]);
        B2B_G(6, 14, 22, 30, SIGMA82[s + 6], SIGMA82[s + 7]);
        B2B_G(0, 10, 20, 30, SIGMA82[s + 8], SIGMA82[s + 9]);
        B2B_G(2, 12, 22, 24, SIGMA82[s + 10], SIGMA82[s + 11]);
        B2B_G(4, 14, 16, 26, SIGMA82[s + 12], SIGMA82[s + 13]);
        B2B_G(6, 8, 18, 28, SIGMA82[s + 14], SIGMA82[s + 15]);
    }
    for (i = 0; i < 16; i++) {
        ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16];
    }
}

function blake2bInit(outlen, salt) {
    if (!(outlen > 0 && outlen <= 64)) {
        throw new Error("blake2b: digest length must be 1..64");
    }
    if (salt && salt.length > 16) {
        throw new Error("blake2b: salt must be at most 16 bytes");
    }
    const ctx = {
        b: new Uint8Array(128),
        h: new Uint32Array(16),
        t: 0,
        c: 0,
        outlen,
    };
    for (let i = 0; i < 16; i++) {
        ctx.h[i] = BLAKE2B_IV32[i];
    }
    // Parameter block word 0: digest length, key length (0), fanout 1, depth 1.
    ctx.h[0] ^= 0x01010000 ^ outlen;
    if (salt && salt.length) {
        // Parameter block bytes 32..47 hold the salt, zero padded. Those are
        // state words 4 and 5, i.e. h[8..11] in the 32-bit pair layout.
        const padded = new Uint8Array(16);
        padded.set(salt);
        ctx.h[8] ^= B2B_GET32(padded, 0);
        ctx.h[9] ^= B2B_GET32(padded, 4);
        ctx.h[10] ^= B2B_GET32(padded, 8);
        ctx.h[11] ^= B2B_GET32(padded, 12);
    }
    return ctx;
}

function blake2bUpdate(ctx, input) {
    let offset = 0;
    const length = input.length;
    while (offset < length) {
        if (ctx.c === 128) {
            ctx.t += ctx.c;
            blake2bCompress(ctx, false);
            ctx.c = 0;
        }
        const take = Math.min(128 - ctx.c, length - offset);
        ctx.b.set(input.subarray(offset, offset + take), ctx.c);
        ctx.c += take;
        offset += take;
    }
}

function blake2bFinal(ctx) {
    ctx.t += ctx.c;
    while (ctx.c < 128) {
        ctx.b[ctx.c++] = 0;
    }
    blake2bCompress(ctx, true);
    const out = new Uint8Array(ctx.outlen);
    for (let i = 0; i < ctx.outlen; i++) {
        out[i] = ctx.h[i >> 2] >> (8 * (i & 3));
    }
    return out;
}

/** Hex digest of blake2b(data, digest_size=outlen, salt=salt). */
export function blake2bHex(data, outlen = 16, salt = SALT) {
    const ctx = blake2bInit(outlen, salt);
    blake2bUpdate(ctx, data);
    const out = blake2bFinal(ctx);
    let hex = "";
    for (let i = 0; i < out.length; i++) {
        hex += out[i].toString(16).padStart(2, "0");
    }
    return hex;
}

/** The chunk file name (without ".chunk") for a chunk's bytes. */
export function chunkSignature(chunk) {
    return blake2bHex(chunk, 16, SALT);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function isAllZero(bytes) {
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 0) {
            return false;
        }
    }
    return true;
}

function findAll(haystack, needle, max = 2) {
    const found = [];
    let from = 0;
    for (;;) {
        const i = haystack.indexOf(needle, from);
        if (i === -1 || found.length >= max) {
            break;
        }
        found.push(i);
        from = i + 1;
    }
    return found;
}

/**
 * Chunk one image. Returns the manifest object (already written to disk when
 * manifestPath is given) plus stats.
 */
export function chunkImage({
    imagePath,
    outDir,
    manifestPath,
    name,
    prefetchChunks,
    log = () => {},
}) {
    fs.mkdirSync(outDir, {recursive: true});
    const fd = fs.openSync(imagePath, "r");
    const diskSize = fs.fstatSync(fd).size;
    const chunks = [];
    const seen = new Set();
    let zeroChunkCount = 0;
    let totalSize = 0;
    let written = 0;
    let reused = 0;
    let scrnMatches = [];
    const buffer = new Uint8Array(CHUNK_SIZE);
    // The placeholder could straddle a chunk boundary, so keep the tail of the
    // previous chunk around for the search.
    const tailLen = SCRN_RESOURCE_PLACEHOLDER.length - 1;
    let tail = new Uint8Array(0);

    try {
        for (let offset = 0, index = 0; offset < diskSize; offset += CHUNK_SIZE, index++) {
            const n = fs.readSync(fd, buffer, 0, CHUNK_SIZE, offset);
            if (n <= 0) {
                break;
            }
            const chunk = buffer.subarray(0, n);
            totalSize += n;
            log(
                `Chunking ${path.basename(imagePath)}: ${(
                    (Math.min(offset + CHUNK_SIZE, diskSize) / diskSize) *
                    100
                ).toFixed(1)}%\r`
            );

            // scrn placeholder search (mirrors image_data.find in Python).
            if (scrnMatches.length < 2) {
                const window = new Uint8Array(tail.length + n);
                window.set(tail, 0);
                window.set(chunk, tail.length);
                for (const i of findAll(
                    Buffer.from(window.buffer, window.byteOffset, window.length),
                    Buffer.from(SCRN_RESOURCE_PLACEHOLDER)
                )) {
                    const abs = offset - tail.length + i;
                    // Skip a hit that only re-finds the previous chunk's match.
                    if (!scrnMatches.includes(abs)) {
                        scrnMatches.push(abs);
                    }
                }
            }
            tail = chunk.slice(Math.max(0, n - tailLen));

            // Python: `if chunk == ZERO_CHUNK` -- only a full-size zero chunk
            // is elided; a short zero tail chunk is hashed and stored.
            if (n === CHUNK_SIZE && isAllZero(chunk)) {
                chunks.push("");
                zeroChunkCount++;
                continue;
            }
            const signature = chunkSignature(chunk);
            chunks.push(signature);
            if (seen.has(signature)) {
                continue;
            }
            seen.add(signature);
            const chunkPath = path.join(outDir, `${signature}.chunk`);
            if (fs.existsSync(chunkPath)) {
                // Written by an earlier run (possibly for another image).
                reused++;
                continue;
            }
            fs.writeFileSync(chunkPath, chunk);
            written++;
        }
    } finally {
        fs.closeSync(fd);
    }

    if (chunks.length > 0) {
        log(
            `Chunked ${path.basename(imagePath)}: ${Math.round(
                (seen.size / chunks.length) * 100
            )}% unique chunks, ${Math.round(
                (zeroChunkCount / chunks.length) * 100
            )}% zero chunks\n`
        );
    } else {
        log(`Chunked ${path.basename(imagePath)}: 0 chunks\n`);
    }

    const manifest = {
        name,
        totalSize,
        chunks,
        chunkSize: CHUNK_SIZE,
    };
    if (scrnMatches.length === 1) {
        manifest.scrnResourceOffset = scrnMatches[0];
    } else if (scrnMatches.length > 1) {
        log(
            `Multiple placeholder scrn resources found in ${path.basename(
                imagePath
            )}, skipping overlay metadata\n`
        );
    }
    if (prefetchChunks && prefetchChunks.length) {
        manifest.prefetchChunks = prefetchChunks;
    }

    if (manifestPath) {
        fs.mkdirSync(path.dirname(manifestPath), {recursive: true});
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
    }

    return {
        manifest,
        stats: {
            chunkCount: chunks.length,
            uniqueChunks: seen.size,
            zeroChunks: zeroChunkCount,
            written,
            reused,
        },
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(code) {
    const out = code ? console.error : console.log;
    out(
        "Usage: node scripts/chunk-disk.mjs <image-path> <manifest-name>\n" +
            "         [--out Images/build] [--manifest-out public/mac/disks]\n" +
            "         [--name <disk name inside the emulator>] [--prefetch 0,1,2] [--quiet]\n" +
            "\n" +
            "Writes <out>/<hash>.chunk files and <manifest-out>/<manifest-name>.json.\n" +
            "The manifest's `name` defaults to the image file name without extension;\n" +
            "it is the file name the emulated machine sees on its disk list."
    );
    process.exit(code);
}

function parseArgs(argv) {
    const positional = [];
    const opts = {
        out: "Images/build",
        manifestOut: "public/mac/disks",
        name: undefined,
        prefetch: undefined,
        quiet: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) {
                console.error(`Missing value for ${arg}`);
                usage(2);
            }
            return argv[++i];
        };
        switch (arg) {
            case "--out":
                opts.out = next();
                break;
            case "--manifest-out":
                opts.manifestOut = next();
                break;
            case "--name":
                opts.name = next();
                break;
            case "--prefetch":
                opts.prefetch = next()
                    .split(",")
                    .map(s => parseInt(s.trim(), 10))
                    .filter(n => Number.isInteger(n) && n >= 0);
                break;
            case "--quiet":
            case "-q":
                opts.quiet = true;
                break;
            case "--help":
            case "-h":
                usage(0);
                break;
            default:
                if (arg.startsWith("--")) {
                    console.error(`Unknown option ${arg}`);
                    usage(2);
                }
                positional.push(arg);
        }
    }
    if (positional.length !== 2) {
        usage(2);
    }
    return {imagePath: positional[0], manifestName: positional[1], ...opts};
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(args.imagePath)) {
        console.error(`No such image: ${args.imagePath}`);
        process.exit(1);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(args.manifestName)) {
        console.error(
            `Manifest name "${args.manifestName}" must be a URL-safe file name (letters, digits, . _ -).`
        );
        process.exit(1);
    }
    const name =
        args.name ??
        path.basename(args.imagePath, path.extname(args.imagePath));
    const manifestPath = path.join(args.manifestOut, `${args.manifestName}.json`);
    const log = args.quiet ? () => {} : s => process.stderr.write(s);

    const {manifest, stats} = chunkImage({
        imagePath: args.imagePath,
        outDir: args.out,
        manifestPath,
        name,
        prefetchChunks: args.prefetch,
        log,
    });

    console.log(
        [
            `wrote ${manifestPath}`,
            `  name: ${manifest.name}`,
            `  totalSize: ${manifest.totalSize} bytes`,
            `  chunks: ${stats.chunkCount} (${stats.uniqueChunks} unique, ${stats.zeroChunks} zero)`,
            `  chunk files: ${stats.written} written, ${stats.reused} already present in ${args.out}`,
            manifest.scrnResourceOffset !== undefined
                ? `  scrnResourceOffset: ${manifest.scrnResourceOffset}`
                : undefined,
        ]
            .filter(Boolean)
            .join("\n")
    );
}

const isCli =
    process.argv[1] &&
    path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isCli) {
    main();
}
