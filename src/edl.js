import { closest, findPhrase, parseIds } from "./transcript.js";
import { FPS, clamp, snap } from "./util.js";

// How hard pauses are cut. gap: longest pause kept inside a take (s). pre/tail: breathing
// room kept before a phrase starts and after it ends (s), measured from the real speech
// onset/offset when the loudness envelope is available.
export const PACING = {
  tight: { gap: 0.22, pre: 0.04, tail: 0.07 },
  normal: { gap: 0.38, pre: 0.06, tail: 0.11 },
  loose: { gap: 0.7, pre: 0.1, tail: 0.18 },
  off: { gap: Infinity, pre: 0.25, tail: 0.4 },
};

const FILLERS = new Set(["um", "uh", "umm", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm"]);

// Works out which parts of the source survive: drops (line ids), cuts (phrases or time
// ranges), fillers and pauses. Returns frame-aligned segments and the surviving words with
// their output times.
export function buildEdit(t, words, lines, o = {}) {
  const errors = [];
  const removed = new Set();
  const dur = t.duration;
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const removeLine = (id) => {
    const l = lineById.get(id);
    if (!l) return errors.push(`drop: line ${id} doesn't exist (last line is ${lines.length})`);
    for (let i = l.w0; i <= l.w1; i++) removed.add(i);
  };

  let drop;
  try {
    drop = parseIds(o.drop);
  } catch (e) {
    errors.push(`drop: ${e.message}`);
    drop = new Set();
  }
  for (const id of drop) removeLine(id);
  if (o.retakes === "auto") for (const l of lines) if (l.retakeOf) removeLine(l.id);
  if (o.keep) {
    // keep: only these lines survive
    const keep = parseIds(o.keep);
    for (const l of lines) if (!keep.has(l.id)) removeLine(l.id);
  }

  const timeCuts = [];
  for (const c of [].concat(o.cut || [])) {
    if (Array.isArray(c) && c.length === 2 && c.every((x) => typeof x === "number")) {
      timeCuts.push([Math.min(...c), Math.max(...c)]);
      continue;
    }
    const isRange = c && typeof c === "object" && !Array.isArray(c);
    const a = findPhrase(words, isRange ? c.from : c, { allowed: (i) => !removed.has(i) });
    const b = isRange ? a && findPhrase(words, c.to, { allowed: (i) => !removed.has(i), from: a.w0 }) : a;
    if (!a || !b || b.w1 < a.w0) {
      const miss = !a ? (isRange ? c.from : c) : c.to;
      const near = closest(words, miss);
      errors.push(`cut: "${miss}" not found${near ? ` (closest: "${near}")` : ""}`);
      continue;
    }
    for (let i = a.w0; i <= b.w1; i++) removed.add(i);
  }
  for (const [a, b] of timeCuts) for (const w of words) if ((w.s + w.e) / 2 >= a && (w.s + w.e) / 2 <= b) removed.add(w.i);
  if (o.fillers !== false) for (const w of words) if (FILLERS.has(w.w.toLowerCase().replace(/[^a-z]/g, ""))) removed.add(w.i);

  const [t0, t1] = o.trim ? [Math.max(0, o.trim[0] || 0), Math.min(dur, o.trim[1] ?? dur)] : [0, dur];
  for (const w of words) if (w.e <= t0 || w.s >= t1) removed.add(w.i);

  const pace = typeof o.pacing === "object" ? { ...PACING.normal, ...o.pacing } : PACING[o.pacing || "normal"];
  if (!pace) errors.push(`pacing: use one of ${Object.keys(PACING).join(", ")}`);
  const P = pace || PACING.normal;

  // Group surviving words into takes: consecutive words with no removed word between them
  // and no pause longer than P.gap.
  const groups = [];
  let g = null;
  for (const w of words) {
    if (removed.has(w.i)) {
      g = null;
      continue;
    }
    if (g && w.s - words[g.last].e <= P.gap) g.last = w.i;
    else groups.push((g = { first: w.i, last: w.i }));
  }

  const env = t.env && t.env.length ? t.env : null;
  const thr = env ? threshold(env, words) : 0;
  let segs = groups.map(({ first, last }) => {
    const a = words[first], b = words[last];
    const prevEnd = first > 0 ? words[first - 1].e : 0;
    const nextStart = last + 1 < words.length ? words[last + 1].s : dur;
    let s = a.s, e = b.e;
    if (env) {
      s = Math.min(s, onset(env, a.s, thr, Math.max(prevEnd, a.s - 0.25)));
      e = Math.max(e, offset(env, b.e, thr, Math.min(nextStart, b.e + 0.35)));
    }
    s -= P.pre;
    e += P.tail;
    // Never reach into a neighbouring word that was cut away.
    if (first > 0 && removed.has(first - 1)) s = Math.max(s, prevEnd + 0.02);
    if (last + 1 < words.length && removed.has(last + 1)) e = Math.min(e, nextStart - 0.02);
    return [clamp(s, t0, t1), clamp(e, t0, t1)];
  });
  for (const [a, b] of timeCuts) segs = segs.flatMap(([s, e]) => (b <= s || a >= e ? [[s, e]] : [[s, a], [b, e]].filter(([x, y]) => y - x > 0.05)));

  // Frame-align, merge touching segments, drop slivers.
  const out = [];
  for (let [s, e] of segs) {
    s = snap(s);
    e = snap(e);
    if (e - s < 2 / FPS) continue;
    const prev = out[out.length - 1];
    if (prev && s <= prev.e + 2 / FPS) prev.e = Math.max(prev.e, e);
    else out.push({ s, e });
  }
  let o2 = 0;
  for (const seg of out) {
    seg.o = o2;
    o2 += seg.e - seg.s;
  }

  const toOut = (x) => {
    for (const seg of out) {
      if (x < seg.s) return seg.o;
      if (x <= seg.e) return seg.o + (x - seg.s);
    }
    return o2;
  };
  const kept = [];
  for (const w of words) {
    if (removed.has(w.i)) continue;
    const mid = (w.s + w.e) / 2;
    const seg = out.find((x) => mid >= x.s && mid <= x.e);
    if (!seg) continue;
    kept.push({ ...w, os: toOut(Math.max(w.s, seg.s)), oe: toOut(Math.min(w.e, seg.e)) });
  }
  return { segments: out, kept, removed, duration: o2, toOut, errors };
}

const at = (env, t) => env[clamp(Math.round(t * 100), 0, env.length - 1)];

// Speech/silence threshold from the envelope: a third of the way from the noise floor
// to typical speech level.
function threshold(env, words) {
  const all = Array.from(env).sort((a, b) => a - b);
  const floor = all[Math.floor(all.length * 0.1)];
  const speech = [];
  for (const w of words) for (let t = w.s; t < w.e; t += 0.01) speech.push(at(env, t));
  speech.sort((a, b) => a - b);
  const level = speech.length ? speech[Math.floor(speech.length / 2)] : floor + 30;
  return Math.max(floor + 6, floor + (level - floor) * 0.35);
}

// Where speech really starts: walk back from t while it's loud, but not past `limit`.
function onset(env, t, thr, limit) {
  let x = t + 0.03;
  while (x - 0.01 >= limit && (at(env, x - 0.01) >= thr || at(env, x - 0.02) >= thr)) x -= 0.01;
  return Math.min(t, x);
}

// Where speech really stops: walk forward from t while it's loud (gaps under 40 ms bridged).
function offset(env, t, thr, limit) {
  let x = t - 0.05, quiet = 0;
  while (x < limit) {
    if (at(env, x) >= thr) quiet = 0;
    else if ((quiet += 0.01) > 0.04) break;
    x += 0.01;
  }
  return Math.max(t, x - quiet);
}
