import { POSITIONS, TEXT_STYLES } from "./styles.js";
import { H, W, assColor, round } from "./util.js";

// Groups spoken words (with output times os/oe) into short caption chunks: at most
// `words` words and `chars` characters, broken at punctuation and pauses.
export function chunkWords(kept, { words = 3, chars = 16, pause = 0.3 } = {}) {
  const chunks = [];
  let cur = null;
  kept.forEach((w, i) => {
    const prev = kept[i - 1];
    const text = w.w;
    const brk =
      !cur ||
      cur.words.length >= words ||
      cur.text.length + 1 + text.length > chars ||
      /[.?!,;:]["”’)]?$/.test(prev.w) ||
      w.os - prev.oe > pause;
    if (brk) chunks.push((cur = { words: [], text: "" }));
    cur.words.push(w);
    cur.text = cur.text ? `${cur.text} ${text}` : text;
  });
  chunks.forEach((c, i) => {
    c.start = c.words[0].os;
    const lastEnd = c.words[c.words.length - 1].oe;
    const next = chunks[i + 1];
    // Stay up until the next caption, unless there's a real gap before it.
    c.end = next && next.words[0].os - lastEnd < 0.6 ? next.words[0].os : lastEnd + 0.25;
  });
  return chunks;
}

const esc = (s) => String(s).replace(/\\/g, "＼").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");

const ts = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

const caseOf = (s, c) => (c === "upper" ? s.toUpperCase() : c === "lower" ? s.toLowerCase() : s);

// Two lines when a chunk is too wide for one: break at the space nearest the middle.
function wrap(text, maxChars) {
  if (text.length <= maxChars + 2 || !text.includes(" ")) return [text];
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return [text.slice(0, best), text.slice(best + 1)];
}

// The dialogue lines for one piece of text: drop shadow, outer rim, then the text itself.
// `parts` is [{ text, color }] so single words can be coloured.
function layers(style, x, y, start, end, parts, { pop = true, mainOnly = false, maxChars = 18 } = {}) {
  const out = [];
  const popTag = pop && style.pop !== 0 ? `\\fscx${100 - Math.round((style.pop ?? 0.12) * 100)}\\fscy${100 - Math.round((style.pop ?? 0.12) * 100)}\\t(0,${style.popMs ?? 90},\\fscx100\\fscy100)` : "";
  // A long chunk wraps onto two lines: the space nearest the middle becomes a line break.
  const lines = wrap(parts.map((p) => p.text).join(""), maxChars);
  let breakAt = lines.length > 1 ? lines[0].length : -1;
  const marked = parts.map((p) => {
    let t = p.text;
    if (breakAt >= 0 && breakAt < t.length) t = `${t.slice(0, breakAt)}\u0000${t.slice(breakAt + 1)}`;
    breakAt -= p.text.length;
    return { ...p, text: t };
  });
  const body = (colored) =>
    marked
      .map((p) => {
        const t = esc(p.text).replace(/\u0000/g, "\\N");
        return colored && p.color ? `{\\1c${assColor(p.color)}}${t}{\\1c${assColor(style.color)}}` : t;
      })
      .join("");
  const font = `\\fn${style.font}\\fs${style.size}`;
  const stroke = style.stroke || 0, outer = style.outer || 0;
  const sh = style.shadow;
  if (!mainOnly && sh) {
    const a = assColor(sh.color, sh.alpha).slice(2, 4);
    out.push(`Dialogue: 0,${ts(start)},${ts(end)},Base,,0,0,0,,{\\an5\\pos(${round(x + sh.x)},${round(y + sh.y)})${font}\\bord${stroke + outer}\\shad0\\blur${sh.blur}\\1c${assColor(sh.color)}\\3c${assColor(sh.color)}\\1a&H${a}&\\3a&H${a}&${popTag}}${body(false)}`);
  }
  if (!mainOnly && outer) {
    out.push(`Dialogue: 1,${ts(start)},${ts(end)},Base,,0,0,0,,{\\an5\\pos(${round(x)},${round(y)})${font}\\bord${stroke + outer}\\shad0\\1c${assColor(style.outerColor)}\\3c${assColor(style.outerColor)}${popTag}}${body(false)}`);
  }
  out.push(`Dialogue: 2,${ts(start)},${ts(end)},Base,,0,0,0,,{\\an5\\pos(${round(x)},${round(y)})${font}\\bord${stroke}\\shad0\\1c${assColor(style.color)}\\3c${assColor(style.strokeColor || "#000000")}${popTag}}${body(true)}`);
  return out;
}

const normWord = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// Caption events for chunks. Words listed in `highlight` get the highlight colour; with
// `active` set, the word being spoken is lit up as well.
export function captionEvents(chunks, style, { highlight = [] } = {}) {
  const hl = new Set(highlight.flatMap((h) => String(h).split(/\s+/)).map(normWord).filter(Boolean));
  const x = W / 2, y = style.y * H;
  const ev = [];
  for (const c of chunks) {
    const partsFor = (active) =>
      c.words.map((w, k) => ({
        text: caseOf(w.w, style.case) + (k < c.words.length - 1 ? " " : ""),
        color: k === active ? style.active : hl.has(normWord(w.w)) ? style.highlight : null,
      }));
    if (!style.active || c.words.length === 1) {
      ev.push(...layers(style, x, y, c.start, c.end, partsFor(style.active ? 0 : -1), { maxChars: style.chars + 2 }));
      continue;
    }
    // Karaoke: the backing layers span the chunk, the text layer changes per word.
    ev.push(...layers(style, x, y, c.start, c.end, partsFor(-1), { maxChars: style.chars + 2 }).slice(0, -1));
    c.words.forEach((w, k) => {
      const s = k === 0 ? c.start : w.os;
      const e = k + 1 < c.words.length ? c.words[k + 1].os : c.end;
      if (e > s) ev.push(...layers(style, x, y, s, e, partsFor(k), { pop: k === 0, mainOnly: true, maxChars: style.chars + 2 }));
    });
  }
  return ev;
}

// "-$50,000" -> { pre: "-$", n: 50000, post: "", commas: true, decimals: 0 }
export function parseNumber(text) {
  const m = /^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(String(text));
  if (!m) return null;
  const digits = m[2].replace(/,/g, "");
  return { pre: m[1], n: Number(digits), post: m[3], commas: m[2].includes(","), decimals: (digits.split(".")[1] || "").length };
}

const fmtNumber = (p, v) => {
  let s = v.toFixed(p.decimals);
  if (p.commas) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${p.pre}${s}${p.post}`;
};

// On-screen text callouts. With `count`, the number in the text ticks up from 1 to its
// value (evenly in log scale, like a slot counter) over `count` seconds.
export function textEvents(texts) {
  const ev = [];
  for (const t of texts) {
    const style = { ...(TEXT_STYLES[t.style || "white"] || TEXT_STYLES.white) };
    if (t.size) style.size = t.size;
    if (t.color) style.color = t.color;
    const y = (typeof t.y === "number" ? t.y : POSITIONS[t.y || t.pos || "top"] ?? POSITIONS.top) * H;
    const parts = (text) => [{ text: caseOf(text, t.case), color: null }];
    const num = t.count ? parseNumber(t.text) : null;
    if (num && num.n > 1) {
      const span = Math.min(typeof t.count === "number" ? t.count : 1, t.end - t.start);
      const step = 2 / 60;
      for (let k = 0, s = t.start; s < t.start + span - 1e-6; k++, s += step) {
        const p = (s - t.start) / span;
        const v = Math.round(Math.pow(num.n, p) * 10 ** num.decimals) / 10 ** num.decimals;
        ev.push(...layers(style, W / 2, y, s, Math.min(s + step, t.start + span), parts(fmtNumber(num, v)), { pop: k === 0, maxChars: 40 }));
      }
      ev.push(...layers(style, W / 2, y, t.start + span, t.end, parts(t.text), { pop: false, maxChars: 40 }));
    } else {
      ev.push(...layers(style, W / 2, y, t.start, t.end, parts(t.text), { maxChars: 30 }));
    }
  }
  return ev;
}

export function assFile(events) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Base,Arimo Bold Italic,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}
