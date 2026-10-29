#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { formatPlan, listLooks, planBatch, renderBatch } from "../src/batch.js";
import { brollReport, describeLibrary, fetchMedia } from "../src/broll.js";
import { HOOK_PRESETS, renderHooks } from "../src/hooks.js";
import { ffmpegCaps } from "../src/media.js";
import { check, formatCheck, sheet } from "../src/qa.js";
import { newBatch } from "../src/scaffold.js";
import { CAPTION_STYLES, TEXT_STYLES } from "../src/styles.js";
import { buildLines, formatTranscript } from "../src/transcript.js";
import { ingest, listIngested, loadTranscript, saveTranscript, wordsOf } from "../src/transcribe.js";
import { HOOKGEN_DIR, ROOT, VIDEO_EXT, expandVideos, fmtDur, loadDotEnv, pool, round, run } from "../src/util.js";

const USAGE = `reel: batch video editor for AI agents (1080x1920, 60 fps)

  reel new edit.yaml raw/*.mov     transcribe + write a batch file with transcripts inline
  reel render edit.yaml            render every video (parallel)   --only id,id --jobs N --quality draft|high|max
  reel plan edit.yaml              check a batch without rendering (timings, errors)
  reel ingest raw/*.mov            transcribe only (cached)        --model small.en --lang en --prompt "names"
                                   (import instead: reel ingest video.mp4 --transcript words.json)
  reel transcript <id|file>...     numbered transcript lines       --all  --words
  reel check out/                  verify outputs: 1080x1920, 60 fps, audio, -14 LUFS
  reel sheet out/x.mp4             contact sheet PNG for a quick visual check   --cols 6 --rows 3 --at 1,5,9
  reel broll "air conditioner"     find B-roll: library, Pixabay, then photos      --photo (person, place, brand) --sheet --lib dir
  reel library [broll/]            list your B-roll folder (name, length, tags)    --sheet
  reel hook "text" -o hook.png     render one hook with hook-gen   --preset get-known
  reel styles                      looks, caption styles, hook presets
  reel serve                       web dashboard + HTTP API on http://localhost:4317   --port --host
  reel mcp                         MCP server (stdio) for Claude Desktop / Claude Code
  reel setup                       install/check ffmpeg, faster-whisper, browser, hook-gen
  reel skill                       install the Claude Code skill in ~/.claude/skills (use reel from any folder)
  reel help spec                   the full batch file reference
`;

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") opt.out = argv[++i];
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) opt[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["all", "words", "force", "draft", "progress", "photo", "sheet"].includes(k)) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

