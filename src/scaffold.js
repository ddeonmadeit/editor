import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { buildLines, formatTranscript } from "./transcript.js";
import { ingest, wordsOf } from "./transcribe.js";
import { expandVideos, fmtDur } from "./util.js";

// Transcribes videos and writes a batch file with every transcript inline as comments,
// so an agent reads one file, fills in hooks and drops, and renders. Suggested retakes
// are pre-filled in drop.
export async function newBatch(batchFile, inputs, { ws = process.cwd(), use = "white", force, onLog, model, lang, prompt, backend } = {}) {
  const dest = path.resolve(ws, batchFile);
  if (fs.existsSync(dest) && !force) throw new Error(`${batchFile} already exists (use --force to overwrite, or reel transcript to read transcripts)`);
  const files = expandVideos(inputs, ws);
  if (!files.length) throw new Error(`no videos found in: ${inputs.join(" ")}`);
  const res = await ingest(files, { ws, onLog, model, lang, prompt, backend });
  const dir = path.dirname(dest);
  const out = [
    "# reel batch: write each hook (shown 0-4s), list the line numbers to cut in drop, then run: reel render " + path.relative(ws, dest),
    "# Transcript lines below are `n start text`; R>n = likely retake (redone in line n), pre-filled in drop. Remove from drop to keep.",
    "# More: broll, texts, highlight, music... see `reel help spec`.",
    `use: ${YAML.stringify(use, { lineWidth: 0 }).trim()}`,
    "out: out",
    "videos:",
  ];
  for (const r of res) {
    const t = r.transcript;
    const lines = buildLines(wordsOf(t));
    const retakes = lines.filter((l) => l.retakeOf).map((l) => l.id);
    out.push(`  - src: ${YAML.stringify(path.relative(dir, r.src), { lineWidth: 0 }).trim()}  # ${t.id} ${fmtDur(t.duration)}`);
    out.push(`    hook: ""`);
    out.push(`    drop: [${retakes.join(", ")}]`);
    for (const l of formatTranscript(t, lines, { header: false }).split("\n")) out.push(`    # ${l}`);
  }
  fs.writeFileSync(dest, `${out.join("\n")}\n`);
  return { file: dest, videos: res.length, cached: res.filter((r) => r.cached).length };
}
