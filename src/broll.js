import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { aiMarker } from "./aicheck.js";
import { probe } from "./media.js";
import { norm } from "./transcript.js";
import { IMAGE_EXT, ROOT, VIDEO_EXT, ensureDir, readJSON, sha1, stateDir, writeJSON } from "./util.js";

// B-roll comes from the team's own folders first ("library"), then from Pixabay (free API
// key), or Pexels first if an old Pexels key is around, then photos: Wikipedia / Wikimedia
// Commons for named people, places and brands, and Pixabay. Agents ask with a few words
// (`q: "air conditioner"`, `photo: "Elon Musk"`), never by browsing, so finding B-roll costs
// almost no tokens. Nothing AI-made is ever used: see synthetic(), aiTagged() and aicheck.js.

// Words that say an upload is AI-made. Never allowed, whatever was asked for. Pixabay tags
// its AI uploads "ai generated"; Commons files them under "AI-generated images".
const AI_WORDS = /\b(ai|ai generated|aigenerated|ai art|aiart|generated|generative|genai|midjourney|stable diffusion|stablediffusion|sdxl|dall e|dalle|dalle2|dalle3|novelai|nightcafe|leonardo ai|text to image|txt2img|img2img|deepfake)\b/;
// Words that say it's graphics or fantasy, not filmed (AI clips that aren't tagged as AI are
// mostly these). Allowed only when the request itself asks for the word ("3d printer").
const NOT_FILMED = /\b(3d|render|rendering|renders|cgi|animation|animated|motion graphics|digital art|abstract|illustration|cartoon|anime|hologram|metaverse|fantasy|surreal|futuristic|sci fi|scifi|cyberpunk|magical|fairy|nymph|mermaid|elf|dragon)\b/g;
// Commons also holds art, scans and objects that show a subject; B-roll wants photographs of it.
const NOT_PHOTO = /\b(paintings?|drawings?|sketch(?:es)?|caricatures?|illustrations?|engravings?|lithographs?|etchings?|cartoons?|comics?|artworks?|sculptures?|statues?|busts|wax|waxworks?|tussauds|murals?|graffiti|cosplay(?:ers?)?|impersonators?|lookalikes?|figurines?|dolls?|toys?|logos?|maps?|diagrams?|charts?|stamps?|coins?|banknotes?|signatures?|posters?|album covers?|book covers?|magazine covers?)\b/g;

