// Classic Macintosh file-format decoders, in plain browser JavaScript.
//
// A Macintosh file was never one stream of bytes. It had a DATA fork (what
// every other system means by "a file") and a RESOURCE fork (a small structured
// database holding icons, dialogs, sounds and very often the executable code),
// plus a four-character type and creator code stored outside the file. Send one
// through anything that assumed a file is one stream — FTP in text mode, a mail
// gateway, a DOS floppy — and the resource fork silently disappeared, leaving a
// file that looked fine and did nothing.
//
// MacBinary and BinHex both exist to carry all of that through a hostile
// transport. Decoding them here, in the browser, means a file the visitor drops
// in arrives at the emulated Mac with its fork and metadata intact — which is
// the difference between an application that runs and one that bounces.
//
// Exposes window.MacBin. No dependencies, no build step.
(function (global) {
  "use strict";

  const ascii = (bytes, off, len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
    return s;
  };
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const be16 = (b, o) => ((b[o] << 8) | b[o + 1]) >>> 0;

  // CRC-16/XMODEM, which is what both MacBinary II and BinHex use.
  function crc16(bytes, start, end, seed) {
    let crc = seed || 0;
    for (let i = start; i < end; i++) {
      crc ^= bytes[i] << 8;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc & 0xffff;
  }

  // ── MacBinary ────────────────────────────────────────────────────────────
  // 128-byte header, then the data fork padded to a 128-byte boundary, then the
  // resource fork padded the same way. Version II (1987) put a CRC of the first
  // 124 header bytes at offset 124, which is the only reliable way to tell a
  // MacBinary file from something that merely starts with a zero.
  const MB = {
    /** Sniff without decoding. Cheap enough to run on every dropped file. */
    is(bytes) {
      if (!bytes || bytes.length < 128) return false;
      if (bytes[0] !== 0 || bytes[74] !== 0) return false;
      const nameLen = bytes[1];
      if (nameLen < 1 || nameLen > 63) return false;
      // MacBinary II: trust the CRC.
      if (bytes[122] >= 0x81 && crc16(bytes, 0, 124, 0) === be16(bytes, 124)) return true;
      // MacBinary I has no CRC, so fall back to the fork lengths making sense.
      const dataLen = be32(bytes, 83), rsrcLen = be32(bytes, 87);
      if (dataLen > 0x7fffffff || rsrcLen > 0x7fffffff) return false;
      const expected = 128 + pad128(dataLen) + pad128(rsrcLen);
      return bytes.length >= expected && bytes.length < expected + 128;
    },

    decode(bytes) {
      if (bytes.length < 128) throw new Error("MacBinary: file is shorter than its header");
      const nameLen = Math.min(bytes[1], 63);
      const name = ascii(bytes, 2, nameLen);
      const type = ascii(bytes, 65, 4);
      const creator = ascii(bytes, 69, 4);
      const dataLen = be32(bytes, 83);
      const rsrcLen = be32(bytes, 87);
      const dataStart = 128;
      const rsrcStart = dataStart + pad128(dataLen);
      if (rsrcStart + rsrcLen > bytes.length) throw new Error("MacBinary: truncated — the resource fork runs past the end of the file");
      return {
        name, type, creator,
        data: bytes.subarray(dataStart, dataStart + dataLen),
        rsrc: bytes.subarray(rsrcStart, rsrcStart + rsrcLen),
        finderFlags: be16(bytes, 73),
      };
    },
  };
  const pad128 = (n) => (n + 127) & ~127;

  // ── BinHex 4.0 ───────────────────────────────────────────────────────────
  // A whole Macintosh file rendered as printable text so it could be pasted
  // into an email body in 1988 and survive. The payload is run-length encoded,
  // then packed six bits at a time into a 64-character alphabet, and the whole
  // thing is fenced by colons after a literal announcement line.
  const HQX_ALPHABET = "!\"#$%&'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr";
  const HQX_RLE = 0x90;

  const HQX = {
    is(bytes) {
      // The announcement line is mandated by the format and is the reliable
      // signal. Look only at the head: these files can be megabytes of text.
      const head = ascii(bytes, 0, Math.min(bytes.length, 2048));
      return /\(This file must be converted with BinHex/i.test(head);
    },

    decode(bytes) {
      const text = ascii(bytes, 0, bytes.length);
      const start = text.indexOf(":", text.search(/\(This file must be converted with BinHex[^\n]*\n/i));
      if (start < 0) throw new Error("BinHex: no opening colon — the file may be truncated or not BinHex at all");
      const end = text.indexOf(":", start + 1);
      if (end < 0) throw new Error("BinHex: no closing colon — the file is truncated");

      // 6-bit unpack, skipping whitespace.
      const out = [];
      let acc = 0, bits = 0;
      for (let i = start + 1; i < end; i++) {
        const ch = text[i];
        if (ch === "\n" || ch === "\r" || ch === " " || ch === "\t") continue;
        const v = HQX_ALPHABET.indexOf(ch);
        if (v < 0) throw new Error(`BinHex: character ${JSON.stringify(ch)} is not in the BinHex alphabet`);
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
      }

      // Run-length decode: 0x90 followed by a count repeats the previous byte;
      // a count of zero means a literal 0x90.
      const un = [];
      for (let i = 0; i < out.length; i++) {
        if (out[i] === HQX_RLE) {
          const count = out[++i];
          if (count === 0) { un.push(HQX_RLE); continue; }
          const prev = un[un.length - 1];
          for (let k = 1; k < count; k++) un.push(prev);
        } else un.push(out[i]);
      }

      const b = Uint8Array.from(un);
      let o = 0;
      const nameLen = b[o++];
      if (!nameLen || nameLen > 63) throw new Error("BinHex: implausible filename length — decode failed");
      const name = ascii(b, o, nameLen); o += nameLen;
      o++; // version byte, always 0
      const type = ascii(b, o, 4); o += 4;
      const creator = ascii(b, o, 4); o += 4;
      const finderFlags = be16(b, o); o += 2;
      const dataLen = be32(b, o); o += 4;
      const rsrcLen = be32(b, o); o += 4;
      o += 2; // header CRC
      if (o + dataLen + rsrcLen + 4 > b.length) throw new Error("BinHex: truncated — the forks run past the end of the decoded data");
      const data = b.subarray(o, o + dataLen); o += dataLen + 2; // fork + its CRC
      const rsrc = b.subarray(o, o + rsrcLen);
      return { name, type, creator, data, rsrc, finderFlags };
    },
  };

  // ── DiskCopy 4.2 ─────────────────────────────────────────────────────────
  // Apple's floppy imaging format and the one most preserved Mac floppies are
  // in: an 84-byte header carrying the volume name, the data and tag lengths
  // and checksums, then the raw disk. Emulators want the raw disk, so the job
  // here is to recognise the header and skip it — and, critically, NOT to skip
  // 84 bytes off a raw image that never had one.
  const DC42 = {
    is(bytes) {
      if (!bytes || bytes.length < 84) return false;
      if (bytes[0] > 63) return false;               // Pascal volume-name length
      if (be16(bytes, 0x52) !== 0x0100) return false; // the format's magic
      const dataLen = be32(bytes, 0x40);
      const tagLen = be32(bytes, 0x44);
      if (dataLen === 0 || dataLen % 512 !== 0) return false;
      return bytes.length >= 84 + dataLen + tagLen;
    },
    /** The raw disk, header removed. Returns the input untouched if there is none. */
    strip(bytes) {
      if (!DC42.is(bytes)) return bytes;
      return bytes.subarray(84, 84 + be32(bytes, 0x40));
    },
    volumeName(bytes) {
      return DC42.is(bytes) ? ascii(bytes, 1, bytes[0]) : null;
    },
  };

  // ── dispatch ─────────────────────────────────────────────────────────────
  // Standard Macintosh floppy sizes. An image at one of these is offered to the
  // emulator as a floppy; anything larger is attached as a hard disk. The
  // distinction matters because the Mac will only try to boot from a floppy.
  const FLOPPY_SIZES = new Set([409600, 819200, 1474560, 737280]);

  /**
   * Work out what a dropped file is, from its bytes rather than its name.
   * Extensions lie constantly in this corner of computing: .img means four
   * different container formats depending on the decade.
   *
   * Returns { kind, ... } where kind is one of:
   *   "macbinary" | "binhex"  → { file: {name,type,creator,data,rsrc} }
   *   "disk"                  → { bytes, isFloppy, volumeName }
   *   "cdrom"                 → { bytes }
   *   "opaque"                → { bytes }   copy it across and let the Mac decide
   */
  function identify(bytes, filename) {
    const ext = String(filename || "").toLowerCase().match(/\.[a-z0-9]+$/);
    const e = ext ? ext[0] : "";

    if (MB.is(bytes)) return { kind: "macbinary", file: MB.decode(bytes) };
    if (HQX.is(bytes)) return { kind: "binhex", file: HQX.decode(bytes) };

    if (DC42.is(bytes)) {
      const raw = DC42.strip(bytes);
      return { kind: "disk", bytes: raw, isFloppy: FLOPPY_SIZES.has(raw.length), volumeName: DC42.volumeName(bytes) };
    }

    if (e === ".iso" || e === ".toast" || e === ".cdr") return { kind: "cdrom", bytes };

    // A raw image has no header to recognise, so size is the only evidence:
    // a whole number of 512-byte sectors, and either a standard floppy size or
    // something large enough to be a plausible hard disk.
    if ([".img", ".dsk", ".hfv", ".image", ".hda", ".dc42"].includes(e)) {
      if (bytes.length % 512 === 0) {
        return { kind: "disk", bytes, isFloppy: FLOPPY_SIZES.has(bytes.length), volumeName: null };
      }
    }

    // Archives (.sit, .sea, .cpt, .zip) and everything unrecognised: hand it to
    // the Mac as an ordinary file. StuffIt Expander is on the boot disk.
    return { kind: "opaque", bytes };
  }

  global.MacBin = { MacBinary: MB, BinHex: HQX, DiskCopy: DC42, identify, crc16, FLOPPY_SIZES };
})(typeof window !== "undefined" ? window : globalThis);
