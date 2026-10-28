import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FONTS_DIR = path.join(ROOT, "fonts");
export const W = 1080;
export const H = 1920;
export const FPS = 60;
export const SR = 48000;

// Where hook-gen lives: REEL_HOOKGEN_DIR, else the vendor/hook-gen submodule.
export const HOOKGEN_DIR = process.env.REEL_HOOKGEN_DIR || path.join(ROOT, "vendor", "hook-gen");
export const HOOKGEN_URL = "https://ddeonmadeit.github.io/hook-gen/";

// Per-workspace state (transcripts, hook PNGs, temp render files) lives in .reel/ under the
// directory the tool runs in, so separate projects never share caches by accident.
export function stateDir(ws = process.cwd()) {
  return path.join(ws, ".reel");
}

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export const sha1 = (...parts) => createHash("sha1").update(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\0")).digest("hex");

export const slug = (s) =>
  String(s)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "video";

export const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const snap = (t) => Math.round(t * FPS) / FPS; // to the 60 fps frame grid

export function fmtDur(s) {
  if (!Number.isFinite(s)) return "?";
  if (s < 60) return `${round(s, 1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

// Runs a command, resolving with its output. Rejects with the stderr tail on failure.
export function run(cmd, args, { cwd, onStdout, onStderr, input, quiet } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    p.stdout.on("data", (d) => {
      out.push(d);
      onStdout?.(d.toString());
    });
    p.stderr.on("data", (d) => {
      err.push(d);
      onStderr?.(d.toString());
    });
    p.on("error", (e) => reject(e.code === "ENOENT" ? new Error(`${cmd} not found. Run: reel setup`) : e));
    p.on("close", (code) => {
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err).toString();
      if (code === 0 || quiet) resolve({ code, stdout, stderr });
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

// Minimal glob: "*" and "?" anywhere in the last path segment, "**/" for any depth.
export function glob(pattern, base = process.cwd()) {
  const abs = path.resolve(base, pattern);
  if (!/[*?]/.test(pattern)) return fs.existsSync(abs) ? [abs] : [];
  const deep = abs.includes(`${path.sep}**${path.sep}`);
  const [dirPart, rest] = deep ? abs.split(`${path.sep}**${path.sep}`) : [path.dirname(abs), path.basename(abs)];
  const re = new RegExp(`^${rest.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`, "i");
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && deep) walk(p);
      else if (e.isFile() && re.test(e.name)) out.push(p);
    }
  };
  walk(dirPart);
  return out.sort();
}

export const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts)$/i;
export const IMAGE_EXT = /\.(png|jpe?g|webp|heic|gif)$/i;

// Expands files, directories and globs into a list of video files.
export function expandVideos(args, base = process.cwd()) {
  const out = [];
  for (const a of args) {
    const abs = path.resolve(base, a);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) out.push(...glob(path.join(abs, "*"), base).filter((f) => VIDEO_EXT.test(f)));
    else out.push(...glob(a, base));
  }
  return [...new Set(out)];
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, v) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, file);
}

// Width and height of a PNG, from its IHDR chunk.
export function pngSize(file) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// "#ff9a1f" (+ alpha 0..1) -> ASS "&HAABBGGRR"
export function assColor(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const v = m ? m[1] : "ffffff";
  const a = Math.round((1 - clamp(alpha, 0, 1)) * 255).toString(16).padStart(2, "0");
  return `&H${a}${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}&`.toUpperCase();
}

// A cross-process lock: fn runs while this process holds `file`. Stale locks (dead pid, or
// older than 30 s) are taken over.
export async function withLock(file, fn) {
  ensureDir(path.dirname(file));
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      break;
    } catch {
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(file, "utf8"));
        stale = Date.now() - fs.statSync(file).mtimeMs > 30000 || !alive(pid);
      } catch {}
      if (stale) fs.rmSync(file, { force: true });
      else await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
      if (i > 400) throw new Error(`timed out waiting for ${file}`);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Machine-wide render slots, so several agents rendering at once share the CPU instead of
// each starting a full set of encoders. Resolves with a release function.
export async function renderSlot(max) {
  const dir = ensureDir(path.join(os.tmpdir(), "reel-slots"));
  for (;;) {
    for (let i = 0; i < max; i++) {
      const f = path.join(dir, `slot-${i}`);
      try {
        fs.writeFileSync(f, String(process.pid), { flag: "wx" });
        return () => fs.rmSync(f, { force: true });
      } catch {
        try {
          if (!alive(Number(fs.readFileSync(f, "utf8")))) fs.rmSync(f, { force: true });
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Loads KEY=value lines from .env files (without overriding the real environment), so
// PEXELS_API_KEY and friends can live in the project.
export function loadDotEnv(dirs) {
  for (const d of dirs) {
    const f = path.join(d, ".env");
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
      if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

// A pool that runs at most n async tasks at once.
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return results;
}
