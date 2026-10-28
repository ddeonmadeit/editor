import fs from "node:fs";
import path from "node:path";
import { FFMPEG, ffmpegCaps } from "./media.js";
import { FONTS_DIR, FPS, H, SR, W, ensureDir, round, run } from "./util.js";

const even = (x) => 2 * Math.round(x / 2);
const f3 = (x) => round(x, 4);

// x264 veryfast at CRF 16 is visually transparent at these bitrates and about twice as fast
// as medium; every platform re-encodes uploads anyway. `max` is for archive masters.
export const QUALITY = {
  draft: { x264: ["-preset", "superfast", "-crf", "22"], vt: "10M", nv: ["-preset", "p3", "-cq", "24"] },
  high: { x264: ["-preset", "veryfast", "-crf", "16"], vt: "24M", nv: ["-preset", "p5", "-cq", "18"] },
  max: { x264: ["-preset", "medium", "-crf", "15"], vt: "34M", nv: ["-preset", "p7", "-cq", "16"] },
};

const GRADES = {
  punchy: "eq=contrast=1.07:saturation=1.15",
  warm: "colorbalance=rs=0.04:gs=0.01:bs=-0.04:rm=0.03:bm=-0.03,eq=saturation=1.06",
  cool: "colorbalance=rs=-0.03:bs=0.04:bm=0.03",
  film: "eq=contrast=1.05:saturation=0.9:gamma=0.97,colorbalance=rs=0.02:bh=0.03",
  bw: "hue=s=0,eq=contrast=1.1",
};

function gradeFilter(g, tmp) {
  if (!g || g === "none") return "";
  if (typeof g === "string" && GRADES[g]) return `,${GRADES[g]}`;
  if (typeof g === "string" && /\.cube$/i.test(g)) g = { lut: g };
  if (typeof g === "object") {
    const parts = [];
    if (g.lut) {
      fs.copyFileSync(g.lut, path.join(tmp, "grade.cube"));
      parts.push("lut3d=grade.cube");
    }
    const eq = ["contrast", "saturation", "brightness", "gamma"].filter((k) => typeof g[k] === "number").map((k) => `${k}=${g[k]}`);
    if (eq.length) parts.push(`eq=${eq.join(":")}`);
    return parts.length ? `,${parts.join(",")}` : "";
  }
  throw new Error(`grade "${g}" unknown (have: ${Object.keys(GRADES).join(", ")}, a .cube LUT path, or {contrast, saturation, brightness, gamma})`);
}

// HDR (HLG/PQ) iPhone footage gets tone-mapped to SDR bt709, the format every platform shows.
function toneMap(info, caps) {
  if (!info.hdr) return "";
  if (!caps.zscale) return ",colorspace=all=bt709:iall=bt2020:fast=1";
  const tin = info.transfer === "smpte2084" ? "smpte2084" : "arib-std-b67";
  return `,zscale=tin=${tin}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`;
}

// Scales a stream to cover (crop) or fit inside (blurred fill) a w x h frame.
function fitFilter(inLabel, outLabel, w, h, mode, id) {
  if (mode === "blur") {
    return [
      `[${inLabel}]split[${id}bg][${id}fg]`,
      `[${id}bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=40,eq=brightness=-0.08[${id}bgb]`,
      `[${id}fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[${id}fgs]`,
      `[${id}bgb][${id}fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[${outLabel}]`,
    ];
  }
  return [`[${inLabel}]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1[${outLabel}]`];
}