const ws = process.cwd();
loadDotEnv([ws, ROOT]);
process.stdout.on("error", (e) => e.code === "EPIPE" && process.exit(0));
const log = (s) => process.stderr.write(`${s}\n`);
const say = (s) => process.stdout.write(`${s}\n`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  switch (cmd) {
    case "new": {
      if (pos.length < 2) throw new Error("usage: reel new edit.yaml raw/*.mov");
      const r = await newBatch(pos[0], pos.slice(1), { ws, use: opt.use, force: opt.force, onLog: log, model: opt.model, lang: opt.lang, prompt: opt.prompt, backend: opt.backend });
      say(`wrote ${path.relative(ws, r.file)}: ${r.videos} video(s) with transcripts inline. Fill in hook + drop, then: reel render ${path.relative(ws, r.file)}`);
      break;
    }
    case "ingest": {
      if (opt.transcript) {
        // Import: [[start, end, "word"], ...] or {words: [...]} for one video.
        const j = JSON.parse(fs.readFileSync(path.resolve(ws, opt.transcript), "utf8"));
        const t = await saveTranscript(ws, pos[0], { words: Array.isArray(j) ? j : j.words });
        say(`${t.id} imported (${t.words.length} words)`);
        break;
      }
      const files = expandVideos(pos, ws);
      if (!files.length) throw new Error("no videos given (reel ingest raw/*.mov)");
      const res = await ingest(files, { ws, model: opt.model, lang: opt.lang, prompt: opt.prompt, backend: opt.backend, force: opt.force, onLog: log });
      for (const r of res) say(`${r.id} ${fmtDur(r.transcript.duration)} ${buildLines(wordsOf(r.transcript)).length} lines${r.cached ? " (cached)" : ""}`);
      say(`next: reel transcript ${res.map((r) => r.id).join(" ")}`);
      break;
    }
    case "transcript":
    case "t": {
      const ids = opt.all ? listIngested(ws).filter((x) => x.ready).map((x) => x.id) : pos;
      if (!ids.length) throw new Error("usage: reel transcript <id|file>... (or --all)");
      const out = [];
      for (const id of ids) {
        const t = loadTranscript(ws, id);
        if (!t) throw new Error(`${id} isn't ingested (reel ingest <file>)`);
        const words = wordsOf(t);
        if (opt.words) out.push(`# ${t.id} words: index start end text`, ...words.map((w) => `${w.i} ${round(w.s, 2)} ${round(w.e, 2)} ${w.w}`));
        else out.push(formatTranscript(t, buildLines(words)));
      }
      say(out.join("\n"));
      break;
    }
    case "plan": {
      if (!pos[0]) throw new Error("usage: reel plan edit.yaml");
      const { plans, warnings } = await planBatch(pos[0], { ws, only: opt.only && String(opt.only).split(","), onLog: log, renderHookPngs: !opt["no-hooks"] });
      for (const w of warnings) say(`note: ${w}`);
      for (const p of plans) say(formatPlan(p, ws));
      if (plans.some((p) => p.errors.length)) process.exitCode = 1;
      break;
    }
    case "render": {
      if (!pos[0]) throw new Error("usage: reel render edit.yaml");
      const tty = process.stderr.isTTY || opt.progress;
      const prog = new Map();
      const draw = () => tty && process.stderr.write(`\r${[...prog].map(([id, p]) => `${id} ${p}%`).join("  ").slice(0, (process.stderr.columns || 120) - 1)}\x1b[K`);
      const { results, warnings, secs } = await renderBatch(pos[0], {
        ws,
        only: opt.only && String(opt.only).split(","),
        jobs: opt.jobs,
        quality: opt.draft ? "draft" : opt.quality,
        encoder: opt.encoder,
        onLog: (s) => (tty ? null : log(s)),
        onProgress: (id, pct) => {
          prog.set(id, pct);
          draw();
        },
        onDone: (r) => {
          prog.delete(r.id);
          if (tty) process.stderr.write("\r\x1b[K");
          say(r.ok ? `✓ ${r.id} → ${path.relative(ws, r.out)} ${round(r.duration, 1)}s (${r.stats.cuts} cuts${r.stats.captions ? `, ${r.stats.captions} captions` : ""}) in ${Math.round(r.secs)}s${r.warnings?.length ? `  note: ${r.warnings.join("; ")}` : ""}` : `✗ ${r.id}: ${r.errors.join("; ")}`);
          draw();
        },
      });
      for (const w of warnings) say(`note: ${w}`);
      const good = results.filter((r) => r.ok).length;
      say(`${good}/${results.length} rendered in ${Math.round(secs)}s`);
      if (good < results.length) process.exitCode = 1;
      break;
    }
    case "check": {
      const files = (pos.length ? pos : ["out"]).flatMap((p) => (fs.existsSync(p) && fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => VIDEO_EXT.test(f)).map((f) => path.join(p, f)) : [p]));
      if (!files.length) throw new Error("nothing to check");
      let bad = 0;
      for (const f of files) {
        const r = await check(path.resolve(ws, f), { loudness: opt.loudness ? Number(opt.loudness) : -14 });
        if (!r.ok) bad++;
        say(formatCheck(r, ws));
      }
      say(`${files.length - bad}/${files.length} ok`);
      if (bad) process.exitCode = 1;
      break;
    }
    case "sheet": {
      if (!pos[0]) throw new Error("usage: reel sheet out/video.mp4");
      const at = opt.at ? String(opt.at).split(",").map(Number) : undefined;
      say(await sheet(path.resolve(ws, pos[0]), { cols: Number(opt.cols) || 6, rows: Number(opt.rows) || 3, width: Number(opt.width) || 180, out: opt.out, ws, at }));
      break;
    }
    case "broll": {
      if (!pos[0]) throw new Error('usage: reel broll "what you need" [--photo]');
      const q = pos.join(" ");
      const dirs = [].concat(opt.lib || "broll").map((d) => path.resolve(ws, d));
      const { list, lines } = await brollReport(q, { ws, dirs, photo: !!opt.photo, perSite: Number(opt.n) || 6 });
      for (const l of lines) say(l);
      const thumbs = list.filter((c) => c.thumb);
      if (opt.sheet && thumbs.length) say(await thumbSheet(thumbs.map((c) => ({ url: c.thumb, label: `${c.site}:${c.id}`.slice(0, 40) })), path.join(ws, ".reel", "sheets", `stock-${q.replace(/\W+/g, "-")}.png`)));
      break;
    }
    case "library": {
      const dirs = (pos.length ? pos : ["broll"]).map((d) => path.resolve(ws, d));
      const { items, text } = await describeLibrary(dirs);
      say(text || "empty library");
      if (opt.sheet && items.length) {
        const frames = [];
        for (const it of items) frames.push({ file: it.file, label: it.name });
        say(await librarySheet(frames, path.join(ws, ".reel", "sheets", "library.png")));
      }
      break;
    }
    case "hook": {
      if (!pos[0]) throw new Error('usage: reel hook "text" [-o hook.png] [--preset get-known]');
      const [file] = await renderHooks([{ text: pos.join(" ").replace(/\\n/g, "\n"), preset: opt.preset }], { ws, onLog: log });
      const dest = opt.out ? path.resolve(ws, opt.out) : file;
      if (opt.out) fs.copyFileSync(file, dest);
      say(dest);
      break;
    }
    case "styles": {
      say(`looks (use: name): ${listLooks().join(", ")}`);
      say(`caption styles (captions: name): ${Object.entries(CAPTION_STYLES).map(([k, s]) => `${k} [${s.font} ${s.size}px${s.case === "upper" ? " caps" : ""}]`).join(", ")}`);
      say(`text callout styles (texts[].style): ${Object.keys(TEXT_STYLES).join(", ")}`);
      say(`hook presets (hook.preset, from hook-gen): ${HOOK_PRESETS.join(", ")}`);
      break;
    }
    case "serve": {
      const { serve } = await import("../src/server.js");
      await serve({ ws, port: Number(opt.port) || 4317, host: opt.host || "127.0.0.1" });
      break;
    }
    case "mcp": {
      const { startMcp } = await import("../src/mcp.js");
      await startMcp({ ws });
      break;
    }
    case "setup":
      await setup(opt);
      break;
    case "skill": {
      const dest = path.join(process.env.HOME || process.env.USERPROFILE || ".", ".claude", "skills", "edit-videos");
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(ROOT, ".claude", "skills", "edit-videos", "SKILL.md"), path.join(dest, "SKILL.md"));
      say(`installed ${path.join(dest, "SKILL.md")}: Claude Code now knows how to edit videos with reel in any folder`);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      if (pos[0] === "spec") say(fs.readFileSync(path.join(ROOT, "docs", "SPEC.md"), "utf8"));
      else say(USAGE);
      break;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

// A grid of remote thumbnails with labels (Pexels search results).
async function thumbSheet(items, dest) {
  const dir = fs.mkdtempSync(path.join(ws, ".reel-thumbs-"));
  try {
    await pool(items, 3, async (it, i) => {
      const r = await fetchMedia(it.url);
      const f = path.join(dir, `in${i}.jpg`);
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      await labelFrame(f, it.label, path.join(dir, `${String(i).padStart(3, "0")}.png`));
    });
    return await tile(dir, items.length, dest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function librarySheet(items, dest) {
  const dir = fs.mkdtempSync(path.join(ws, ".reel-thumbs-"));
  try {
    for (const [i, it] of items.entries()) await labelFrame(it.file, it.label, path.join(dir, `${String(i).padStart(3, "0")}.png`), VIDEO_EXT.test(it.file) ? ["-ss", "1"] : []);
    return await tile(dir, items.length, dest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function labelFrame(input, label, out, pre = []) {
  const font = path.join(ROOT, "fonts", "Inter-Black.ttf").replace(/\\/g, "/").replace(/:/g, "\\:");
  const text = label.replace(/[':\\]/g, " ").slice(0, 28);
  await run("ffmpeg", ["-v", "error", "-y", ...pre, "-i", input, "-frames:v", "1", "-vf", `scale=180:320:force_original_aspect_ratio=increase,crop=180:320,drawtext=fontfile='${font}':text='${text}':x=6:y=h-th-8:fontsize=15:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4`, "-update", "1", out]);
}

async function tile(dir, n, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const cols = Math.min(n, 6);
  await run("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-i", path.join(dir, "%03d.png"), "-vf", `tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=0x222222`, "-frames:v", "1", "-update", "1", dest]);
  return dest;
}

async function setup(opt) {
  const ok = (s) => say(`✓ ${s}`), bad = (s) => say(`✗ ${s}`);
  try {
    const c = await ffmpegCaps();
    (c.subtitles && c.libx264 ? ok : bad)(`ffmpeg ${c.version}${c.subtitles ? "" : " (missing libass: captions won't render)"}${c.libx264 ? "" : " (no libx264)"}${c.videotoolbox ? ", videotoolbox" : ""}${c.nvenc ? ", nvenc" : ""}`);
  } catch {
    bad("ffmpeg not found: install it (macOS: brew install ffmpeg, Ubuntu: apt install ffmpeg)");
  }

  if (!fs.existsSync(path.join(HOOKGEN_DIR, "index.html"))) {
    say("… fetching hook-gen");
    await run("git", ["submodule", "update", "--init", "vendor/hook-gen"], { cwd: ROOT, quiet: true });
    if (!fs.existsSync(path.join(HOOKGEN_DIR, "index.html"))) await run("git", ["clone", "--depth", "1", "https://github.com/ddeonmadeit/hook-gen", HOOKGEN_DIR], { quiet: true });
  }
  (fs.existsSync(path.join(HOOKGEN_DIR, "index.html")) ? ok : bad)(`hook-gen at ${path.relative(ROOT, HOOKGEN_DIR) || HOOKGEN_DIR}`);

  try {
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
    ok(`browser for hooks (${b.version()})`);
    await b.close();
  } catch {
    say("… installing Chromium for hook rendering");
    await run(process.execPath, [path.join(ROOT, "node_modules", "playwright-core", "cli.js"), "install", "chromium"], { quiet: true });
    ok("Chromium installed");
  }

  const venv = path.join(ROOT, ".venv");
  const py = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
  const hasFW = async (bin) => (await run(bin, ["-c", "import faster_whisper"], { quiet: true }).catch(() => ({ code: 1 }))).code === 0;
  let bin = process.env.REEL_PYTHON || (fs.existsSync(py) ? py : null);
  if (!bin || !(await hasFW(bin))) {
    if (!fs.existsSync(py)) {
      say("… creating .venv for faster-whisper");
      await run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv]);
    }
    say("… installing faster-whisper");
    await run(py, ["-m", "pip", "install", "-q", "--upgrade", "pip", "faster-whisper"]);
    bin = py;
  }
  ok(`faster-whisper (${bin})`);
  if (!opt["skip-model"]) {
    const model = opt.model || process.env.REEL_WHISPER_MODEL || "small.en";
    say(`… downloading whisper model ${model} (once)`);
    await run(bin, ["-c", `from faster_whisper import WhisperModel; WhisperModel(${JSON.stringify(model)}, device="cpu", compute_type="int8")`]);
    ok(`whisper model ${model}`);
  }
  say("ready. Try: reel new edit.yaml raw/*.mov");
}

main().catch((e) => {
  log(`error: ${e.message}`);
  if (process.env.REEL_DEBUG) log(e.stack);
  process.exit(1);
});
