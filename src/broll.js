import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { probe } from "./media.js";
import { norm } from "./transcript.js";
import { IMAGE_EXT, VIDEO_EXT, ensureDir, readJSON, sha1, slug, stateDir, writeJSON } from "./util.js";

// B-roll comes from the team's own folders first ("library"). When nothing there fits, a
// stock site with an API key fills in (Pexels; Pixabay only if a batch opts in). Without a
// key, the clip is listed in a "B-roll needed" file with a Pexels search link and the file
// name to save it under; once someone drops it in the library, the next render uses it.
// Pexels' terms forbid automated downloading from its website, so reel never does that.
// Agents ask for a clip with a few words (`q: "air conditioner"`), never by browsing
// footage, so finding B-roll costs almost no tokens.

// Clips whose title, tags or page slug say they're synthetic or graphics, not filmed.
const NOT_REAL = /\b(ai|ai generated|generated|generative|midjourney|stable diffusion|sora|runway|3d|render|rendering|cgi|animation|animated|motion graphics|digital art|abstract|illustration|cartoon|hologram|metaverse)\b/;
const looksSynthetic = (...texts) => NOT_REAL.test(texts.flat().filter(Boolean).join(" ").toLowerCase().replace(/[/_-]+/g, " "));
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

// ---------- stock sites ----------

export const STOCK_SITES = ["pexels", "pixabay"];
// Sites tried when a batch doesn't say. Pixabay accepts AI uploads it can't filter, so a
// batch has to ask for it (`stock: [pexels, pixabay]`).
export const DEFAULT_STOCK = ["pexels"];
const DAY = 24 * 3600 * 1000;
const api = (site, fallback) => process.env[`REEL_${site.toUpperCase()}_API`] || fallback;

async function getJSON(url, headers, name) {
  const r = await fetch(url, { headers });
  if (r.status === 429) throw new Error(`${name} rate limit hit; try again later, or use library clips / src:`);
  if (r.status === 401 || r.status === 403) throw new Error(`${name} rejected the API key (HTTP ${r.status})`);
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
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
    get: (url) => getJSON(url, {}, "Pixabay"),
    map: (v) => {
      const sizes = Object.values(v.videos || {}).filter((f) => f && f.url);
      const ref = v.videos?.medium || sizes[0] || {};
      return { site: "pixabay", id: String(v.id), width: ref.width, height: ref.height, duration: v.duration, title: v.tags, author: v.user, page: v.pageURL, thumb: ref.thumbnail, text: [v.tags, v.pageURL], files: sizes.map((f) => ({ link: f.url, width: f.width, height: f.height })) };
    },
    // video_type=film leaves out animations. Pixabay accepts AI uploads and its API can't
    // filter them, so only the title/tag check stands between them and the edit.
    async search(q, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q.slice(0, 100))}&video_type=film&safesearch=true&per_page=20`);
      return (j.hits || []).map(this.map).filter((c) => !looksSynthetic(c.text));
    },
    async byId(id, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/videos/?key=${encodeURIComponent(key)}&id=${id}`);
      if (!j.hits?.length) throw new Error(`Pixabay video ${id} not found`);
      return this.map(j.hits[0]);
    },
  },
};

export const stockKey = (site) => SITES[site]?.env.map((e) => process.env[e]).find(Boolean) || "";
export const stockSites = (order = DEFAULT_STOCK) => [].concat(order).filter((s) => SITES[s] && stockKey(s));
const NO_KEY = "no stock site key is set (PEXELS_API_KEY; new Pexels keys are paused)";

// A Pexels search for a query, vertical clips first: where a person grabs a missing clip.
export const pexelsSearchUrl = (q) => `https://www.pexels.com/search/videos/${encodeURIComponent(String(q).trim())}/?orientation=portrait`;
// The file name a missing clip should be saved under so the library search finds it.
export const neededName = (q) => `${slug(String(q).toLowerCase()).replace(/[.]+/g, "-") || "clip"}.mp4`;

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
  const vertical = (c) => c.height > c.width;
  return [...list].sort((a, b) => vertical(b) - vertical(a) || (b.duration >= minDur) - (a.duration >= minDur));
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

