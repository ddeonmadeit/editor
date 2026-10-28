import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { resolveBroll } from "./broll.js";
import { assFile, captionEvents, chunkWords, textEvents } from "./captions.js";
import { buildEdit } from "./edl.js";
import { HOOKGEN_FONT_PX, renderHooks } from "./hooks.js";
import { probe } from "./media.js";
import { renderPlan } from "./render.js";
import { CAPTION_STYLES, POSITIONS, captionStyle } from "./styles.js";
import { applyFixes, buildLines, closest, findPhrase } from "./transcript.js";
import { ingest, loadTranscript, wordsOf } from "./transcribe.js";
import { H, IMAGE_EXT, ROOT, W, ensureDir, expandVideos, fmtDur, pngSize, pool, renderSlot, round, stateDir } from "./util.js";

// Every setting a video can have, with its default. A batch's `use:` looks, its
// `defaults:` and each video's own keys are merged over these, in that order.
export const DEFAULTS = {
  pacing: "normal", // how hard pauses are cut: tight | normal | loose | off
  fillers: true, // remove um/uh
  retakes: false, // "auto" drops lines the transcript flags as retakes
  zoom: 1.1, // punch-in on every other cut (1 or false = off)
  focus: 0.35, // where punch-ins aim, 0 = top .. 1 = bottom
  fit: "cover", // non-vertical sources: cover (crop) | blur (fit on blurred fill)
  speed: 1,
  grade: null,
  hook: { preset: "tiktok-classic", dur: 4, y: 0.5, size: 84, maxWidth: 1000, style: {} },
  captions: { style: "white", afterHook: true },
  highlight: [],
  fix: {}, // caption spelling: { parks: Parkes, "Travel Pinot": Travelpreneur }
  broll: [], // clips over the speaker: "phrase" | { at, q | src | pexels, dur, layout }
  library: ["broll"], // your B-roll folders, searched before Pexels
  texts: [],
  flash: [],
  sfx: [],
  music: null,
  audio: { loudness: -14, enhance: true, denoise: false },
  quality: "high",
  encoder: "auto",
};

