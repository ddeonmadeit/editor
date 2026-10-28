import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadBatch, merge } from "../src/batch.js";
import { scanLibrary, searchLibrary } from "../src/broll.js";
import { captionEvents, chunkWords, parseNumber, textEvents } from "../src/captions.js";
import { buildEdit } from "../src/edl.js";
import { captionStyle } from "../src/styles.js";
import { applyFixes, buildLines, closest, findPhrase, formatTranscript, parseIds } from "../src/transcript.js";
import { mergeWords } from "../src/transcribe.js";
import { FPS, assColor } from "../src/util.js";

// Words spoken one every 0.3 s, with a pause before each sentence.
function fakeWords(sentences, { gap = 1 } = {}) {
  const words = [];
  let t = 0.5;
  for (const s of sentences) {
    for (const w of s.split(" ")) {
      words.push({ i: words.length, s: t, e: t + 0.25, w });
      t += 0.3;
    }
    t += gap;
  }
  return words;
}

test("whisper pieces merge into words", () => {
  const w = mergeWords([
    [0, 0.2, " I"],
    [0.2, 0.5, " lost"],
    [0.5, 0.7, " $50"],
    [0.7, 1.0, ",000"],
    [1.0, 1.2, " deal."],
  ]);
  assert.deepEqual(
    w.map((x) => x.w),
    ["I", "lost", "$50,000", "deal."],
  );
  assert.equal(w[2].e, 1.0);
});

test("lines split at sentences and retakes are flagged", () => {
  const words = fakeWords(["So when I locked in my first motel", "So when I locked in my first motel I put a deposit.", "What I did wrong was simple."]);
  const lines = buildLines(words);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].retakeOf, 2);
  assert.equal(lines[1].retakeOf, undefined);
  const text = formatTranscript({ id: "x", duration: 10 }, lines);
  assert.match(text, /^1 0\.5 So when I locked in my first motel {2}R>2$/m);
});

test("lines that only share small words aren't retakes", () => {
  const words = fakeWords(["and it needed it.", "The only thing it doesn't have is a restaurant, and you know what?"]);
  assert.equal(buildLines(words)[0].retakeOf, undefined);
});

test("line id lists", () => {
  assert.deepEqual([...parseIds("3, 5-7")], [3, 5, 6, 7]);
  assert.deepEqual([...parseIds([2, "9-8"])], [2, 8, 9]);
  assert.throws(() => parseIds("two"));
});

test("phrases are found ignoring case and punctuation", () => {
  const words = fakeWords(["I lost $50,000 on my first motel deal.", "So when I locked in my first motel,"]);
  assert.deepEqual(findPhrase(words, "first motel"), { w0: 5, w1: 6 });
  assert.deepEqual(findPhrase(words, "FIRST MOTEL", { from: 8 }), { w0: 14, w1: 15 });
  assert.deepEqual(findPhrase(words, "$50,000 on"), { w0: 2, w1: 3 });
  assert.equal(findPhrase(words, "second motel"), null);
  assert.equal(closest(words, "locked into"), "locked in");
});

test("spelling fixes replace words and phrases, keeping punctuation and indices", () => {
  const words = fakeWords(["I stayed in parks, at Travel Pinot University.", "Parks is great."]);
  const fixed = applyFixes(words, { parks: "Parkes", "Travel Pinot": "Travelpreneur" });
  assert.equal(fixed.length, words.length);
  assert.deepEqual(
    fixed.map((w) => w.w).filter(Boolean),
    ["I", "stayed", "in", "Parkes,", "at", "Travelpreneur", "University.", "Parkes", "is", "great."],
  );
  const tp = fixed.find((w) => w.w === "Travelpreneur");
  assert.equal(tp.e, words[tp.i + 1].e); // spans both original words
  assert.deepEqual(findPhrase(fixed, "Travelpreneur University"), { w0: 5, w1: 7 });
  assert.equal(words[3].w, "parks,"); // input untouched
});

test("edit: drops, pause cuts, frame-aligned segments, output times", () => {
  const words = fakeWords(["One two three.", "Four five six.", "Seven eight nine."], { gap: 1.5 });
  const lines = buildLines(words);
  const t = { duration: 12, env: null };
  const e = buildEdit(t, words, lines, { drop: [2], pacing: "normal" });
  assert.deepEqual(e.errors, []);
  assert.equal(e.segments.length, 2); // line 2 gone, pauses cut
  for (const s of e.segments) {
    assert.ok(Math.abs(s.s * FPS - Math.round(s.s * FPS)) < 1e-6);
    assert.ok(Math.abs(s.e * FPS - Math.round(s.e * FPS)) < 1e-6);
  }
  assert.deepEqual(
    e.kept.map((w) => w.w),
    ["One", "two", "three.", "Seven", "eight", "nine."],
  );
  for (let i = 1; i < e.kept.length; i++) assert.ok(e.kept[i].os >= e.kept[i - 1].oe - 1e-9);
  assert.ok(e.duration < 4.5, `duration ${e.duration}`);
});