// Builds the ffmpeg arguments and filter graph for one planned video (see batch.js for
// what a plan holds). Everything happens in one decode/encode pass.
export async function buildCommand(p, tmp, { audioOnly = false, loudness } = {}) {
  const caps = await ffmpegCaps();
  const inputs = [];
  const add = (args) => inputs.push(args) - 1;
  const main = add(["-i", p.src]);
  const silent = p.info.hasAudio ? null : add(["-f", "lavfi", "-t", String(p.info.duration), "-i", `anullsrc=r=${SR}:cl=stereo`]);
  const g = [];
  const segs = p.segments;
  const N = segs.length;
  const spd = p.speed || 1;
  const outDur = p.outDuration;

  // ---- main footage: cuts, punch-ins, speed ----
  // Each kept segment is trimmed first, then cropped and scaled once, straight from the
  // source, so cut frames cost nothing and no frame is resampled twice.
  if (!audioOnly) {
    const fy = p.focus ?? 0.35;
    const outs = segs.map((_, k) => `[s${k}]`).join("");
    if (p.fit === "blur") {
      // Fit inside a blurred fill: build that frame (with zoom headroom), then crop.
      const Z = Math.max(1, ...segs.map((s) => s.zoom || 1));
      const BW = even(W * Z), BH = even(H * Z);
      g.push(`[${main}:v]setpts=PTS-STARTPTS,fps=${FPS}[m0]`);
      g.push(...fitFilter("m0", "m1", BW, BH, "blur", "f"));
      g.push(`[m1]${N > 1 ? `split=${N}${outs}` : "null[s0]"}`);
      segs.forEach((s, k) => {
        const z = s.zoom || 1, cw = even(BW / z), ch = even(BH / z);
        const crop = cw !== BW || ch !== BH ? `,crop=${cw}:${ch}:${even((BW - cw) / 2)}:${even((BH - ch) * fy)}` : "";
        g.push(`[s${k}]trim=start_frame=${Math.round(s.s * FPS)}:end_frame=${Math.round(s.e * FPS)},setpts=PTS-STARTPTS${crop},scale=${W}:${H}:flags=lanczos,setsar=1[v${k}]`);
      });
    } else {
      const sw = p.info.width, sh = p.info.height;
      const cover = Math.max(W / sw, H / sh);
      g.push(`[${main}:v]setpts=PTS-STARTPTS,fps=${FPS}${N > 1 ? `,split=${N}${outs}` : "[s0]"}`);
      segs.forEach((s, k) => {
        const z = s.zoom || 1;
        const rw = Math.min(sw, even(W / (cover * z))), rh = Math.min(sh, even(H / (cover * z)));
        const crop = rw !== sw || rh !== sh ? `,crop=${rw}:${rh}:${even((sw - rw) / 2)}:${even((sh - rh) * fy)}` : "";
        const scale = rw !== W || rh !== H ? `,scale=${W}:${H}:flags=lanczos` : "";
        g.push(`[s${k}]trim=start_frame=${Math.round(s.s * FPS)}:end_frame=${Math.round(s.e * FPS)},setpts=PTS-STARTPTS${crop}${scale},setsar=1[v${k}]`);
      });
    }
  }
  const aSrc = silent !== null ? `${silent}:a` : `${main}:a`;
  g.push(`[${aSrc}]asetpts=PTS-STARTPTS,aresample=${SR}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo${N > 1 ? `,asplit=${N}${segs.map((_, k) => `[as${k}]`).join("")}` : "[as0]"}`);
  segs.forEach((s, k) => {
    const len = (Math.round(s.e * FPS) - Math.round(s.s * FPS)) / FPS;
    const fade = Math.min(0.006, len / 4);
    g.push(`[as${k}]atrim=start_sample=${Math.round(s.s * FPS) * (SR / FPS)}:end_sample=${Math.round(s.e * FPS) * (SR / FPS)},asetpts=PTS-STARTPTS,afade=t=in:d=${fade},afade=t=out:st=${f3(len - fade)}:d=${fade}[a${k}]`);
  });
  if (audioOnly) g.push(`${segs.map((_, k) => `[a${k}]`).join("")}concat=n=${N}:v=0:a=1[ca]`);
  else g.push(`${segs.map((_, k) => `[v${k}][a${k}]`).join("")}concat=n=${N}:v=1:a=1[cv][ca]`);
  let V = "cv", A = "ca";
  if (!audioOnly) {
    g.push(`[cv]${spd !== 1 ? `setpts=PTS/${spd},fps=${FPS}` : "null"}${toneMap(p.info, caps)}${gradeFilter(p.grade, tmp)},format=yuv420p[cvg]`);
    V = "cvg";
  }
  if (spd !== 1) {
    g.push(`[ca]atempo=${spd}[cas]`);
    A = "cas";
  }

  // ---- B-roll ----
  const mixIns = [];
  p.broll.forEach((b, k) => {
    const dur = b.t1 - b.t0;
    const isImg = b.image;
    const idx = add(isImg ? ["-i", b.src] : ["-ss", String(b.from || 0), "-t", String(dur + 0.1), "-i", b.src]);
    if (b.audio && !isImg && b.hasAudio) {
      g.push(`[${idx}:a]aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${f3(dur)},asetpts=PTS-STARTPTS,volume=${b.audio},adelay=${Math.round(b.t0 * 1000)}:all=1[ba${k}]`);
      mixIns.push(`ba${k}`);
    }
    if (audioOnly) return;
    const split = b.layout === "split";
    const bh = split ? H / 2 : H;
    if (isImg) {
      // Slow push-in on stills: the image is decoded and scaled once (at 2x, so the motion
      // stays smooth) and zoompan makes the frames.
      const frames = Math.max(1, Math.round(dur * FPS));
      g.push(`[${idx}:v]scale=${W * 2}:${bh * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W * 2}:${bh * 2},zoompan=z='1+0.08*on/${frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=${W}x${bh}:fps=${FPS},setsar=1[b${k}f]`);
    } else {
      g.push(`[${idx}:v]setpts=PTS-STARTPTS,fps=${FPS}[b${k}i]`);
      g.push(...fitFilter(`b${k}i`, `b${k}f`, W, bh, b.fit || "cover", `b${k}`));
    }
    g.push(`[b${k}f]format=yuv420p,trim=duration=${f3(dur)},setpts=PTS-STARTPTS+${f3(b.t0)}/TB[b${k}]`);
    const en = `between(t,${f3(b.t0)},${f3(b.t1 - 0.5 / FPS)})`;
    if (split) {
      // Speaker in the top half, B-roll in the bottom half.
      const top = even(H * (p.splitFocus ?? 0.12));
      g.push(`[${V}]split[${V}a][${V}b]`, `[${V}b]crop=${W}:${H / 2}:0:${top}[${V}t]`, `[${V}a][${V}t]overlay=0:0:enable='${en}'[${V}u]`);
      g.push(`[${V}u][b${k}]overlay=0:${H / 2}:eof_action=pass:enable='${en}'[vb${k}]`);
    } else {
      g.push(`[${V}][b${k}]overlay=0:0:eof_action=pass:enable='${en}'[vb${k}]`);
    }
    V = `vb${k}`;
  });

  // ---- flashes, hook, captions ----
  if (!audioOnly) {
    if (p.flash.length) {
      g.push(`[${V}]${p.flash.map((f) => `drawbox=x=0:y=0:w=iw:h=ih:color=${f.color.replace("#", "0x")}@${f.alpha}:t=fill:enable='between(t,${f3(f.t0)},${f3(f.t1)})'`).join(",")}[vfl]`);
      V = "vfl";
    }
    if (p.hook) {
      const h = p.hook;
      // One decoded frame; overlay repeats it and `enable` limits it to the hook window.
      const idx = add(["-i", h.png]);
      g.push(`[${idx}:v]scale=${even(h.w)}:${even(h.h)}:flags=lanczos,format=rgba[hk]`);
      g.push(`[${V}][hk]overlay=${Math.round(h.x)}:${Math.round(h.y)}:enable='lt(t,${f3(h.t1)})'[vh]`);
      V = "vh";
    }
    if (p.ass) {
      fs.writeFileSync(path.join(tmp, "captions.ass"), p.ass);
      linkFonts(tmp);
      g.push(`[${V}]subtitles=f=captions.ass:fontsdir=fonts[vs]`);
      V = "vs";
    }
    g.push(`[${V}]format=yuv420p,trim=duration=${f3(outDur)}[vout]`);
  }

  // ---- audio: clean-up, music, sfx, loudness ----
  const au = p.audio || {};
  const voice = [`highpass=f=70`];
  if (au.denoise) voice.push("afftdn=nf=-25:tn=1");
  if (au.enhance !== false) voice.push("acompressor=threshold=0.1:ratio=2.5:attack=8:release=120:makeup=1.6", "equalizer=f=3500:t=q:w=1.2:g=1.5");
  g.push(`[${A}]${voice.join(",")}[voice]`);
  let VO = "voice";
  if (p.music) {
    const m = p.music;
    const idx = add(["-stream_loop", "-1", "-i", m.src]);
    g.push(`[${idx}:a]aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=${f3(m.from || 0)}:${f3((m.from || 0) + outDur)},asetpts=PTS-STARTPTS,volume=${m.volume},afade=t=in:d=0.3,afade=t=out:st=${f3(Math.max(0, outDur - 1.5))}:d=1.5[mus]`);
    if (m.duck !== false) {
      g.push(`[voice]asplit[voice1][voice2]`, `[mus][voice2]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[musd]`);
      VO = "voice1";
      mixIns.push("musd");
    } else mixIns.push("mus");
  }
  p.sfx.forEach((s, k) => {
    const idx = add(["-i", s.src]);
    g.push(`[${idx}:a]aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${s.volume ?? 0.8},adelay=${Math.round(s.t0 * 1000)}:all=1[sfx${k}]`);
    mixIns.push(`sfx${k}`);
  });
  if (mixIns.length) {
    g.push(`[${VO}]${mixIns.map((l) => `[${l}]`).join("")}amix=inputs=${mixIns.length + 1}:normalize=0:duration=first:dropout_transition=0[mix]`);
    VO = "mix";
  }
  const L = au.loudness ?? -14;
  const ln = loudness
    ? `loudnorm=I=${L}:TP=-1.0:LRA=11:measured_I=${loudness.input_i}:measured_TP=${loudness.input_tp}:measured_LRA=${loudness.input_lra}:measured_thresh=${loudness.input_thresh}:offset=${loudness.target_offset}:linear=true`
    : `loudnorm=I=${L}:TP=-1.0:LRA=11${audioOnly ? ":print_format=json" : ""}`;
  g.push(`[${VO}]${L === false ? "anull" : ln},aresample=${SR},atrim=duration=${f3(outDur)}[aout]`);

  const graphFile = path.join(tmp, audioOnly ? "graph-audio.txt" : "graph.txt");
  fs.writeFileSync(graphFile, g.join(";\n"));
  const graphArg = caps.major >= 7 ? ["-/filter_complex", path.basename(graphFile)] : ["-filter_complex_script", path.basename(graphFile)];
  const args = ["-hide_banner", "-nostdin", "-y", ...inputs.flat(), ...graphArg];
  if (audioOnly) return [...args, "-map", "[aout]", "-f", "null", "-"];
  return [...args, "-map", "[vout]", "-map", "[aout]", ...encoderArgs(p.encoder, p.quality, caps), "-progress", "pipe:1", "-nostats", p.out];
}

