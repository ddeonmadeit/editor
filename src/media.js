import { run } from "./util.js";

export const FFMPEG = process.env.REEL_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.REEL_FFPROBE || "ffprobe";

const probeCache = new Map();

// What the editor needs to know about a source file.
export async function probe(file) {
  if (probeCache.has(file)) return probeCache.get(file);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout.toString());
  const v = j.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = j.streams.find((s) => s.codec_type === "audio");
  let rotation = 0;
  for (const sd of v?.side_data_list || []) if (typeof sd.rotation === "number") rotation = sd.rotation;
  if (v?.tags?.rotate) rotation = Number(v.tags.rotate);
  const swap = Math.abs(rotation) % 180 === 90;
  const [n, d] = (v?.avg_frame_rate || v?.r_frame_rate || "0/1").split("/").map(Number);
  const info = {
    duration: Number(j.format.duration) || Number(v?.duration) || 0,
    width: v ? (swap ? v.height : v.width) : 0,
    height: v ? (swap ? v.width : v.height) : 0,
    fps: d ? n / d : 0,
    codec: v?.codec_name,
    pixFmt: v?.pix_fmt,
    transfer: v?.color_transfer || "",
    hdr: ["arib-std-b67", "smpte2084"].includes(v?.color_transfer),
    hasVideo: !!v,
    hasAudio: !!a,
    sampleRate: a ? Number(a.sample_rate) : 0,
  };
  probeCache.set(file, info);
  return info;
}

let caps;
// ffmpeg version and the optional filters/encoders this build has.
export async function ffmpegCaps() {
  if (caps) return caps;
  const [ver, filters, encoders] = await Promise.all([
    run(FFMPEG, ["-hide_banner", "-version"]),
    run(FFMPEG, ["-hide_banner", "-filters"]),
    run(FFMPEG, ["-hide_banner", "-encoders"]),
  ]);
  const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(ver.stdout.toString());
  const f = filters.stdout.toString(), e = encoders.stdout.toString();
  const has = (txt, name) => new RegExp(`\\s${name}\\s`).test(txt);
  caps = {
    major: m ? Number(m[1]) : 6,
    version: m ? `${m[1]}.${m[2]}` : "?",
    subtitles: has(f, "subtitles"),
    zscale: has(f, "zscale"),
    lut3d: has(f, "lut3d"),
    libx264: has(e, "libx264"),
    videotoolbox: has(e, "h264_videotoolbox"),
    nvenc: has(e, "h264_nvenc"),
  };
  return caps;
}

// Mono 16 kHz float samples of a file's audio track.
export async function decodeAudio(file, rate = 16000) {
  const { stdout } = await run(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"]);
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
}

// Loudness envelope at 100 Hz (10 ms hops) in dBFS, clamped to -100..0, one byte per hop.
// Used to snap cut points to where speech actually starts and stops.
export function envelope(samples, rate = 16000) {
  const hop = rate / 100;
  const n = Math.floor(samples.length / hop);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop, end = k + hop; k < end; k++) s += samples[k] * samples[k];
    const db = 10 * Math.log10(s / hop + 1e-10);
    out[i] = Math.max(0, Math.min(100, Math.round(db + 100)));
  }
  return out;
}
