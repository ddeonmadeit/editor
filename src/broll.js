import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { probe } from "./media.js";
import { norm } from "./transcript.js";
import { IMAGE_EXT, VIDEO_EXT, ensureDir, readJSON, sha1, stateDir, writeJSON } from "./util.js";

// B-roll comes from the team's own folders first ("library"), then from Pixabay (free API
// key), or Pexels first if an old Pexels key is around. Agents ask for a clip with a few
// words (`q: "air conditioner"`), never by browsing footage, so finding B-roll costs almost
// no tokens.

// Clips whose title, tags or page slug say they're synthetic or graphics, not filmed.
// Pixabay tags its AI uploads "ai generated"; the fantasy words catch AI clips that aren't
// tagged (they're rarely real footage anyway).
const NOT_REAL = /\b(ai|ai generated|generated|generative|midjourney|stable diffusion|sora|runway|kling|3d|render|rendering|cgi|animation|animated|motion graphics|digital art|abstract|illustration|cartoon|hologram|metaverse|fantasy|surreal|futuristic|sci fi|scifi|cyberpunk|magical|fairy|nymph|mermaid|elf|dragon)\b/;
const looksSynthetic = (...texts) => NOT_REAL.test(texts.flat().filter(Boolean).join(" ").toLowerCase().replace(/[/_-]+/g, " "));
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const tokensOf = (s) =>
  String(s)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map(norm)
    .filter((w) => w && w.length > 1 && !/^\d+$/.test(w) && !["img", "mov", "mp4", "dsc", "clip", "the", "and", "with", "of", "a", "in", "on", "at", "to", "for", "new", "old", "my", "our", "your", "some", "very"].includes(w))
    .map(stem);

// "conditioner"/"conditioning", "renovate"/"renovation": a long shared start counts as the same word.
function sameRoot(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= 4 && n >= Math.min(a.length, b.length) * 0.75;
}

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

// ---------- stock sites ----------

export const STOCK_SITES = ["pexels", "pixabay"];
// Sites tried, in order, when a batch doesn't say; only those with a key are used.
export const DEFAULT_STOCK = ["pexels", "pixabay"];
const DAY = 24 * 3600 * 1000;
const api = (site, fallback) => process.env[`REEL_${site.toUpperCase()}_API`] || fallback;

