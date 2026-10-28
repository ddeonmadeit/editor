import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { probe } from "./media.js";
import { norm } from "./transcript.js";
import { IMAGE_EXT, VIDEO_EXT, ensureDir, readJSON, stateDir, writeJSON } from "./util.js";

// B-roll comes from the team's own folders first ("library"), and from Pexels when nothing
// there fits. Agents ask for a clip with a few words (`q: "air conditioner"`), never by
// browsing footage, so finding B-roll costs almost no tokens.

const PEXELS_API = process.env.REEL_PEXELS_API || "https://api.pexels.com";
// Clips whose page slug says they're synthetic or graphics, not filmed footage.
const NOT_REAL = /\b(ai|ai-generated|generated|3d|render|rendering|cgi|animation|animated|motion-graphics|digital-art|abstract|illustration|cartoon|hologram|metaverse)\b/;

const stem = (w) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const tokensOf = (s) =>
  String(s)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map(norm)
    .filter((w) => w && w.length > 1 && !/^\d+$/.test(w) && !["img", "mov", "mp4", "dsc", "clip", "the", "and", "with", "of", "a", "in", "on"].includes(w))
    .map(stem);

// Every video/image in the library folders, with search words from its folder names,
// file name and the folder's optional tags.yaml ("file.mp4: words that describe it").
export function scanLibrary(dirs) {
  const items = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d, rel) => {
      let tags = {};
      for (const t of ["tags.yaml", "tags.yml", "tags.json"]) {
        const f = path.join(d, t);
        if (fs.existsSync(f)) tags = (t.endsWith(".json") ? readJSON(f, {}) : YAML.parse(fs.readFileSync(f, "utf8"))) || {};
      }
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, [...rel, e.name]);
        else if (VIDEO_EXT.test(e.name) || IMAGE_EXT.test(e.name)) {
          const words = new Set([...rel.flatMap(tokensOf), ...tokensOf(e.name.replace(/\.[^.]+$/, "")), ...tokensOf(tags[e.name] || "")]);
          items.push({ file: p, name: path.relative(dir, p), words, tags: tags[e.name] || "" });
        }
      }
    };
    walk(dir, []);
  }
  return items;
}