const clean = (...texts) => ` ${texts.flat(2).filter(Boolean).join(" ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const tokensOf = (s) =>
  String(s)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map(norm)
    .filter((w) => w && w.length > 1 && !/^\d+$/.test(w) && !["img", "mov", "mp4", "dsc", "clip", "the", "and", "with", "of", "a", "in", "on", "at", "to", "for", "new", "old", "my", "our", "your", "some", "very"].includes(w))
    .map(stem);

// True when a stock item's text says it's AI-made, or graphics / not a photo that wasn't asked for.
function synthetic(texts, q = "", photo = false) {
  const t = clean(texts);
  if (AI_WORDS.test(t)) return true;
  const asked = tokensOf(q);
  const unasked = (re) => [...t.matchAll(re)].some((m) => !tokensOf(m[1]).every((w) => asked.some((a) => a === w || sameRoot(a, w))));
  return unasked(NOT_FILMED) || (photo && unasked(NOT_PHOTO));
}
const aiTagged = (c) => !!c.ai || AI_WORDS.test(clean(c.title, c.page, c.tags));

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
export function searchLibrary(items, q, used = new Set(), skip = new Set()) {
  const qt = [...new Set(tokensOf(q))];
  if (!qt.length) return null;
  let best = null;
  for (const it of items) {
    if (skip.has(it.file)) continue;
    const hit = qt.filter((w) => it.words.has(w) || [...it.words].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length;
    const score = hit / qt.length - (used.has(it.file) ? 0.3 : 0);
    if (hit && (!best || score > best.score)) best = { ...it, score };
  }
  return best && best.score >= 0.5 ? best : null;
}

// ---------- stock sites ----------

// Where requests look after the library, in order; sites without a key are skipped.
export const DEFAULT_STOCK = ["pexels", "pixabay"]; // videos (a batch's stock: list replaces this)
export const PHOTO_SITES = ["wikimedia", "pixabay-photo"]; // photo: "Elon Musk" (people, places, brands)
const PHOTO_FALLBACK = ["pixabay-photo", "wikimedia"]; // q, when no video matches
const DAY = 24 * 3600 * 1000;
const api = (site, fallback) => process.env[`REEL_${site.toUpperCase()}_API`] || fallback;
const enc = encodeURIComponent;
const split = (tags) => String(tags || "").split(/\s*,\s*/).filter(Boolean);
const PKG = readJSON(path.join(ROOT, "package.json"), {});
// Wikimedia asks for a User-Agent that names the tool and where to reach its authors.
export const UA = `reel-editor/${PKG.version || "0"} (https://github.com/ddeonmadeit/editor) node/${process.versions.node}`;
export const fetchMedia = (url) => fetch(url, { headers: { "User-Agent": UA } });

async function getJSON(url, headers, name, retries = 0) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    if (r.status === 429 && attempt < retries) {
      // Wait as long as the site says (Wikimedia asks for this), or a few seconds.
      await new Promise((ok) => setTimeout(ok, Math.min(30, Number(r.headers.get("retry-after")) || 5 * (attempt + 1)) * 1000));
      continue;
    }
    if (r.status === 429) throw new Error(`${name} rate limit hit; try again in a minute, or use library clips / src:`);
    if (r.status === 401 || r.status === 403) throw new Error(`${name} refused the request (HTTP ${r.status})${headers.Authorization || /[?&]key=/.test(url) ? "; check the API key" : ""}`);
    if (!r.ok) throw new Error(`${name} HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120).trim()}`);
    return r.json();
  }
}

// Wikimedia only renders thumbnails at standard widths: take the smallest of them that makes
// the photo about 1920 px tall, or the original when that isn't bigger anyway.
const THUMB_WIDTHS = [960, 1280, 1920, 3840];
const THUMB = /\/\d+px-([^/]+)$/;
const noQuery = (u) => String(u || "").replace(/\?.*$/, "");
function commonsFile(ii) {
  const thumb = noQuery(ii.thumburl);
  const w = THUMB_WIDTHS.find((x) => x >= Math.max(1200, Math.ceil((1920 * ii.width) / ii.height))) || 3840;
  if (w >= ii.width || !THUMB.test(thumb)) return { link: noQuery(ii.url), width: ii.width, height: ii.height };
  return { link: thumb.replace(THUMB, `/${w}px-$1`), width: w, height: Math.round((ii.height * w) / ii.width) };
}
const stripTags = (s) =>
  String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|quot|#0?39|lt|gt|nbsp);/g, (_, e) => ({ amp: "&", quot: '"', "#39": "'", "#039": "'", lt: "<", gt: ">", nbsp: " " })[e])
    .replace(/\s+/g, " ")
    .trim();
const commonsApi = () => `${api("commons", "https://commons.wikimedia.org")}/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1280&iiextmetadatafilter=ObjectName|Categories|Artist|LicenseShortName`;

