import fs from "node:fs";
import path from "node:path";
import { FFMPEG, decodeAudio, envelope, probe } from "./media.js";
import { ROOT, ensureDir, readJSON, run, slug, stateDir, withLock, writeJSON } from "./util.js";

export const DEFAULT_MODEL = process.env.REEL_WHISPER_MODEL || "small.en";
// Bumped when transcription changes in a way that makes old transcripts worth redoing.
const VERSION = 2;

const indexFile = (ws) => path.join(stateDir(ws), "index.json");
const transcriptFile = (ws, id) => path.join(stateDir(ws), "transcripts", `${id}.json`);

// Stable short id per source file ("IMG_1201"), unique within the workspace. The index is
// locked while it changes, since several agents may ingest at once.
export async function idFor(ws, src) {
  const abs = path.resolve(ws, src);
  const known = readJSON(indexFile(ws), {})[abs];
  if (known) return known;
  return withLock(`${indexFile(ws)}.lock`, () => {
    const index = readJSON(indexFile(ws), {});
    if (index[abs]) return index[abs];
    const taken = new Set(Object.values(index));
    const base = slug(path.basename(abs).replace(/\.[^.]+$/, ""));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    index[abs] = id;
    writeJSON(indexFile(ws), index);
    return id;
  });
}

export function listIngested(ws) {
  const index = readJSON(indexFile(ws), {});
  return Object.entries(index).map(([src, id]) => ({ id, src, ready: fs.existsSync(transcriptFile(ws, id)) }));
}

// Loads a transcript by id or by source path. Returns null when it hasn't been ingested.
export function loadTranscript(ws, idOrSrc) {
  let id = idOrSrc;
  const abs = path.resolve(ws, idOrSrc);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) id = readJSON(indexFile(ws), {})[abs];
  if (!id) return null;
  const t = readJSON(transcriptFile(ws, id));
  if (t && t.env && !(t.env instanceof Uint8Array)) t.env = new Uint8Array(Buffer.from(t.env, "base64"));
  return t;
}

const fresh = (t, st, model) => t && t.v === VERSION && t.size === st.size && t.mtime === Math.round(st.mtimeMs) && (!model || t.model === model);

// Whisper word pieces like ",000" or "'s" belong to the word before them.
export function mergeWords(raw) {
  const out = [];
  for (const [s, e, text] of raw) {
    const t = String(text);
    const prev = out[out.length - 1];
    const glued = prev && !/^\s/.test(t) && (/^[^A-Za-z]/.test(t) || /[-$]$/.test(prev.w) || s - prev.e < 0.02);
    if (glued) {
      prev.w += t.trim();
      prev.e = Math.max(prev.e, e);
    } else if (t.trim()) {
      out.push({ s, e: Math.max(e, s + 0.04), w: t.trim() });
    }
  }
  return out;
}

function pythonBin() {
  if (process.env.REEL_PYTHON) return process.env.REEL_PYTHON;
  for (const p of [path.join(ROOT, ".venv", "bin", "python"), path.join(ROOT, ".venv", "Scripts", "python.exe")]) if (fs.existsSync(p)) return p;
  return "python3";
}

async function whisperLocal(files, { model, lang, prompt, onLog }) {
  const args = [path.join(ROOT, "py", "transcribe.py"), "--model", model, ...(lang ? ["--lang", lang] : []), ...(prompt ? ["--prompt", prompt] : []), ...files];
  const results = new Map();
  let buf = "";
  try {
    await run(pythonBin(), args, {
      onStdout: (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) {
            const j = JSON.parse(line);
            results.set(j.file, j);
          }
        }
      },
      onStderr: (d) => {
        for (const l of d.split("\n")) if (/^\[\d+\/\d+\]/.test(l)) onLog?.(`transcribing ${l}`);
      },
    });
  } catch (e) {
    if (/No module named 'faster_whisper'|not found/.test(e.message)) throw new Error("faster-whisper isn't installed. Run: reel setup   (or set OPENAI_API_KEY and use --backend openai)");
    throw e;
  }
  return results;
}