// Best library match for a query: the share of query words found in the clip's words.
export function searchLibrary(items, q, used = new Set()) {
  const qt = [...new Set(tokensOf(q))];
  if (!qt.length) return null;
  let best = null;
  for (const it of items) {
    const hit = qt.filter((w) => it.words.has(w) || [...it.words].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length;
    const score = hit / qt.length - (used.has(it.file) ? 0.3 : 0);
    if (hit && (!best || score > best.score)) best = { ...it, score };
  }
  return best && best.score >= 0.5 ? best : null;
}

function pexelsKey() {
  return process.env.PEXELS_API_KEY || process.env.PEXELS_KEY || "";
}

async function pexelsGet(url) {
  const key = pexelsKey();
  if (!key) throw new Error("no B-roll found locally and PEXELS_API_KEY isn't set (free key: https://www.pexels.com/api/)");
  const r = await fetch(url, { headers: { Authorization: key } });
  if (r.status === 429) throw new Error("Pexels rate limit hit (200/hour, 20k/month); try again later or use local B-roll");
  if (!r.ok) throw new Error(`Pexels HTTP ${r.status}`);
  return r.json();
}

// Searches Pexels for real (filmed) footage, vertical first. Returns candidates, best first.
export async function pexelsSearch(q, { minDur = 0, perPage = 15, orientation = "portrait" } = {}) {
  const url = `${PEXELS_API}/videos/search?query=${encodeURIComponent(q)}&orientation=${orientation}&size=medium&per_page=${perPage}`;
  let j = await pexelsGet(url);
  let vids = j.videos || [];
  if (!vids.length && orientation === "portrait") vids = (await pexelsGet(url.replace("orientation=portrait", "orientation=landscape"))).videos || [];
  return vids
    .filter((v) => !NOT_REAL.test(String(v.url || "").toLowerCase().replace(/[/_]/g, "-").replace(/-/g, " ")))
    .map((v) => ({ id: v.id, width: v.width, height: v.height, duration: v.duration, url: v.url, image: v.image, author: v.user?.name, files: v.video_files || [] }))
    .sort((a, b) => (b.height > b.width) - (a.height > a.width) || (b.duration >= minDur) - (a.duration >= minDur));
}

// The smallest MP4 that still fills 1080x1920 (or the biggest there is).
function pickFile(v) {
  const mp4 = v.files.filter((f) => /mp4/.test(f.file_type || "mp4") && f.link);
  const short = (f) => Math.min(f.width, f.height);
  const good = mp4.filter((f) => short(f) >= 1080 && (f.fps || 30) <= 61).sort((a, b) => a.width * a.height - b.width * b.height);
  return good[0] || mp4.sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

// Fetches one Pexels video (by search result or id) into the workspace cache.
export async function pexelsFetch(v, { ws = process.cwd() } = {}) {
  const dir = ensureDir(path.join(stateDir(ws), "pexels"));
  const dest = path.join(dir, `pexels-${v.id}.mp4`);
  const metaFile = path.join(dir, `pexels-${v.id}.json`);
  if (fs.existsSync(dest)) return { file: dest, ...readJSON(metaFile, {}) };
  if (!v.files?.length) v = { ...v, ...(await pexelsVideo(v.id)) };
  const f = pickFile(v);
  if (!f) throw new Error(`Pexels video ${v.id} has no downloadable MP4`);
  await download(f.link, dest);
  const meta = { id: v.id, author: v.author, url: v.url };
  writeJSON(metaFile, meta);
  return { file: dest, ...meta };
}

async function pexelsVideo(id) {
  const v = await pexelsGet(`${PEXELS_API}/videos/videos/${id}`);
  return { id: v.id, width: v.width, height: v.height, duration: v.duration, url: v.url, image: v.image, author: v.user?.name, files: v.video_files || [] };
}

// Turns every B-roll request in a batch into a file. Request forms:
//   "new floors"                     at that phrase, search for it
//   { at, q: "floor tiles" }         library first, then Pexels
//   { at, src: "broll/x.mp4" }       that file (a name that isn't a file is searched for)
//   { at, pexels: "floor tiles" }    Pexels only;  { at, pexels: 3571264 } that exact video
// A clip isn't reused within a batch while another match exists. Returns credits for
// the Pexels clips used.
export async function resolveBroll(videos, { ws = process.cwd(), onLog } = {}) {
  const used = new Set();
  const credits = new Map();
  const libCache = new Map();
  const pexelsCache = new Map();
  for (const v of videos) {
    const dirs = [].concat(v.library || []).map((d) => path.resolve(v.base, String(d).replace(/^~(?=$|[\\/])/, os.homedir())));
    const key = dirs.join("|");
    if (!libCache.has(key)) libCache.set(key, scanLibrary(dirs));
    const lib = libCache.get(key);
    v.broll = (v.broll || []).map((b) => (typeof b === "string" ? { at: b, q: b } : { ...b }));
    for (const b of v.broll) {
      try {
        if (b.src && fs.existsSync(path.resolve(v.base, b.src))) {
          b.src = path.resolve(v.base, b.src);
          used.add(b.src);
          continue;
        }
        const q = b.pexels ?? b.q ?? b.find ?? b.src ?? (typeof b.at === "string" ? b.at : null);
        if (q == null) throw new Error("needs src, q or pexels");
        if (b.pexels === undefined) {
          const hit = searchLibrary(lib, String(q), used);
          if (hit) {
            b.src = hit.file;
            used.add(hit.file);
            b.found = `library:${hit.name}`;
            continue;
          }
        }
        let pick;
        if (typeof q === "number" || /^\d+$/.test(String(q))) pick = { id: Number(q) };
        else {
          if (!pexelsCache.has(q)) pexelsCache.set(q, await pexelsSearch(String(q), { minDur: Number(b.dur) || 2 }));
          const list = pexelsCache.get(q);
          pick = list.find((c) => !used.has(`pexels:${c.id}`)) || list[0];
          if (!pick) throw new Error(`nothing on Pexels for "${q}"`);
        }
        const got = await pexelsFetch(pick, { ws });
        used.add(`pexels:${got.id}`);
        b.src = got.file;
        b.found = `pexels:${got.id}`;
        b.credit = { id: got.id, author: got.author, url: got.url };
        credits.set(got.id, got);
        onLog?.(`b-roll "${q}" → Pexels ${got.id}${got.author ? ` by ${got.author}` : ""}`);
      } catch (e) {
        b.error = e.message;
      }
    }
  }
  return [...credits.values()];
}

// Compact listing of a library for agents: name, length, size, tags.
export async function describeLibrary(dirs) {
  const items = scanLibrary(dirs);
  const out = [];
  for (const it of items) {
    let info = "";
    if (VIDEO_EXT.test(it.file)) {
      const p = await probe(it.file).catch(() => null);
      if (p) info = `${Math.round(p.duration * 10) / 10}s ${p.width}x${p.height}`;
    } else info = "image";
    out.push(`${it.name} ${info}${it.tags ? ` | ${it.tags}` : ""}`);
  }
  return { items, text: out.join("\n") };
}