const VIDEO_KEYS = new Set([...Object.keys(DEFAULTS), "src", "name", "use", "drop", "cut", "keep", "trim", "splitFocus"]);
const TOP_KEYS = new Set(["out", "use", "defaults", "videos", "jobs", "quality", "encoder"]);

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export function merge(a, b) {
  if (b === undefined) return a;
  if (!isObj(a) || !isObj(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
  return out;
}

export function lookFile(name, base) {
  for (const p of [path.resolve(base, name), path.resolve(base, `${name}.yaml`), path.join(ROOT, "presets", `${name}.yaml`)]) if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  return null;
}

export function listLooks() {
  return fs.readdirSync(path.join(ROOT, "presets")).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
}

// Shorthands agents can write: hook: "text", captions: "green" / false, music: "file.mp3".
function expand(v) {
  const o = { ...v };
  if (typeof o.hook === "string") o.hook = { text: o.hook };
  if (typeof o.captions === "string") o.captions = { style: o.captions };
  if (typeof o.music === "string") o.music = { src: o.music };
  if (o.zoom === false) o.zoom = 1;
  return o;
}

function suggest(key, keys) {
  let best = null, bd = 99;
  for (const k of keys) {
    const d = lev(key.toLowerCase().replace(/[-_]/g, ""), k.toLowerCase());
    if (d < bd) [best, bd] = [k, d];
  }
  return bd <= 3 ? ` (did you mean "${best}"?)` : "";
}
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Reads a batch (YAML/JSON file path, YAML text, or object) into one settings object per
// video. Paths in the batch are relative to the batch file.
export function loadBatch(input, { ws = process.cwd() } = {}) {
  let spec, base = ws;
  if (isObj(input)) spec = input;
  else if (typeof input === "string" && !input.includes("\n") && fs.existsSync(path.resolve(ws, input))) {
    const file = path.resolve(ws, input);
    base = path.dirname(file);
    spec = YAML.parse(fs.readFileSync(file, "utf8"));
  } else spec = YAML.parse(String(input));
  if (!isObj(spec)) throw new Error("batch must be a YAML/JSON object with a `videos:` list");
  const warnings = [];
  for (const k of Object.keys(spec)) if (!TOP_KEYS.has(k)) warnings.push(`unknown top-level key "${k}"${suggest(k, TOP_KEYS)}`);
  if (!Array.isArray(spec.videos) || !spec.videos.length) throw new Error("batch needs a `videos:` list (each item at least { src: file })");

  const withLooks = (into, use, label) => {
    for (const look of [].concat(use || [])) {
      const f = lookFile(look, base);
      if (!f) throw new Error(`${label}: look "${look}" not found (built in: ${listLooks().join(", ")})`);
      into = merge(into, expand(YAML.parse(fs.readFileSync(f, "utf8")) || {}));
    }
    return into;
  };
  let defaults = withLooks(DEFAULTS, spec.use, "use");
  defaults = merge(defaults, expand(spec.defaults || {}));
  for (const k of ["quality", "encoder"]) if (spec[k]) defaults = { ...defaults, [k]: spec[k] };
  const outDir = path.resolve(base, spec.out || "out");

  const videos = [];
  spec.videos.forEach((raw, i) => {
    const v0 = typeof raw === "string" ? { src: raw } : raw;
    if (!isObj(v0) || !v0.src) throw new Error(`videos[${i}]: needs src`);
    for (const k of Object.keys(v0)) if (!VIDEO_KEYS.has(k)) warnings.push(`videos[${i}]: unknown key "${k}"${suggest(k, VIDEO_KEYS)}`);
    const files = expandVideos([v0.src], base);
    if (!files.length) throw new Error(`videos[${i}].src: no file matches "${v0.src}"`);
    // A video's own `use:` swaps the look but keeps the batch's `defaults:`.
    const base0 = v0.use ? merge(withLooks(DEFAULTS, v0.use, `videos[${i}].use`), expand(spec.defaults || {})) : defaults;
    for (const src of files) {
      const v = merge(base0, expand(v0));
      v.src = src;
      v.base = base;
      v.index = i;
      if (files.length > 1) delete v.name; // a glob can't share one output name
      videos.push(v);
    }
  });
  return { videos, outDir, jobs: spec.jobs, warnings, base };
}

// Resolves `at:` (seconds, a phrase, or { line: n }) to an output time window.
function locate(ref, ctx, label) {
  const { kept, orig, lines, speed, outDur } = ctx;
  // Phrases may use the fixed spelling or the transcript's (indices are the same).
  const find = (q, from = 0) => findPhrase(kept, q, { from }) || findPhrase(orig, q, { from });
  const at = isObj(ref) && ref.at === undefined && ref.line !== undefined ? { line: ref.line } : ref.at;
  let t0, t1, from = 0;
  if (typeof at === "number") t0 = at;
  else if (isObj(at) && at.line !== undefined) {
    const l = lines.find((x) => x.id === Number(at.line));
    const k = l ? kept.findIndex((w) => w.i >= l.w0 && w.i <= l.w1) : -1;
    if (k < 0) throw new Error(`${label}: line ${at.line} is missing or cut`);
    t0 = kept[k].os / speed;
    from = k;
  } else if (typeof at === "string") {
    const m = find(at);
    if (!m) {
      const near = closest(kept, at);
      throw new Error(`${label}: "${at}" isn't in the edited video${near ? ` (closest: "${near}")` : ""}`);
    }
    t0 = kept[m.w0].os / speed;
    t1 = kept[m.w1].oe / speed;
    from = m.w0;
  } else if (at === undefined) t0 = 0;
  else throw new Error(`${label}: at must be seconds, a phrase, or {line: n}`);
  if (ref.to !== undefined) {
    if (typeof ref.to === "number") t1 = ref.to;
    else {
      const m = find(ref.to, from);
      if (!m) throw new Error(`${label}: to "${ref.to}" not found`);
      t1 = kept[m.w1].oe / speed;
    }
  }
  return { t0: Math.max(0, Math.min(t0, outDur)), phraseEnd: t1 };
}

// Turns one video's settings into a concrete render plan.
export async function planVideo(v, { ws, outDir, hookFiles }) {
  const errors = [], warnings = [];
  const info = await probe(v.src);
  if (!info.hasVideo) throw new Error(`${path.basename(v.src)} has no video stream`);
  const t = loadTranscript(ws, v.src);
  if (!t) throw new Error(`${path.basename(v.src)} isn't transcribed. Run: reel ingest ${path.relative(ws, v.src)}`);
  const words = wordsOf(t);
  const lines = buildLines(words);
  const edit = buildEdit(t, words, lines, v);
  errors.push(...edit.errors);
  if (!edit.segments.length) throw new Error(`${t.id}: nothing left after cutting${errors.length ? ` (${errors.join("; ")})` : ""}`);

  const speed = Number(v.speed) || 1;
  const outDur = edit.duration / speed;
  const zoom = Number(v.zoom) || 1;
  const segments = edit.segments.map((s, k) => ({ s: s.s, e: s.e, zoom: zoom > 1 && k % 2 === 1 ? zoom : 1 }));
  const kept = applyFixes(edit.kept, v.fix);
  const ctx = { kept, orig: edit.kept, lines, speed, outDur };
  const id = v.name || t.id;
  const plan = {
    id,
    src: v.src,
    out: path.join(outDir, `${id}.mp4`),
    info,
    segments,
    speed,
    outDuration: outDur,
    srcDuration: t.duration,
    fit: v.fit,
    focus: v.focus,
    splitFocus: v.splitFocus,
    grade: v.grade,
    audio: v.audio,
    encoder: v.encoder,
    quality: v.quality,
    broll: [],
    flash: [],
    sfx: [],
    music: null,
    hook: null,
    ass: null,
    errors,
    warnings,
    stats: { cuts: segments.length - 1, dropped: [...new Set(lines.filter((l) => edit.removed.has(l.w0) && edit.removed.has(l.w1)).map((l) => l.id))] },
  };
  const rel = (p) => path.resolve(v.base, p);
  const tryAdd = (label, fn) => {
    try {
      fn();
    } catch (e) {
      errors.push(e.message.startsWith(label) ? e.message : `${label}: ${e.message}`);
    }
  };

  // B-roll (files already resolved from the library or Pexels by resolveBroll)
  for (const [k, b] of (v.broll || []).entries()) {
    const label = `broll[${k}]`;
    if (b.error || !b.src || !fs.existsSync(b.src)) {
      errors.push(`${label}${typeof b.at === "string" ? ` "${b.at}"` : ""}: ${b.error || `file not found: ${b.src}`}`);
      continue;
    }
    const src = b.src;
    const image = IMAGE_EXT.test(src);
    const bi = image ? null : await probe(src).catch(() => null);
    tryAdd(label, () => {
      const { t0, phraseEnd } = locate(b, ctx, label);
      let t1 = b.dur ? t0 + Number(b.dur) : phraseEnd && b.to !== undefined ? phraseEnd : t0 + Math.max(2, phraseEnd ? phraseEnd - t0 + 0.4 : 0);
      if (bi && bi.duration) t1 = Math.min(t1, t0 + bi.duration - (b.from || 0));
      t1 = Math.min(t1, outDur);
      if (t1 - t0 < 0.2) throw new Error(`${label}: ends up shorter than 0.2s`);
      plan.broll.push({ src, t0, t1, from: Number(b.from) || 0, layout: b.layout === "split" ? "split" : "full", audio: Number(b.audio) || 0, image, hasAudio: !!bi?.hasAudio, fit: b.fit, found: b.found, credit: b.credit });
    });
  }
  plan.broll.sort((a, b) => a.t0 - b.t0);
  // A clip ends where the next one starts.
  plan.broll = plan.broll.filter((b, i, all) => {
    const next = all[i + 1];
    if (next && b.t1 > next.t0) b.t1 = next.t0;
    return b.t1 - b.t0 >= 0.2;
  });

  for (const [k, f] of (v.flash || []).entries()) {
    tryAdd(`flash[${k}]`, () => {
      const { t0 } = locate(typeof f === "string" || typeof f === "number" ? { at: f } : f, ctx, `flash[${k}]`);
      plan.flash.push({ t0, t1: t0 + (Number(f.dur) || 0.12), color: f.color || "#ff0000", alpha: f.alpha ?? 0.4 });
    });
  }
  for (const [k, s] of (v.sfx || []).entries()) {
    if (!s.src || !fs.existsSync(rel(s.src))) {
      errors.push(`sfx[${k}]: file not found: ${s.src}`);
      continue;
    }
    tryAdd(`sfx[${k}]`, () => plan.sfx.push({ src: rel(s.src), t0: locate(s, ctx, `sfx[${k}]`).t0, volume: s.volume }));
  }
  if (v.music && v.music.src) {
    if (!fs.existsSync(rel(v.music.src))) errors.push(`music: file not found: ${v.music.src}`);
    else plan.music = { src: rel(v.music.src), volume: v.music.volume ?? 0.12, duck: v.music.duck, from: v.music.from };
  }

  // Hook (first `dur` seconds), from hook-gen.
  const hook = v.hook || {};
  let hookEnd = 0;
  if (v.hook !== false && (hook.text || hook.png)) {
    const png = hook.png ? rel(hook.png) : hookFiles.get(hookKey(hook));
    if (!png || !fs.existsSync(png)) errors.push(`hook: PNG missing${hook.png ? `: ${hook.png}` : ""}`);
    else {
      const { w, h } = pngSize(png);
      let sc = (hook.size || 84) / HOOKGEN_FONT_PX;
      if (w * sc > (hook.maxWidth || 1000)) sc = (hook.maxWidth || 1000) / w;
      const y = typeof hook.y === "string" ? POSITIONS[hook.y] ?? 0.5 : hook.y ?? 0.5;
      hookEnd = Math.min(Number(hook.dur) || 4, outDur);
      plan.hook = { png, w: w * sc, h: h * sc, x: (W - w * sc) / 2, y: Math.max(0, Math.min(H - h * sc, y * H - (h * sc) / 2)), t1: hookEnd };
    }
  } else if (v.hook !== false) warnings.push("no hook text (add hook: \"...\")");

  // Captions and text callouts share one subtitle file.
  const events = [];
  if (v.captions && v.captions !== false && v.captions.style !== "none") {
    tryAdd("captions", () => {
      const style = captionStyle(v.captions);
      const words = kept.filter((w) => w.w).map((w) => ({ ...w, os: w.os / speed, oe: w.oe / speed }));
      let chunks = chunkWords(words, { words: style.words, chars: style.chars });
      if (hookEnd && v.captions.afterHook !== false) chunks = chunks.filter((c) => c.end > hookEnd + 0.05).map((c) => (c.start < hookEnd ? { ...c, start: hookEnd } : c));
      events.push(...captionEvents(chunks, style, { highlight: v.highlight || [] }));
      plan.stats.captions = chunks.length;
    });
  }
  const texts = [];
  for (const [k, x] of (v.texts || []).entries()) {
    tryAdd(`texts[${k}]`, () => {
      if (!x.text) throw new Error("needs text");
      const { t0, phraseEnd } = locate(x, ctx, `texts[${k}]`);
      const t1 = Math.min(outDur, x.dur ? t0 + Number(x.dur) : Math.max(t0 + 2, (phraseEnd || 0) + 0.8));
      texts.push({ ...x, start: t0, end: t1 });
    });
  }
  events.push(...textEvents(texts));
  if (events.length) plan.ass = assFile(events);
  return plan;
}

const hookKey = (h) => JSON.stringify([h.text, h.preset || "", h.style || {}]);

export function defaultJobs() {
  return Math.min(6, Math.max(2, Math.floor(os.cpus().length / 3)));
}

// Plans every video in a batch: transcribes anything new, renders hooks, resolves timings.
export async function planBatch(input, { ws = process.cwd(), only, onLog, renderHookPngs = true } = {}) {
  const b = loadBatch(input, { ws });
  let videos = b.videos;
  if (only?.length) {
    videos = videos.filter((v) => only.some((o) => v.name === o || path.basename(v.src).startsWith(o) || loadTranscript(ws, v.src)?.id === o));
    if (!videos.length) throw new Error(`--only matched nothing`);
  }
  const missing = videos.filter((v) => !loadTranscript(ws, v.src)).map((v) => v.src);
  if (missing.length) {
    onLog?.(`transcribing ${missing.length} new video(s)`);
    await ingest([...new Set(missing)], { ws, onLog });
  }
  const credits = await resolveBroll(videos, { ws, onLog });
  const hookFiles = new Map();
  const hooks = [];
  for (const v of videos) if (v.hook && v.hook.text && !v.hook.png && !hookFiles.has(hookKey(v.hook))) {
    hookFiles.set(hookKey(v.hook), null);
    hooks.push(v.hook);
  }
  if (hooks.length && renderHookPngs) {
    const files = await renderHooks(hooks.map((h) => ({ text: h.text, preset: h.preset, style: h.style && Object.keys(h.style).length ? h.style : undefined })), { ws, onLog });
    hooks.forEach((h, i) => hookFiles.set(hookKey(h), files[i]));
  }
  const plans = [];
  for (const v of videos) {
    try {
      plans.push(await planVideo(v, { ws, outDir: b.outDir, hookFiles }));
    } catch (e) {
      plans.push({ id: v.name || path.basename(v.src), src: v.src, errors: [e.message], warnings: [], fatal: true });
    }
  }
  // Two videos must not write the same output.
  const seen = new Map();
  for (const p of plans) {
    if (!p.out) continue;
    if (seen.has(p.out)) p.errors.push(`output ${path.basename(p.out)} is also written by ${seen.get(p.out)}; give one a name:`);
    seen.set(p.out, p.id);
  }
  return { plans, warnings: b.warnings, jobs: b.jobs, outDir: b.outDir, credits };
}

// Pexels asks for credit where possible: one line per clip used, per video.
function writeCredits(outDir, plans) {
  const lines = [];
  for (const p of plans) for (const b of p.broll || []) if (b.credit) lines.push(`${p.id}: "${path.basename(b.src)}" video by ${b.credit.author || "unknown"} on Pexels ${b.credit.url || ""}`.trim());
  if (lines.length) fs.writeFileSync(path.join(ensureDir(outDir), "credits.txt"), `${lines.join("\n")}\n`);
}

// Plans and renders a batch, several videos at a time.
export async function renderBatch(input, { ws = process.cwd(), only, jobs, quality, encoder, onLog, onProgress, onDone } = {}) {
  const t0 = Date.now();
  const { plans, warnings, jobs: specJobs, outDir } = await planBatch(input, { ws, only, onLog });
  writeCredits(outDir, plans);
  const ok = plans.filter((p) => !p.errors.length);
  for (const p of ok) {
    if (quality) p.quality = quality;
    if (encoder) p.encoder = encoder;
  }
  const tmpRoot = ensureDir(path.join(stateDir(ws), "tmp", String(Date.now())));
  const results = plans.filter((p) => p.errors.length).map((p) => ({ id: p.id, ok: false, errors: p.errors }));
  results.forEach((r) => onDone?.(r));
  const n = Number(jobs || specJobs) || defaultJobs();
  await pool(ok, n, async (p) => {
    const release = await renderSlot(Math.max(n, defaultJobs()));
    const start = Date.now();
    onLog?.(`rendering ${p.id} (${fmtDur(p.outDuration)})`);
    try {
      await renderPlan(p, { tmpRoot, onProgress: (pct) => onProgress?.(p.id, pct) });
      const r = { id: p.id, ok: true, out: p.out, duration: p.outDuration, secs: (Date.now() - start) / 1000, stats: p.stats, warnings: p.warnings };
      results.push(r);
      onDone?.(r);
    } catch (e) {
      const r = { id: p.id, ok: false, errors: [e.message] };
      results.push(r);
      onDone?.(r);
    } finally {
      release();
    }
  });
  if (!process.env.REEL_KEEP_TMP) fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { results, warnings, secs: (Date.now() - t0) / 1000 };
}

// One line per planned video, for `reel plan` and the API.
export function formatPlan(p, ws = process.cwd()) {
  if (p.fatal) return `✗ ${p.id}: ${p.errors.join("; ")}`;
  const bits = [`${round(p.srcDuration, 1)}s→${round(p.outDuration, 1)}s`, `cuts ${p.stats.cuts}`];
  if (p.stats.dropped.length) bits.push(`dropped ${compactIds(p.stats.dropped)}`);
  if (p.hook) bits.push(`hook 0-${round(p.hook.t1, 1)}s`);
  if (p.stats.captions) bits.push(`captions ${p.stats.captions}`);
  if (p.broll.length) bits.push(`broll ${p.broll.map((b) => `${b.found || path.basename(b.src)}@${round(b.t0, 1)}-${round(b.t1, 1)}`).join(",")}`);
  const lines = [`${p.errors.length ? "✗" : "✓"} ${p.id} → ${path.relative(ws, p.out)}  ${bits.join("  ")}`];
  for (const e of p.errors) lines.push(`  error: ${e}`);
  for (const w of p.warnings) lines.push(`  note: ${w}`);
  return lines.join("\n");
}

function compactIds(ids) {
  const s = [...ids].sort((a, b) => a - b), out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(",");
}

export { CAPTION_STYLES };
