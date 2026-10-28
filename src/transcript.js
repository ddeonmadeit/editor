import { fmtDur, round } from "./util.js";

// Splits words into numbered lines: at sentence ends, at pauses, or when a line gets long.
// Line ids are what agents use to drop retakes ("drop: [3, 5-7]").
export function buildLines(words, { pause = 0.6, maxWords = 24 } = {}) {
  const lines = [];
  let cur = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const brk =
      !cur ||
      /[.?!]["”’)]?$/.test(prev.w) ||
      w.s - prev.e >= pause ||
      cur.n >= maxWords ||
      (cur.n >= 12 && /[,;:]$/.test(prev.w));
    if (brk) {
      cur = { id: lines.length + 1, w0: i, w1: i, n: 0 };
      lines.push(cur);
    }
    cur.w1 = i;
    cur.n++;
  });
  for (const l of lines) {
    l.s = words[l.w0].s;
    l.e = words[l.w1].e;
    l.text = words.slice(l.w0, l.w1 + 1).map((w) => w.w).join(" ");
    delete l.n;
  }
  markRetakes(lines, words);
  return lines;
}

export const norm = (w) =>
  String(w)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

const tokens = (l, words) => words.slice(l.w0, l.w1 + 1).map((w) => norm(w.w)).filter(Boolean);

// A line is probably a fumbled take when one of the next two lines starts the same way,
// or repeats most of it. The flag is a hint for the agent; nothing is dropped on its own
// unless the batch says `retakes: auto`.
function markRetakes(lines, words) {
  for (let i = 0; i < lines.length; i++) {
    const a = tokens(lines[i], words);
    if (a.length === 0) continue;
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      const b = tokens(lines[j], words);
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      // Shared word pairs, so lines that only share "and", "it", "the" don't count.
      const pairs = (x) => x.slice(1).map((w, k) => `${x[k]} ${w}`);
      const pb = new Set(pairs(b));
      const pa = pairs(a);
      const shared = pa.length ? pa.filter((x) => pb.has(x)).length / pa.length : 0;
      if (p >= 3 || (p >= 2 && a.length <= 3) || (a.length >= 5 && shared >= 0.6)) {
        lines[i].retakeOf = lines[j].id;
        break;
      }
    }
  }
}

// The transcript as agents read it: one numbered line each, start time, text, hints.
export function formatTranscript(t, lines, { header = true } = {}) {
  const out = [];
  if (header) out.push(`# ${t.id} ${fmtDur(t.duration)} ${t.video ? `${t.video.width}x${t.video.height}@${Math.round(t.video.fps)}` : ""} | line start text${lines.some((l) => l.retakeOf) ? " | R>n = likely retake, redone in line n" : ""}`);
  for (const l of lines) out.push(`${l.id} ${round(l.s, 1)} ${l.text}${l.retakeOf ? `  R>${l.retakeOf}` : ""}`);
  return out.join("\n");
}

// Parses "3", "5-7", [3, "5-7"], "3,5-7" into a Set of line ids.
export function parseIds(v) {
  const ids = new Set();
  const parts = Array.isArray(v) ? v : v == null || v === false ? [] : String(v).split(/[,\s]+/);
  for (const p of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(p).trim());
    if (!m) {
      if (String(p).trim()) throw new Error(`bad line id "${p}" (use numbers like 3 or ranges like 5-7)`);
      continue;
    }
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) ids.add(k);
  }
  return ids;
}

// Finds a phrase in the words, ignoring case and punctuation. `allowed(i)` limits the
// search (e.g. to words that survive the cut). Returns { w0, w1 } or null.
export function findPhrase(words, phrase, { allowed = () => true, from = 0 } = {}) {
  const q = String(phrase).split(/\s+/).map(norm).filter(Boolean);
  if (!q.length) return null;
  const n = words.map((w) => norm(w.w));
  const endOfMatch = (i) => {
    let k = i;
    for (const tok of q) {
      while (k < n.length && !n[k]) k++; // punctuation-only "words" don't count
      if (k >= n.length || n[k] !== tok || !allowed(k)) return -1;
      k++;
    }
    return k - 1;
  };
  // First match at or after `from`, else the first one before it.
  for (const i of [...n.keys()].slice(from).concat([...n.keys()].slice(0, from))) {
    if (!n[i]) continue;
    const end = endOfMatch(i);
    if (end >= 0) return { w0: i, w1: end };
  }
  return null;
}

// Spelling fixes for captions and phrase lookups: { parks: "Parkes", "Travel Pinot":
// "Travelpreneur" }. Every match is replaced, keeping the punctuation around it. A
// multi-word match becomes one word and the rest are left empty, so indices don't move.
export function applyFixes(words, fixes) {
  const out = words.map((w) => ({ ...w }));
  for (const [from, to] of Object.entries(fixes || {})) {
    const q = String(from).split(/\s+/).map(norm).filter(Boolean);
    if (!q.length) continue;
    for (let i = 0; i < out.length; i++) {
      const hit = [];
      for (let k = i; hit.length < q.length && k < out.length; k++) {
        const n = norm(out[k].w);
        if (!n && hit.length) continue; // an emptied word inside the match
        if (n !== q[hit.length]) break;
        hit.push(k);
      }
      if (hit.length < q.length) continue;
      const first = out[hit[0]], last = out[hit[hit.length - 1]];
      const lead = /^[^\p{L}\p{N}$]*/u.exec(first.w)[0];
      const trail = /[^\p{L}\p{N}]*$/u.exec(last.w)[0];
      first.w = `${lead}${to}${trail}`;
      first.e = last.e;
      if (last.oe !== undefined) first.oe = last.oe;
      for (const h of hit.slice(1)) out[h].w = "";
      i = hit[hit.length - 1];
    }
  }
  return out;
}

// The closest phrase in the transcript to a query that wasn't found, for error messages.
export function closest(words, phrase) {
  const q = String(phrase).split(/\s+/).map(norm).filter(Boolean);
  const n = words.map((w) => norm(w.w));
  let best = null;
  for (let i = 0; i + q.length <= n.length; i++) {
    let score = 0;
    for (let j = 0; j < q.length; j++) score += similarity(n[i + j], q[j]);
    if (!best || score > best.score) best = { score, i };
  }
  return best ? words.slice(best.i, best.i + q.length).map((w) => w.w).join(" ") : null;
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
