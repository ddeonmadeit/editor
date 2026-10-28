import fs from "node:fs";
import path from "node:path";
import { FFMPEG, probe } from "./media.js";
import { FONTS_DIR, FPS, H, W, ensureDir, round, run, stateDir } from "./util.js";

// Checks a rendered file against the house format: 1080x1920, 60 fps, audio, loudness.
export async function check(file, { loudness = -14 } = {}) {
  const info = await probe(file);
  const problems = [];
  if (info.width !== W || info.height !== H) problems.push(`${info.width}x${info.height} (want ${W}x${H})`);
  if (Math.abs(info.fps - FPS) > 0.01) problems.push(`${round(info.fps, 2)} fps (want ${FPS})`);
  if (!info.hasAudio) problems.push("no audio");
  let lufs = null;
  if (info.hasAudio) {
    const { stderr } = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    const m = /I:\s+(-?[\d.]+) LUFS/.exec(stderr.split("Summary:").pop());
    lufs = m ? Number(m[1]) : null;
    if (lufs !== null && Math.abs(lufs - loudness) > 1.5) problems.push(`${lufs} LUFS (want ${loudness})`);
  }
  return { file, ok: !problems.length, problems, width: info.width, height: info.height, fps: round(info.fps, 2), duration: round(info.duration, 2), lufs };
}

export const formatCheck = (r, ws = process.cwd()) =>
  `${r.ok ? "✓" : "✗"} ${path.relative(ws, r.file)} ${r.width}x${r.height} ${r.fps}fps ${r.duration}s${r.lufs !== null ? ` ${r.lufs} LUFS` : ""}${r.ok ? "" : `  ← ${r.problems.join(", ")}`}`;

// One image of evenly spaced frames with timestamps: the cheapest way for an agent to
// look at an edit (one small image instead of a video).
export async function sheet(file, { cols = 6, rows = 3, width = 180, out, ws = process.cwd(), at } = {}) {
  const info = await probe(file);
  const n = at?.length || cols * rows;
  const times = at || Array.from({ length: n }, (_, i) => (info.duration * (i + 0.5)) / n);
  const h = Math.round((width * info.height) / info.width / 2) * 2;
  const dest = out ? path.resolve(ws, out) : path.join(ensureDir(path.join(stateDir(ws), "sheets")), `${path.basename(file).replace(/\.[^.]+$/, "")}.png`);
  const tmp = ensureDir(path.join(stateDir(ws), "tmp", `sheet-${process.pid}-${Date.now()}`));
  try {
    const font = path.join(FONTS_DIR, "Inter-Black.ttf").replace(/\\/g, "/").replace(/:/g, "\\:");
    await Promise.all(
      times.map((t, i) =>
        run(FFMPEG, ["-v", "error", "-y", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:${h},drawtext=fontfile='${font}':text='${round(t, 1)}s':x=6:y=6:fontsize=${Math.round(width / 9)}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`, "-update", "1", path.join(tmp, `${String(i).padStart(3, "0")}.png`)]),
      ),
    );
    const c = at ? Math.min(cols, n) : cols;
    await run(FFMPEG, ["-v", "error", "-y", "-framerate", "1", "-i", path.join(tmp, "%03d.png"), "-vf", `tile=${c}x${Math.ceil(n / c)}:padding=4:color=0x222222`, "-frames:v", "1", "-update", "1", dest]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}