// What to tell someone when no site with a key can supply a clip: where to look, what to save.
export const manualHint = (q, saveDir) => `no stock key: get it from ${pexelsSearchUrl(q)} and save as ${path.join(saveDir, neededName(q))}`;

export const formatStock = (c) => `${c.site} ${c.id} ${c.width}x${c.height} ${Math.round(c.duration * 10) / 10}s${c.title ? ` "${String(c.title).slice(0, 50)}"` : ""}${c.author ? ` by ${c.author}` : ""} → clip: ${c.site}:${c.id}`;

// The smallest MP4 that still fills 1080x1920 (or the biggest there is).
function pickFile(c) {
  const short = (f) => Math.min(f.width || 0, f.height || 0);
  const good = c.files.filter((f) => short(f) >= 1080 && (f.fps || 30) <= 61).sort((a, b) => a.width * a.height - b.width * b.height);
  return good[0] || [...c.files].sort((a, b) => b.width * b.height - a.width * a.height)[0];
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
// gets `missing` ({ q, search, file }) instead of failing the video. Returns the stock
// clips used, for credits.
export async function resolveBroll(videos, { ws = process.cwd(), onLog } = {}) {
  const used = new Set();
  const credits = new Map();
  const libCache = new Map();
  for (const v of videos) {
    const dirs = [].concat(v.library || []).map((d) => path.resolve(v.base, String(d).replace(/^~(?=$|[\\/])/, os.homedir())));
    const key = dirs.join("|");
    if (!libCache.has(key)) libCache.set(key, scanLibrary(dirs));
    const lib = libCache.get(key);
    const saveDir = dirs[0] || path.join(v.base, "broll");
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
              const list = await searchSite(s, String(q), { ws, minDur: Number(b.dur) || 2 });
              pick = list.find((c) => !used.has(`${c.site}:${c.id}`)) || list[0];
            } catch (e) {
              errors.push(e.message);
            }
            if (pick) break;
          }
          if (!pick) throw new Error(errors.length ? errors.join("; ") : `nothing on ${sites.join(", ")} for "${q}"`);
        }
        const got = await stockFetch(pick, { ws });
        used.add(`${got.site}:${got.id}`);
        b.src = got.file;
        b.found = `${got.site}:${got.id}`;
        b.credit = got;
        credits.set(b.found, got);
        onLog?.(`b-roll "${b.clip || q}" → ${SITES[got.site].name} ${got.id}${got.author ? ` by ${got.author}` : ""}`);
      } catch (e) {
        const term = String(q ?? b.at ?? b.clip);
        b.missing = { q: term, reason: e.message, search: pexelsSearchUrl(term), file: path.join(saveDir, neededName(term)) };
      }
    }
  }
  return [...credits.values()];
}

// Writes (or clears) the "B-roll needed" list for a batch: a Markdown file for people and
// a JSON twin the dashboard uses to drop downloaded clips straight into place.
export function writeNeeded({ dir, batchName, needs, rerun }) {
  const stem = batchName ? `${batchName.replace(/\.[^.]+$/, "")}-` : "";
  const md = path.join(dir, `${stem}broll-needed.md`);
  const json = path.join(dir, `${stem}broll-needed.json`);
  if (!needs.length) {
    for (const f of [md, json]) fs.rmSync(f, { force: true });
    return null;
  }
  const lines = [
    `# B-roll needed${batchName ? `: ${batchName}` : ""}`,
    "",
    "Nothing in the B-roll library matched these. Download each from Pexels (pick a vertical",
    "clip if there is one; nothing AI-made), save it with the file name shown, then re-render:",
    "",
    `    ${rerun}`,
    "",
    "Or open the reel dashboard (reel serve), B-roll tab, and drop each download on its row.",
    "",
  ];
  for (const n of needs) lines.push(`- [ ] **${n.video}** at "${n.at}": ${n.q}`, `  ${n.search}`, `  save as: \`${n.file}\``, "");
  fs.writeFileSync(md, lines.join("\n"));
  writeJSON(json, { batch: batchName || null, rerun, needs });
  return md;
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