function encoderArgs(encoder = "auto", quality = "high", caps) {
  const q = QUALITY[quality] || QUALITY.high;
  let enc = encoder;
  // On a Mac the hardware encoder is several times faster than x264 at the same look.
  if (enc === "auto") enc = process.platform === "darwin" && caps.videotoolbox ? "videotoolbox" : caps.libx264 ? "x264" : caps.videotoolbox ? "videotoolbox" : "nvenc";
  const color = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const common = ["-r", String(FPS), ...(caps.major >= 5 ? ["-fps_mode", "cfr"] : ["-vsync", "cfr"]), "-pix_fmt", "yuv420p", ...color, "-c:a", "aac", "-b:a", "256k", "-ar", String(SR), "-movflags", "+faststart"];
  if (enc === "videotoolbox") return ["-c:v", "h264_videotoolbox", "-b:v", q.vt, "-maxrate", q.vt.replace(/\d+/, (n) => String(Math.round(n * 1.4))), "-profile:v", "high", "-allow_sw", "1", "-g", String(FPS * 2), ...common];
  if (enc === "nvenc") return ["-c:v", "h264_nvenc", ...q.nv, "-rc", "vbr", "-b:v", "0", "-profile:v", "high", "-g", String(FPS * 2), ...common];
  return ["-c:v", "libx264", ...q.x264, "-profile:v", "high", "-level", "4.2", "-g", String(FPS * 2), "-keyint_min", String(FPS), ...common];
}