test("edit: cut by phrase, fillers, unknown phrase suggests the closest", () => {
  const words = fakeWords(["So um I bought this motel", "and it was great."]);
  const lines = buildLines(words);
  const e = buildEdit({ duration: 10 }, words, lines, { cut: ["this motel"], pacing: "off" });
  assert.ok(!e.kept.some((w) => ["um", "this", "motel"].includes(w.w)));
  const bad = buildEdit({ duration: 10 }, words, lines, { cut: ["this hotel"] });
  assert.match(bad.errors[0], /closest: "this motel"/);
});

test("captions: chunks respect word and character limits", () => {
  const kept = fakeWords(["This motel in Parkes is double my age, and it has seen rough days."]).map((w) => ({ ...w, os: w.s, oe: w.e }));
  const chunks = chunkWords(kept, { words: 3, chars: 16 });
  for (const c of chunks) {
    assert.ok(c.words.length <= 3);
    assert.ok(c.text.length <= 16 || c.words.length === 1, c.text);
    assert.ok(c.end > c.start);
  }
  assert.ok(chunks.some((c) => c.text.endsWith("age,")));
  const ev = captionEvents(chunks, captionStyle({ style: "green" }), { highlight: ["Parkes"] });
  assert.ok(ev.some((l) => l.includes("PARKES") && l.includes(assColor("#ffe600"))));
});

test("counter text ticks up and ends on the real value", () => {
  assert.deepEqual(parseNumber("-$50,000"), { pre: "-$", n: 50000, post: "", commas: true, decimals: 0 });
  const ev = textEvents([{ text: "-$50,000", style: "red", count: 1, start: 0, end: 3 }]);
  const texts = ev.filter((l) => l.startsWith("Dialogue: 2")).map((l) => l.split("}").pop());
  assert.equal(texts.at(-1), "-$50,000");
  assert.ok(texts.length > 20);
  assert.ok(texts.includes("-$1"));
});

test("batch: shorthands, looks, per-video looks, typo hints", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-test-"));
  fs.mkdirSync(path.join(dir, "raw"));
  for (const f of ["a.mp4", "b.mp4"]) fs.writeFileSync(path.join(dir, "raw", f), "");
  const b = loadBatch(
    {
      use: "white",
      defaults: { pacing: "tight" },
      videos: [
        { src: "raw/a.mp4", hook: "Hello 👋", broll: ["new floors"] },
        { src: "raw/b.mp4", use: "green", captions: { size: 100 }, brol: [] },
      ],
    },
    { ws: dir },
  );
  assert.equal(b.videos.length, 2);
  assert.equal(b.videos[0].hook.text, "Hello 👋");
  assert.equal(b.videos[0].hook.dur, 4);
  assert.equal(b.videos[0].captions.style, "white");
  assert.equal(b.videos[1].captions.style, "green");
  assert.equal(b.videos[1].captions.size, 100);
  assert.equal(b.videos[1].pacing, "tight");
  assert.match(b.warnings.join("\n"), /"brol".*did you mean "broll"/);
  const g = loadBatch({ videos: [{ src: "raw/*.mp4", hook: "x" }] }, { ws: dir });
  assert.equal(g.videos.length, 2);
  assert.deepEqual(merge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
});

test("b-roll library search uses folder names, file names and tags", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-lib-"));
  fs.mkdirSync(path.join(dir, "motel"));
  for (const f of ["motel/aircon-unit.mp4", "motel/IMG_2034.MOV", "pool.mp4"]) fs.writeFileSync(path.join(dir, f), "");
  fs.writeFileSync(path.join(dir, "motel", "tags.yaml"), "IMG_2034.MOV: new floor tiles being laid\n");
  const lib = scanLibrary([dir]);
  assert.equal(searchLibrary(lib, "aircon").name, path.join("motel", "aircon-unit.mp4"));
  assert.equal(searchLibrary(lib, "new floors").name, path.join("motel", "IMG_2034.MOV"));
  assert.equal(searchLibrary(lib, "swimming pools").name, "pool.mp4");
  assert.equal(searchLibrary(lib, "lawyer office"), null);
});
