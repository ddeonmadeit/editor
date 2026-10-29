import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { aiMarker } from "../src/aicheck.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-aicheck-"));
const file = (name, ...parts) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))));
  return f;
};
const u16 = (n) => Buffer.from([n >> 8, n & 255]);
const u32 = (n) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), Buffer.from(payload)]);
const chunk = (type, data) => Buffer.concat([u32(data.length), Buffer.from(type), Buffer.from(data), u32(0)]);
const box = (type, data) => Buffer.concat([u32(data.length + 8), Buffer.from(type), Buffer.from(data)]);
const SOI = Buffer.from([0xff, 0xd8]), PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Compressed-looking picture data that happens to spell generator names: never read.
const pixels = Buffer.from("\xff\xda\x00\x02 openai midjourney stable diffusion \xff\xd9", "latin1");

test("AI marks in metadata: IPTC/C2PA source type, generator text, SD prompt settings", () => {
  const xmp = `http://ns.adobe.com/xap/1.0/\0<rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>`;
  assert.equal(aiMarker(file("xmp.jpg", SOI, seg(0xe1, xmp), pixels)), "algorithmicmedia");
  // A C2PA manifest split over two APP11 segments, cut through the middle of the source type.
  const manifest = Buffer.from("c2pa.actions digitalSourceType http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia");
  const cut = manifest.indexOf("Algorithmic") + 4;
  const jumbf = (z, body) => seg(0xeb, Buffer.concat([Buffer.from("JP"), u16(1), u32(z), u32(9999), Buffer.from("jumb"), body]));
  assert.equal(aiMarker(file("c2pa.jpg", SOI, jumbf(1, manifest.subarray(0, cut)), jumbf(2, manifest.subarray(cut)), pixels)), "algorithmicmedia");
  // Stable Diffusion web UI settings in a PNG text chunk; NovelAI in a compressed one.
  const ihdr = chunk("IHDR", Buffer.alloc(13));
  assert.equal(aiMarker(file("sd.png", PNG, ihdr, chunk("tEXt", "parameters\0a motel at dusk\nNegative prompt: blurry\nSteps: 20, Sampler: Euler a, CFG scale: 7"), chunk("IEND", ""))), "negative prompt");
  assert.equal(aiMarker(file("nai.png", PNG, ihdr, chunk("zTXt", Buffer.concat([Buffer.from("Software\0\0"), zlib.deflateSync("NovelAI")])), chunk("IEND", ""))), "novelai");
  // An MP4 with a C2PA uuid box.
  assert.equal(aiMarker(file("c2pa.mp4", box("ftyp", "isom"), box("uuid", "c2pa trainedAlgorithmicMedia"), box("mdat", "x"))), "algorithmicmedia");
});

test("no AI marks: camera metadata, and generator names inside picture data aren't read", () => {
  assert.equal(aiMarker(file("camera.jpg", SOI, seg(0xe1, "Exif\0\0Canon EOS R5 Adobe Lightroom"), pixels)), null);
  assert.equal(aiMarker(file("plain.png", PNG, chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", "openai midjourney"), chunk("IEND", ""))), null);
  assert.equal(aiMarker(file("plain.mp4", box("ftyp", "isom"), box("moov", "udta Lavf60"), box("mdat", "openai trainedAlgorithmicMedia"))), null);
  assert.equal(aiMarker(path.join(dir, "missing.jpg")), null);
});