function linkFonts(tmp) {
  const dst = path.join(tmp, "fonts");
  if (fs.existsSync(dst)) return;
  try {
    fs.symlinkSync(FONTS_DIR, dst, "junction");
  } catch {
    fs.cpSync(FONTS_DIR, dst, { recursive: true });
  }
}

// Renders one plan: a quick audio pass measures loudness, then the full pass encodes.
export async function renderPlan(p, { tmpRoot, onProgress } = {}) {
  const tmp = ensureDir(path.join(tmpRoot, p.id));
  ensureDir(path.dirname(p.out));
  let loud = null;
  if (p.audio?.loudness !== false) {
    const args = await buildCommand(p, tmp, { audioOnly: true });
    const { stderr } = await run(FFMPEG, args, { cwd: tmp });
    const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
    if (m) {
      loud = JSON.parse(m[0]);
      if (!Number.isFinite(Number(loud.input_i))) loud = null; // silent audio
    }
  }
  const args = await buildCommand(p, tmp, { loudness: loud });
  fs.writeFileSync(path.join(tmp, "command.txt"), [FFMPEG, ...args].map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(" "));
  let last = 0;
  await run(FFMPEG, args, {
    cwd: tmp,
    onStdout: (d) => {
      const m = /out_time_us=(\d+)/.exec(d);
      if (m) {
        const pct = Math.min(99, Math.round((Number(m[1]) / 1e6 / p.outDuration) * 100));
        if (pct !== last) onProgress?.((last = pct));
      }
    },
  });
  onProgress?.(100);
  return { loudness: loud ? Number(loud.output_i ?? loud.input_i) : null };
}