// OpenAI's word timestamps carry no punctuation, so it is copied back from the full text.
async function whisperOpenAI(files, { lang, prompt, onLog }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const results = new Map();
  for (const file of files) {
    onLog?.(`transcribing ${path.basename(file)} (openai)`);
    const { stdout } = await run(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-"]);
    const form = new FormData();
    form.append("file", new Blob([stdout], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (lang) form.append("language", lang);
    if (prompt) form.append("prompt", prompt);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    if (!r.ok) throw new Error(`OpenAI transcription failed: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    const text = j.text || "";
    let pos = 0;
    const words = (j.words || []).map((w) => {
      const at = text.indexOf(w.word, pos);
      let word = w.word;
      if (at >= 0) {
        let end = at + w.word.length;
        while (end < text.length && /[^\s\w]/.test(text[end])) end++;
        word = text.slice(at, end);
        pos = end;
      }
      return [w.start, w.end, ` ${word}`];
    });
    results.set(file, { file, duration: j.duration, language: j.language, words });
  }
  return results;
}

// Transcribes (and caches) every file. Returns one summary per file.
// A transcript is reused while its file is unchanged, unless a different model is asked for.
export async function ingest(files, { ws = process.cwd(), model, lang, prompt, backend, force, onLog } = {}) {
  const asked = backend === "openai" ? "openai/whisper-1" : model;
  model = model || DEFAULT_MODEL;
  const todo = [];
  const out = [];
  for (const f of files) {
    const src = path.resolve(ws, f);
    if (!fs.existsSync(src)) throw new Error(`not found: ${f}`);
    const id = await idFor(ws, src);
    const st = fs.statSync(src);
    const t = force ? null : loadTranscript(ws, id);
    const item = { id, src, st };
    if (fresh(t, st, asked)) item.t = t;
    else todo.push(item);
    out.push(item);
  }
  if (todo.length) {
    const useOpenAI = backend === "openai";
    const res = await (useOpenAI ? whisperOpenAI : whisperLocal)(
      todo.map((x) => x.src),
      { model, lang, prompt, onLog },
    );
    for (const item of todo) {
      const r = res.get(item.src);
      if (!r) throw new Error(`no transcript returned for ${item.src}`);
      item.t = await saveTranscript(ws, item.src, { words: r.words, pieces: true, language: r.language, model: useOpenAI ? "openai/whisper-1" : model, duration: r.duration });
      item.fresh = true;
    }
  }
  return out.map(({ id, src, t, fresh: f }) => ({ id, src, transcript: t, cached: !f }));
}

// Stores a transcript for a source file. `words` is [[start, end, text], ...]; with
// `pieces`, they are whisper's word pieces (" lost", ",000") and get merged. Also used to
// import transcripts made elsewhere (one entry per word).
export async function saveTranscript(ws, src, { words, pieces = false, language = "en", model = "import", duration } = {}) {
  src = path.resolve(ws, src);
  const id = await idFor(ws, src);
  const st = fs.statSync(src);
  const [info, samples] = await Promise.all([probe(src), decodeAudio(src).catch(() => new Float32Array(0))]);
  const t = {
    v: VERSION,
    id,
    src,
    size: st.size,
    mtime: Math.round(st.mtimeMs),
    model,
    language,
    duration: info.duration || duration,
    video: { width: info.width, height: info.height, fps: Math.round(info.fps * 100) / 100, hdr: info.hdr },
    words: mergeWords(pieces ? words : words.map(([a, b, w]) => [a, b, ` ${String(w).trim()}`])).map((w) => [w.s, w.e, w.w]),
    env: Buffer.from(envelope(samples)).toString("base64"),
  };
  writeJSON(transcriptFile(ws, id), t);
  return loadTranscript(ws, id);
}

// Words as objects: { i, s, e, w }.
export const wordsOf = (t) => t.words.map(([s, e, w], i) => ({ i, s, e, w }));

export function transcriptDir(ws) {
  return ensureDir(path.join(stateDir(ws), "transcripts"));
}
