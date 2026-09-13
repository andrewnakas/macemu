import { readFileSync } from "node:fs";
const g = globalThis;
new Function(readFileSync("public/macbin.js", "utf8")).call(g);
const { MacBinary, BinHex, DiskCopy, identify, crc16 } = g.MacBin;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name + " " + extra); } };
const put32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o+1] = (v >>> 16) & 255; b[o+2] = (v >>> 8) & 255; b[o+3] = v & 255; };
const put16 = (b, o, v) => { b[o] = (v >> 8) & 255; b[o+1] = v & 255; };
const put = (b, o, s) => { for (let i = 0; i < s.length; i++) b[o+i] = s.charCodeAt(i); };
const pad128 = (n) => (n + 127) & ~127;

console.log("MacBinary II round trip");
{
  const name = "SimpleText", type = "APPL", creator = "ttxt";
  const data = new Uint8Array(300).map((_, i) => (i * 7) & 255);
  const rsrc = new Uint8Array(500).map((_, i) => (i * 13 + 5) & 255);
  const total = 128 + pad128(data.length) + pad128(rsrc.length);
  const f = new Uint8Array(total);
  f[0] = 0; f[1] = name.length; put(f, 2, name);
  put(f, 65, type); put(f, 69, creator);
  put32(f, 83, data.length); put32(f, 87, rsrc.length);
  f[122] = 0x81; f[123] = 0x81;
  put16(f, 124, crc16(f, 0, 124, 0));
  f.set(data, 128); f.set(rsrc, 128 + pad128(data.length));

  ok("is() detects it", MacBinary.is(f));
  const d = MacBinary.decode(f);
  ok("name", d.name === name, d.name);
  ok("type/creator", d.type === type && d.creator === creator);
  ok("data fork bytes match", Buffer.compare(Buffer.from(d.data), Buffer.from(data)) === 0);
  ok("rsrc fork bytes match", Buffer.compare(Buffer.from(d.rsrc), Buffer.from(rsrc)) === 0);
  ok("identify routes to macbinary", identify(f, "thing.bin").kind === "macbinary");
}

console.log("BinHex 4.0 round trip");
{
  // Encode with an independent implementation, then decode with ours.
  const A = "!\"#$%&'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr";
  const name = "ReadMe", type = "TEXT", creator = "ttxt";
  const data = new Uint8Array([1,2,3,4,5,5,5,5,5,5,5,5,9,0x90,7,7]);
  const rsrc = new Uint8Array([0xaa,0xbb,0xcc]);
  const body = [];
  body.push(name.length); for (const c of name) body.push(c.charCodeAt(0));
  body.push(0); for (const c of type) body.push(c.charCodeAt(0)); for (const c of creator) body.push(c.charCodeAt(0));
  body.push(0, 0);
  body.push((data.length>>>24)&255,(data.length>>>16)&255,(data.length>>>8)&255,data.length&255);
  body.push((rsrc.length>>>24)&255,(rsrc.length>>>16)&255,(rsrc.length>>>8)&255,rsrc.length&255);
  body.push(0, 0);
  for (const b of data) body.push(b); body.push(0, 0);
  for (const b of rsrc) body.push(b); body.push(0, 0);
  // RLE encode
  const rle = [];
  for (let i = 0; i < body.length;) {
    const b = body[i];
    if (b === 0x90) { rle.push(0x90, 0); i++; continue; }
    let run = 1; while (i + run < body.length && body[i+run] === b && run < 255) run++;
    if (run > 3) { rle.push(b, 0x90, run); i += run; } else { for (let k = 0; k < run; k++) rle.push(b); i += run; }
  }
  let text = "(This file must be converted with BinHex 4.0)\n\n:";
  let acc = 0, bits = 0, col = 0;
  for (const b of rle) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 6) { bits -= 6; text += A[(acc >> bits) & 63]; if (++col === 64) { text += "\n"; col = 0; } }
  }
  if (bits) { text += A[(acc << (6 - bits)) & 63]; }
  text += ":\n";
  const f = Uint8Array.from(Buffer.from(text, "latin1"));

  ok("is() detects it", BinHex.is(f));
  const d = BinHex.decode(f);
  ok("name", d.name === name, d.name);
  ok("type/creator", d.type === type && d.creator === creator, d.type + "/" + d.creator);
  ok("data fork round-trips (incl. RLE runs and literal 0x90)", Buffer.compare(Buffer.from(d.data), Buffer.from(data)) === 0, Buffer.from(d.data).toString("hex"));
  ok("rsrc fork round-trips", Buffer.compare(Buffer.from(d.rsrc), Buffer.from(rsrc)) === 0);
  ok("identify routes to binhex", identify(f, "x.hqx").kind === "binhex");
}

console.log("DiskCopy 4.2");
{
  const disk = new Uint8Array(819200).map((_, i) => (i * 31) & 255);
  const f = new Uint8Array(84 + disk.length);
  const vol = "Install Disk 1";
  f[0] = vol.length; put(f, 1, vol);
  put32(f, 0x40, disk.length); put32(f, 0x44, 0);
  put16(f, 0x52, 0x0100);
  f.set(disk, 84);
  ok("is() detects the header", DiskCopy.is(f));
  ok("volume name", DiskCopy.volumeName(f) === vol, DiskCopy.volumeName(f));
  ok("strip() yields the raw disk", Buffer.compare(Buffer.from(DiskCopy.strip(f)), Buffer.from(disk)) === 0);
  const id = identify(f, "disk1.img");
  ok("identify → disk, floppy", id.kind === "disk" && id.isFloppy === true, id.kind + " floppy=" + id.isFloppy);
  ok("raw 800K image also → floppy", identify(disk, "raw.img").isFloppy === true);
  ok("strip() leaves a raw image alone", Buffer.compare(Buffer.from(DiskCopy.strip(disk)), Buffer.from(disk)) === 0);
}

console.log("dispatch and negatives");
{
  const hd = new Uint8Array(40 * 1024 * 1024);
  const id = identify(hd, "big.img");
  ok("40 MB image → disk, not floppy", id.kind === "disk" && id.isFloppy === false);
  ok(".toast → cdrom", identify(new Uint8Array(1024), "cd.toast").kind === "cdrom");
  ok(".sit → opaque", identify(Uint8Array.from(Buffer.from("StuffIt (c)1997", "latin1")), "a.sit").kind === "opaque");
  ok("random bytes are not MacBinary", !MacBinary.is(Uint8Array.from(Buffer.from("hello world this is plain text and not a mac file at all, really", "latin1"))));
  ok("text without the banner is not BinHex", !BinHex.is(Uint8Array.from(Buffer.from("just some text", "latin1"))));
  ok("odd-sized .img is not treated as a disk", identify(new Uint8Array(1000), "weird.img").kind === "opaque");
  let threw = false; try { BinHex.decode(Uint8Array.from(Buffer.from("(This file must be converted with BinHex 4.0)\n\n:abc", "latin1"))); } catch { threw = true; }
  ok("truncated BinHex throws rather than returning nonsense", threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