// Every site returns candidates shaped alike: { site, kind, id, width, height, duration,
// title, tags, author, page, thumb, files: [{ link, width, height }] }. AI, graphics and
// fantasy items are dropped here.
const SITES = {
  pexels: {
    name: "Pexels",
    label: "Pexels",
    kind: "video",
    env: ["PEXELS_API_KEY", "PEXELS_KEY"],
    get: (url, key) => getJSON(url, { Authorization: key }, "Pexels"),
    map: (v) => ({ site: "pexels", kind: "video", id: String(v.id), width: v.width, height: v.height, duration: v.duration, title: "", author: v.user?.name, page: v.url, thumb: v.image, files: (v.video_files || []).filter((f) => /mp4/.test(f.file_type || "mp4")).map((f) => ({ link: f.link, width: f.width, height: f.height, fps: f.fps })) }),
    async search(q, key) {
      const base = `${api("pexels", "https://api.pexels.com")}/videos/search?query=${enc(q)}&size=medium&per_page=20`;
      let vids = (await this.get(`${base}&orientation=portrait`, key)).videos || [];
      if (vids.length < 3) vids = vids.concat((await this.get(`${base}&orientation=landscape`, key)).videos || []);
      return vids.filter((v) => !synthetic(v.url, q)).map(this.map);
    },
    async byId(id, key) {
      return this.map(await this.get(`${api("pexels", "https://api.pexels.com")}/videos/videos/${id}`, key));
    },
  },
  pixabay: {
    name: "Pixabay",
    label: "Pixabay",
    kind: "video",
    env: ["PIXABAY_API_KEY", "PIXABAY_KEY"],
    // The team's key, built in so B-roll works with no setup. PIXABAY_API_KEY overrides it;
    // PIXABAY_API_KEY=off turns Pixabay off.
    builtin: "58277522-9aa5dbf0e1f51622b68eb7ac1",
    keyPattern: /^\d+-[0-9a-f]{20,}$/i,
    get: (url) => getJSON(url, {}, "Pixabay"),
    map: (v) => {
      const sizes = Object.values(v.videos || {}).filter((f) => f && f.url);
      const ref = [...sizes].sort((a, b) => b.width * b.height - a.width * a.height)[0] || {};
      return { site: "pixabay", kind: "video", id: String(v.id), width: ref.width, height: ref.height, duration: v.duration, title: v.tags, tags: split(v.tags), author: v.user, page: v.pageURL, thumb: ref.thumbnail, ai: !!v.isAiGenerated, files: sizes.map((f) => ({ link: f.url, width: f.width, height: f.height })) };
    },
    // video_type=film leaves out animations; Pixabay flags AI uploads (isAiGenerated).
    async search(q, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/videos/?key=${enc(key)}&q=${enc(q.slice(0, 100))}&video_type=film&safesearch=true&per_page=50`);
      return (j.hits || []).filter((v) => !v.isAiGenerated).map(this.map).filter((c) => !synthetic([c.title, c.page], q));
    },
    async byId(id, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/videos/?key=${enc(key)}&id=${enc(id)}`);
      if (!j.hits?.length) throw new Error(`Pixabay video ${id} not found`);
      return this.map(j.hits[0]);
    },
  },
  "pixabay-photo": {
    name: "Pixabay",
    label: "Pixabay photos",
    kind: "photo",
    keyFrom: "pixabay",
    get: (url) => getJSON(url, {}, "Pixabay"),
    // largeImageURL is the biggest size the API gives: 1280 px on the long side.
    map: (v) => {
      const s = Math.min(1, 1280 / Math.max(v.imageWidth, v.imageHeight));
      const width = Math.round(v.imageWidth * s), height = Math.round(v.imageHeight * s);
      return { site: "pixabay-photo", kind: "photo", id: String(v.id), width, height, title: v.tags, tags: split(v.tags), author: v.user, page: v.pageURL, thumb: v.webformatURL || v.previewURL, ai: !!v.isAiGenerated, files: [{ link: v.largeImageURL, width, height }] };
    },
    async search(q, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/?key=${enc(key)}&q=${enc(q.slice(0, 100))}&image_type=photo&safesearch=true&per_page=50`);
      return (j.hits || []).filter((v) => !v.isAiGenerated && !v.isLowQuality).map(this.map).filter((c) => !synthetic([c.title, c.page], q));
    },
    async byId(id, key) {
      const j = await this.get(`${api("pixabay", "https://pixabay.com")}/api/?key=${enc(key)}&id=${enc(id)}`);
      if (!j.hits?.length) throw new Error(`Pixabay photo ${id} not found`);
      return this.map(j.hits[0]);
    },
  },
  wikimedia: {
    name: "Wikimedia Commons",
    label: "Wikimedia Commons",
    kind: "photo",
    get: (url) => getJSON(url, {}, "Wikimedia", 2),
    // A Commons file as a candidate (JPEG photos only); `article` = the Wikipedia article it leads.
    map(f, article) {
      const ii = f?.imageinfo?.[0];
      if (!ii || ii.mime !== "image/jpeg" || !ii.width) return null;
      const m = ii.extmetadata || {};
      const val = (k) => stripTags(m[k]?.value || "");
      const id = f.title.replace(/^File:/, "");
      const name = id.replace(/\.[^.]+$/, "");
      const file = commonsFile(ii);
      const thumb = noQuery(ii.thumburl);
      return { site: "wikimedia", kind: "photo", id, width: file.width, height: file.height, title: val("ObjectName") || name, tags: [...(article ? [article] : []), name, ...val("Categories").split("|").filter(Boolean)], author: val("Artist"), license: val("LicenseShortName"), page: noQuery(ii.descriptionurl), thumb: THUMB.test(thumb) ? thumb.replace(THUMB, "/330px-$1") : noQuery(ii.url), lead: !!article, files: [file] };
    },
    // The lead photos of the best-matching Wikipedia articles first (a person's portrait, the
    // building itself), then Commons files whose title or categories match.
    async search(q) {
      const out = [];
      const wp = `${api("wikipedia", "https://en.wikipedia.org")}/w/api.php?action=query&format=json&formatversion=2`;
      const pages = (await this.get(`${wp}&generator=search&gsrsearch=${enc(q)}&gsrlimit=3&prop=pageimages&piprop=name&pilicense=free&redirects=1`)).query?.pages || [];
      const leads = pages.filter((p) => p.pageimage).sort((a, b) => a.index - b.index);
      if (leads.length) {
        const files = (await this.get(`${commonsApi()}&titles=${enc(leads.map((p) => `File:${p.pageimage}`).join("|"))}`)).query?.pages || [];
        const byName = new Map(files.map((f) => [f.title.replace(/^File:/, "").replace(/ /g, "_"), f]));
        for (const p of leads) out.push(this.map(byName.get(p.pageimage.replace(/ /g, "_")), p.title));
      }
      const found = (await this.get(`${commonsApi()}&generator=search&gsrnamespace=6&gsrsearch=${enc(`${q} filemime:image/jpeg`)}&gsrlimit=30`)).query?.pages || [];
      for (const f of found.sort((a, b) => a.index - b.index)) out.push(this.map(f));
      const seen = new Set();
      return out.filter((c) => c && !seen.has(c.id) && seen.add(c.id) && c.height >= 720 && !synthetic(c.tags, q, true));
    },
    async byId(id) {
      const name = String(id).replace(/^File:/i, "");
      const c = this.map((await this.get(`${commonsApi()}&titles=${enc(`File:${name}`)}`)).query?.pages?.[0]);
      if (!c) throw new Error(`Wikimedia file "${name}" not found, or not a JPEG photo`);
      return c;
    },
  },
};
export const STOCK_SITES = Object.keys(SITES);
export const stockName = (site) => SITES[site]?.name || site;

// A site's key: from the environment, else the built-in one ("free" for sites that need
// none). A value that can't be a key (e.g. a "<placeholder>" copied from instructions) is
// ignored; "off" turns the site off.
export function stockKey(site) {
  const s = SITES[site];
  if (!s) return "";
  if (s.keyFrom) return stockKey(s.keyFrom);
  if (!s.env) return "free";
  for (const name of s.env) {
    const v = (process.env[name] || "").trim();
    if (v.toLowerCase() === "off") return "";
    if (v && (!s.keyPattern || s.keyPattern.test(v))) return v;
  }
  return s.builtin || "";
}
export const stockSites = (order = DEFAULT_STOCK) => [].concat(order).filter((s) => SITES[s] && stockKey(s));
export const NO_KEY = "no stock video site to search (Pixabay is turned off with PIXABAY_API_KEY=off, or the batch's stock: list only names sites without a key)";

// Items that turned out to be AI-made (by their file's metadata), never offered again.
const rejectedFile = (ws) => path.join(stateDir(ws), "stock", "rejected.json");
function reject(ws, key, why) {
  const all = readJSON(rejectedFile(ws), {});
  all[key] = why;
  writeJSON(rejectedFile(ws), all);
}

// Searches one site (results cached on disk for a day, which Pixabay requires and which
// saves requests) and ranks the results.
async function searchSite(site, q, { ws, minDur = 2 }) {
  const file = path.join(stateDir(ws), "stock", "search", `${site}-${sha1("v2", q.toLowerCase()).slice(0, 16)}.json`);
  const cached = readJSON(file);
  let list;
  if (cached && Date.now() - cached.t < DAY) list = cached.list;
  else {
    list = await SITES[site].search(q, stockKey(site));
    writeJSON(file, { t: Date.now(), list });
  }
  const rejected = readJSON(rejectedFile(ws), {});
  // Stock search is loose (Pixabay ranks by popularity), so rank by how many of the asked-for
  // words the item's tags actually have; size, orientation and length only break ties.
  const want = [...new Set(tokensOf(q))];
  const hits = (w, words) => words.some((x) => x === w || sameRoot(w, x));
  const tagsOf = (c) => (c.tags?.length ? c.tags : String(c.title || c.page || "").split(/,|\/|-/));
  const rel = (c) => {
    const have = tokensOf([...tagsOf(c), c.page].join(" "));
    return want.length ? want.filter((w) => hits(w, have)).length / want.length : 0;
  };
  // Tags come most-relevant first: an item whose first tags match beats one where the words
  // are incidental (a "construction worker" request shouldn't get ants at work).
  const tagFocus = (c) => {
    const tags = tagsOf(c).map((t) => tokensOf(t)).filter((t) => t.length);
    const sum = want.reduce((s, w) => {
      const i = tags.findIndex((t) => hits(w, t));
      return s + (i < 0 ? 0 : 1 / (1 + i));
    }, 0);
    return want.length ? Math.round((sum / want.length) * 100) / 100 : 0;
  };
  const vertical = (c) => c.height > c.width;
  const sharp = (c) => (c.kind === "photo" ? (c.height >= 1500) + (c.height >= 1100) : 0);
  // Commons files photos of a person under "<name> in <year>": those show the subject.
  const named = `${q.trim().toLowerCase().replace(/\s+/g, " ")} in `;
  const depicts = (c) => c.site === "wikimedia" && c.tags.some((t) => t.toLowerCase().startsWith(named));
  const ranked = list
    .filter((c) => !rejected[`${c.site}:${c.id}`])
    .map((c) => ({ ...c, rel: rel(c), focus: tagFocus(c) }))
    .sort((a, b) => b.rel - a.rel || !!b.lead - !!a.lead || depicts(b) - depicts(a) || b.focus - a.focus || sharp(b) - sharp(a) || vertical(b) - vertical(a) || (b.duration >= minDur) - (a.duration >= minDur));
  // Items that share no word with the request are only a last resort.
  return ranked.some((c) => c.rel > 0) ? ranked.filter((c) => c.rel > 0) : ranked;
}

// Good enough to use without anyone looking: most of the asked-for words, and for Pixabay
// photos among the first tags (its loose photo tags otherwise bring in unrelated pictures).
const acceptable = (c) => c.rel >= 0.6 && (c.site !== "pixabay-photo" || c.focus >= 0.25);

// Candidates for a query from every site with a key (or the given ones), in order. `good`
// marks the ones a render would take.
export async function stockSearch(q, { ws = process.cwd(), sites = DEFAULT_STOCK, perSite = 8 } = {}) {
  const use = stockSites(sites);
  if (!use.length) throw new Error(NO_KEY);
  const out = [], errors = [];
  for (const s of use) {
    try {
      out.push(...(await searchSite(s, q, { ws })).slice(0, perSite).map((c) => ({ ...c, good: acceptable(c) })));
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!out.length && errors.length) throw new Error(errors.join("; "));
  return out;
}

export const formatStock = (c) => `${c.site} ${c.width}x${c.height} ${c.kind === "photo" ? "photo" : `${Math.round(c.duration * 10) / 10}s`}${c.title && !String(c.id).startsWith(c.title) ? ` "${String(c.title).slice(0, 50)}"` : ""}${c.author ? ` by ${String(c.author).slice(0, 40)}` : ""} → clip: "${c.site}:${c.id}"`;

// The smallest MP4 that still fills the 1080x1920 frame without being blown up. A landscape
// clip is cropped to its middle third, so it needs 1920 px of height (4K) to stay sharp.
// Photos come with one file.
function pickFile(c) {
  const fills = (f) => (f.width >= f.height ? f.height >= 1920 : f.width >= 1080 && f.height >= 1920);
  const area = (f) => (f.width || 0) * (f.height || 0);
  const good = c.files.filter((f) => fills(f) && (f.fps || 30) <= 61).sort((a, b) => area(a) - area(b));
  return good[0] || [...c.files].sort((a, b) => area(b) - area(a))[0];
}

async function download(url, dest) {
  const r = await fetchMedia(url);
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

// Downloads one stock item into the workspace cache (once) and checks the file's own
// metadata for AI marks. `c` is a candidate or { site, id }.
export async function stockFetch(c, { ws = process.cwd() } = {}) {
  const site = SITES[c.site];
  if (!site) throw new Error(`unknown stock site "${c.site}" (have: ${STOCK_SITES.join(", ")})`);
  const key = stockKey(c.site);
  if (!key) throw new Error(`${site.label} has no key (${(SITES[site.keyFrom] || site).env[0]} is unset or off)`);
  const tag = `${c.site}:${c.id}`;
  const base = path.join(ensureDir(path.join(stateDir(ws), "stock")), `${c.site}-${/^[\w.-]{1,60}$/.test(c.id) ? c.id : sha1(c.id).slice(0, 16)}`);
  const dest = `${base}.${site.kind === "photo" ? "jpg" : "mp4"}`;
  if (!fs.existsSync(dest)) {
    if (!c.files?.length) c = await site.byId(c.id, key);
    if (aiTagged(c)) throw new Error(`${tag} is AI-generated; reel never uses AI media`);
    try {
      await download(pickFile(c).link, dest);
    } catch {
      // Search results can be a day old and signed links expire: ask for fresh ones.
      c = await site.byId(c.id, key);
      if (!c.files.length) throw new Error(`${site.label} ${c.id} has no downloadable file`);
      await download(pickFile(c).link, dest);
    }
    writeJSON(`${base}.json`, { site: c.site, id: c.id, kind: site.kind, title: c.title, author: c.author, page: c.page, license: c.license });
  }
  const mark = aiMarker(dest);
  if (mark) {
    fs.rmSync(dest, { force: true });
    reject(ws, tag, `metadata: ${mark}`);
    throw new Error(`${tag} is AI-generated (its metadata says "${mark}"); skipped`);
  }
  return { file: dest, ...readJSON(`${base}.json`, { site: c.site, id: c.id }) };
}

// The best stock item for a query, trying sites in order: items that have most of the
// words, unused ones first, a few per site (one that fails to download or turns out to be
// AI-made is skipped).
async function findStock(q, { ws, used, minDur, order }) {
  const errors = [], looked = [];
  const videos = order.filter((s) => SITES[s]?.kind === "video");
  if (videos.length && !stockSites(videos).length) errors.push(NO_KEY);
  for (const s of stockSites(order)) {
    let list;
    try {
      list = (await searchSite(s, q, { ws, minDur })).filter(acceptable);
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    looked.push(SITES[s].label);
    const fresh = (c) => !used.has(`${c.site}:${c.id}`);
    for (const c of [...list.filter(fresh), ...list.filter((c) => !fresh(c))].slice(0, 3)) {
      try {
        return await stockFetch(c, { ws });
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  throw new Error([...(looked.length ? [`no good match on ${looked.join(", ")}; try other words`] : []), ...errors].join("; ") || "nothing to search");
}

const splitClip = (s) => {
  const i = String(s).indexOf(":");
  return i < 0 ? [String(s), ""] : [String(s).slice(0, i), String(s).slice(i + 1).trim()];
};

// Turns every B-roll request in a batch into a file. Request forms:
//   "new floors"                       at that phrase, search for it
//   { at, q: "floor tiles" }           library, then stock videos (`stock:` order), then photos
//   { at, photo: "Elon Musk" }         library, then photos: Wikipedia / Commons, then Pixabay
//   { at, src: "broll/x.mp4" }         that file (a name that isn't a file is searched for)
//   { at, clip: "pixabay:124947" }     that exact stock item ("wikimedia:File name.jpg" too)
//   { at, pixabay: "floor tiles" }     one site only (any site key); a number = item id
// An item isn't reused within a batch while another match exists. A request nothing can fill
// gets `missing` ({ q, reason }): the video renders without it rather than failing. Returns
// the stock items used, for credits.
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
      const photo = b.photo !== undefined && b.photo !== false;
      const q = only ? b[only] : (typeof b.photo === "string" ? b.photo : null) ?? b.q ?? b.find ?? b.src ?? (typeof b.at === "string" ? b.at : null);
      if (b.src && fs.existsSync(path.resolve(v.base, b.src))) {
        b.src = path.resolve(v.base, b.src);
        used.add(b.src);
        continue;
      }
      let [clipSite, clipId] = b.clip ? splitClip(b.clip) : [];
      if (clipSite === "wikimedia") clipId = clipId.replace(/^File:/i, "").replace(/_/g, " ");
      if (b.clip && (!SITES[clipSite] || !clipId)) {
        b.error = `clip: write it as site:id, e.g. pixabay:124947 or "wikimedia:File name.jpg" (sites: ${STOCK_SITES.join(", ")})`;
        continue;
      }
      if (q == null && !b.clip) {
        b.error = "needs src, q, photo, clip or a stock site";
        continue;
      }
      if (!only && !b.clip) {
        // The team's own files first; one whose metadata says it's AI-made is passed over.
        const skip = new Set();
        let hit;
        while ((hit = searchLibrary(lib, String(q), used, skip))) {
          const mark = aiMarker(hit.file);
          if (!mark) break;
          skip.add(hit.file);
          b.note = `skipped library file ${hit.name}: its metadata says it's AI-made ("${mark}")`;
        }
        if (hit) {
          b.src = hit.file;
          used.add(hit.file);
          b.found = `library:${hit.name}`;
          continue;
        }
      }
      try {
        let got;
        if (b.clip) got = await stockFetch({ site: clipSite, id: clipId }, { ws });
        else if (only && /^\d+$/.test(String(q))) got = await stockFetch({ site: only, id: String(q) }, { ws });
        else got = await findStock(String(q), { ws, used, minDur: Number(b.dur) || 2, order: only ? [only] : photo ? PHOTO_SITES : [...[].concat(v.stock ?? DEFAULT_STOCK), ...PHOTO_FALLBACK] });
        used.add(`${got.site}:${got.id}`);
        b.src = got.file;
        b.found = `${got.site}:${got.id}`;
        b.credit = got;
        credits.set(b.found, got);
        onLog?.(`b-roll "${b.clip || q}" → ${SITES[got.site].label} ${got.id}${got.author ? ` by ${got.author}` : ""}`);
      } catch (e) {
        b.missing = { q: String(q ?? b.at ?? b.clip), reason: e.message };
      }
    }
  }
  return [...credits.values()];
}

// What `reel broll` shows: the library match, then the stock items a render would take, best
// first (videos, then photos when no video matches; photos for photo: requests).
export async function brollReport(q, { ws = process.cwd(), dirs = [], photo = false, perSite = 6 } = {}) {
  const library = searchLibrary(scanLibrary(dirs), q);
  const lines = [library ? `library: ${path.relative(ws, library.file)} (match ${Math.round(library.score * 100)}%)` : "library: no match"];
  const list = [];
  const show = async (sites, what) => {
    try {
      const got = (await stockSearch(q, { ws, sites, perSite })).filter((c) => c.good);
      list.push(...got);
      lines.push(...(got.length ? got.map(formatStock) : [`${what}: no good match`]));
    } catch (e) {
      lines.push(`${what}: ${e.message}`);
    }
  };
  if (photo) await show(PHOTO_SITES, "photos");
  else {
    await show(DEFAULT_STOCK, "videos");
    if (!list.length) await show(PHOTO_FALLBACK, "photos (used when no video matches)");
  }
  lines.push(list.length ? `use: broll: [{ at: "phrase", clip: "${list[0].site}:${list[0].id}" }]` : "nothing good found: try other words");
  return { library, list, lines };
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