async function getJSON(url, headers, name) {
  const r = await fetch(url, { headers });
  if (r.status === 429) throw new Error(`${name} rate limit hit; try again later, or use library clips / src:`);
  if (r.status === 401 || r.status === 403) throw new Error(`${name} rejected the API key (HTTP ${r.status})`);
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120).trim()}`);
  return r.json();
}

// Every site returns candidates shaped alike: { site, id, width, height, duration, title,
// author, page, thumb, files: [{ link, width, height }] }. Synthetic-looking clips are dropped.
const SITES = {
  pexels: {
    name: "Pexels",
    env: ["PEXELS_API_KEY", "PEXELS_KEY"],
    get: (url, key) => getJSON(url, { Authorization: key }, "Pexels"),
    map: (v) => ({ site: "pexels", id: String(v.id), width: v.width, height: v.height, duration: v.duration, title: "", author: v.user?.name, page: v.url, thumb: v.image, files: (v.video_files || []).filter((f) => /mp4/.test(f.file_type || "mp4")).map((f) => ({ link: f.link, width: f.width, height: f.height, fps: f.fps })) }),
    async search(q, key) {
      const base = `${api("pexels", "https://api.pexels.com")}/videos/search?query=${encodeURIComponent(q)}&size=medium&per_page=20`;
      let vids = (await this.get(`${base}&orientation=portrait`, key)).videos || [];
      if (vids.length < 3) vids = vids.concat((await this.get(`${base}&orientation=landscape`, key)).videos || []);
      return vids.filter((v) => !looksSynthetic(v.url)).map(this.map);
    },
    async byId(id, key) {
      return this.map(await this.get(`${api("pexels", "https://api.pexels.com")}/videos/videos/${id}`, key));
    },
  },
  pixabay: {
    name: "Pixabay",
    env: ["PIXABAY_API_KEY", "PIXABAY_KEY"],
    // The team's key, built in so B-roll works with no setup. PIXABAY_API_KEY overrides it;
    // PIXABAY_API_KEY=off turns Pixabay off.
    builtin: "58277522-9aa5dbf0e1f51622b68eb7ac1",
    keyPattern: /^\d+-[0-9a-f]{20,}$/i,
    get: (url) => getJSON(url, {}, "Pixabay"),
    map: (v) => {
      const sizes = Object.values(v.videos || {}).filter((f) => f && f.url);
      const ref = [...sizes].sort((a, b) => b.width * b.height - a.width * a.height)[0] || {};
      return { site: "pixabay", id: String(v.id), width: ref.width, height: ref.height, duration: v.duration, title: v.tags, author: v.user, page: v.pageURL, thumb: ref.thumbnail, text: [v.tags, v.pageURL], files: sizes.map((f) => ({ link: f.url, width: f.width, height: f.height })) };
    },
    // video_type=film leaves out animations; AI uploads are caught by their tags (see NOT_REAL).
    async search(q, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q.slice(0, 100))}&video_type=film&safesearch=true&per_page=50`);
      return (j.hits || []).map(this.map).filter((c) => !looksSynthetic(c.text));
    },
    async byId(id, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/videos/?key=${encodeURIComponent(key)}&id=${id}`);
      if (!j.hits?.length) throw new Error(`Pixabay video ${id} not found`);
      return this.map(j.hits[0]);
    },
  },
};

// A site's key: from the environment, else the built-in one. A value that can't be a key
// (e.g. a "<placeholder>" copied from instructions) is ignored; "off" turns the site off.
export function stockKey(site) {
  const s = SITES[site];
  if (!s) return "";
  for (const name of s.env) {
    const v = (process.env[name] || "").trim();
    if (v.toLowerCase() === "off") return "";
    if (v && (!s.keyPattern || s.keyPattern.test(v))) return v;
  }
  return s.builtin || "";
}
export const stockSites = (order = DEFAULT_STOCK) => [].concat(order).filter((s) => SITES[s] && stockKey(s));
export const NO_KEY = "no stock site to search (Pixabay is turned off with PIXABAY_API_KEY=off, or the batch's stock: list only names sites without a key)";

// Searches one site (results cached on disk for a day, which Pixabay requires and which
// saves requests). Vertical clips first.
async function searchSite(site, q, { ws, minDur = 2 }) {
  const file = path.join(stateDir(ws), "stock", "search", `${site}-${sha1(q.toLowerCase()).slice(0, 16)}.json`);
  const cached = readJSON(file);
  let list;
  if (cached && Date.now() - cached.t < DAY) list = cached.list;
  else {
    list = await SITES[site].search(q, stockKey(site));
    writeJSON(file, { t: Date.now(), list });
  }
  // Stock search is loose (Pixabay ranks by popularity), so rank by how many of the asked-for
  // words the clip's tags/title actually have; vertical and long-enough only break ties.
  const want = [...new Set(tokensOf(q))];
  const hits = (w, words) => words.some((x) => x === w || sameRoot(w, x));
  const rel = (c) => {
    const have = tokensOf([c.title, c.page].filter(Boolean).join(" "));
    return want.length ? want.filter((w) => hits(w, have)).length / want.length : 0;
  };
  // Tags come most-relevant first: a clip whose first tags match beats one where the words
  // are incidental (a "construction worker" request shouldn't get ants at work).
  const tagFocus = (c) => {
    const tags = String(c.title || c.page || "").split(/,|\/|-/).map((t) => tokensOf(t)).filter((t) => t.length);
    return Math.round(want.reduce((sum, w) => {
      const i = tags.findIndex((t) => hits(w, t));
      return sum + (i < 0 ? 0 : 1 / (1 + i));
    }, 0) * 10) / 10;
  };
  const vertical = (c) => c.height > c.width;
  const ranked = list
    .map((c) => ({ ...c, rel: rel(c), focus: tagFocus(c) }))
    .sort((a, b) => b.rel - a.rel || b.focus - a.focus || vertical(b) - vertical(a) || (b.duration >= minDur) - (a.duration >= minDur));
  // Clips that share no word with the request are only a last resort.
  return ranked.some((c) => c.rel > 0) ? ranked.filter((c) => c.rel > 0) : ranked;
}

// Candidates for a query from every site with a key (or the given ones), in order.
export async function stockSearch(q, { ws = process.cwd(), sites = DEFAULT_STOCK, perSite = 8 } = {}) {
  const use = stockSites(sites);
  if (!use.length) throw new Error(NO_KEY);
  const out = [], errors = [];
  for (const s of use) {
    try {
      out.push(...(await searchSite(s, q, { ws })).slice(0, perSite));
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!out.length && errors.length) throw new Error(errors.join("; "));
  return out;
}

export const formatStock = (c) => `${c.site} ${c.id} ${c.width}x${c.height} ${Math.round(c.duration * 10) / 10}s${c.title ? ` "${String(c.title).slice(0, 50)}"` : ""}${c.author ? ` by ${c.author}` : ""} → clip: ${c.site}:${c.id}`;

// The smallest MP4 that still fills the 1080x1920 frame without being blown up. A landscape
// clip is cropped to its middle third, so it needs 1920 px of height (4K) to stay sharp.
function pickFile(c) {
  const fills = (f) => (f.width >= f.height ? f.height >= 1920 : f.width >= 1080 && f.height >= 1920);
  const area = (f) => (f.width || 0) * (f.height || 0);
  const good = c.files.filter((f) => fills(f) && (f.fps || 30) <= 61).sort((a, b) => area(a) - area(b));
  return good[0] || [...c.files].sort((a, b) => area(b) - area(a))[0];
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

// Downloads one stock clip into the workspace cache (once). `c` is a candidate or { site, id }.
export async function stockFetch(c, { ws = process.cwd() } = {}) {
  const site = SITES[c.site];
  if (!site) throw new Error(`unknown stock site "${c.site}" (have: ${STOCK_SITES.join(", ")})`);
  const key = stockKey(c.site);
  if (!key) throw new Error(`${site.name} needs ${site.env[0]} in .env`);
  const dir = ensureDir(path.join(stateDir(ws), "stock"));
  const dest = path.join(dir, `${c.site}-${c.id}.mp4`);
  const metaFile = path.join(dir, `${c.site}-${c.id}.json`);
  if (fs.existsSync(dest)) return { file: dest, ...readJSON(metaFile, {}) };
  if (!c.files?.length) c = await site.byId(c.id, key);
  try {
    await download(pickFile(c).link, dest);
  } catch {
    // Search results can be a day old and signed links expire: ask for fresh ones.
    c = await site.byId(c.id, key);
    if (!c.files.length) throw new Error(`${site.name} video ${c.id} has no downloadable MP4`);
    await download(pickFile(c).link, dest);
  }
  await site.downloaded?.(c.id, key);
  const meta = { site: c.site, id: c.id, title: c.title, author: c.author, page: c.page };
  writeJSON(metaFile, meta);
  return { file: dest, ...meta };
}

// Turns every B-roll request in a batch into a file. Request forms:
//   "new floors"                       at that phrase, search for it
//   { at, q: "floor tiles" }           library first, then the stock sites in `stock:` order
//   { at, src: "broll/x.mp4" }         that file (a name that isn't a file is searched for)
//   { at, clip: "pexels:3571264" }     that exact stock clip
//   { at, pexels: "floor tiles" }      one site only (also pixabay:); a number = clip id
// A clip isn't reused within a batch while another match exists. A request nothing can fill
// gets `missing` ({ q, reason }): the video renders without it rather than failing. Returns
// the stock clips used, for credits.
export async function resolveBroll(videos, { ws = process.cwd(), onLog } = {}) {
  const used = new Set();
  const credits = new Map();
  const libCache = new Map();
  for (const v of videos) {
    const dirs = [].concat(v.library || []).map((d) => path.resolve(v.base, String(d).replace(/^~(?=$|[\\/])/, os.homedir())));
    const key = dirs.join("|");
    if (!libCache.has(key)) libCache.set(key, scanLibrary(dirs));
    const lib = libCache.get(key);
    v.broll = (v.broll || []).map((b) => (typeof b === "string" ? { at: b, q: b } : { ...b }));
    for (const b of v.broll) {
      const only = STOCK_SITES.find((s) => b[s] !== undefined);
      const q = only ? b[only] : b.q ?? b.find ?? b.src ?? (typeof b.at === "string" ? b.at : null);
      if (b.src && fs.existsSync(path.resolve(v.base, b.src))) {
        b.src = path.resolve(v.base, b.src);
        used.add(b.src);
        continue;
      }
      if (b.clip && (!SITES[String(b.clip).split(":")[0]] || !String(b.clip).split(":")[1])) {
        b.error = `clip: write it as site:id, e.g. pexels:3571264 (sites: ${STOCK_SITES.join(", ")})`;
        continue;
      }
      if (q == null && !b.clip) {
        b.error = "needs src, q, clip or a stock site";
        continue;
      }
      if (!only && !b.clip) {
        const hit = searchLibrary(lib, String(q), used);
        if (hit) {
          b.src = hit.file;
          used.add(hit.file);
          b.found = `library:${hit.name}`;
          continue;
        }
      }
      try {
        let pick;
        if (b.clip) {
          const [site, id] = String(b.clip).split(":");
          pick = { site, id };
        } else if (only && /^\d+$/.test(String(q))) pick = { site: only, id: String(q) };
        else {
          const sites = stockSites(only ? [only] : v.stock ?? DEFAULT_STOCK);
          if (!sites.length) throw new Error(NO_KEY);
          const errors = [];
          for (const s of sites) {
            try {
              // Only clips that have most of the asked-for words: a loose match is worse than none.
              const list = (await searchSite(s, String(q), { ws, minDur: Number(b.dur) || 2 })).filter((c) => c.rel >= 0.6);
              pick = list.find((c) => !used.has(`${c.site}:${c.id}`)) || list[0];
            } catch (e) {
              errors.push(e.message);
            }
            if (pick) break;
          }
          if (!pick) throw new Error(errors.length ? errors.join("; ") : `no good match on ${sites.join(", ")}; try other words`);
        }
        const got = await stockFetch(pick, { ws });
        used.add(`${got.site}:${got.id}`);
        b.src = got.file;
        b.found = `${got.site}:${got.id}`;
        b.credit = got;
        credits.set(b.found, got);
        onLog?.(`b-roll "${b.clip || q}" → ${SITES[got.site].name} ${got.id}${got.author ? ` by ${got.author}` : ""}`);
      } catch (e) {
        b.missing = { q: String(q ?? b.at ?? b.clip), reason: e.message };
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
