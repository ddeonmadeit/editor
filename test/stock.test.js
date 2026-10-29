import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBroll, stockKey, stockSearch } from "../src/broll.js";

const KEY = "123-abcdefabcdefabcdefabcd";
// A JPEG with nothing but an XMP packet, optionally saying it's AI-made.
const jpeg = (xmp = "") => {
  const payload = Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/">${xmp}</x:xmpmeta>`);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, payload, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
};

// Fakes of the Pixabay, Pexels, Wikipedia and Wikimedia Commons APIs, shaped like their
// documented responses. They log requests so caching and the chosen file sizes can be checked.
function fakeApis() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(`${req.method} ${decodeURIComponent(u.pathname)}${u.search}`);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (v) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    const q = u.searchParams.get("q") || u.searchParams.get("gsrsearch") || "";
    if (u.pathname.startsWith("/file/")) return res.end("not really an mp4");
    if (u.pathname.startsWith("/img/ai")) return res.end(jpeg('<rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>'));
    if (u.pathname.startsWith("/img/") || u.pathname.startsWith("/thumb/")) return res.end(jpeg());
    if (u.pathname.startsWith("/pixabay/")) {
      if (u.searchParams.get("key") !== KEY) return res.writeHead(400).end("[ERROR 400] Invalid or missing API key");
      const id = u.searchParams.get("id");
      if (u.pathname === "/pixabay/api/videos/") {
        if (q && u.searchParams.get("video_type") !== "film") return res.writeHead(400).end("searches must ask for filmed footage");
        const v = (id, tags, ai = false) => ({
          id,
          pageURL: `https://pixabay.com/videos/${tags.split(", ").join("-")}-${id}/`,
          tags,
          duration: 9,
          user: "Sam",
          isAiGenerated: ai,
          videos: {
            large: { url: `${base}/file/${id}-4k.mp4`, width: 3840, height: 2160, thumbnail: `${base}/file/t.jpg` },
            medium: { url: `${base}/file/${id}-hd.mp4`, width: 1920, height: 1080, thumbnail: `${base}/file/t.jpg` },
            small: { url: `${base}/file/${id}-sd.mp4`, width: 1280, height: 720, thumbnail: `${base}/file/t.jpg` },
          },
        });
        const all = [v(11, "ai generated, office, desk"), v(12, "woman, nymph, cherry blossoms"), v(44, "office, desk, computer", true), v(22, "office, desk, paperwork"), v(33, "office, desk, laptop")];
        return json({ total: all.length, totalHits: all.length, hits: id ? all.filter((h) => String(h.id) === id) : all });
      }
      if (u.pathname === "/pixabay/api/") {
        if (q && u.searchParams.get("image_type") !== "photo") return res.writeHead(400).end("searches must ask for photos");
        const p = (id, tags, ai = false) => ({ id, pageURL: `https://pixabay.com/photos/${id}/`, tags, imageWidth: 4000, imageHeight: 6000, largeImageURL: `${base}/img/px-${id}.jpg`, webformatURL: `${base}/img/px-${id}-640.jpg`, user: "Kim", isAiGenerated: ai });
        // Him only in passing (space art tagged with his name), and an AI portrait.
        const all = [p(501, "radio, satellites, astronaut, space, galaxy, elon musk"), p(502, "elon musk, portrait", true)];
        return json({ total: all.length, totalHits: all.length, hits: id ? all.filter((h) => String(h.id) === id) : /elon/i.test(q) ? all : [] });
      }
    }
    if (u.pathname === "/wikipedia/w/api.php") return json(/elon musk/i.test(q) ? { query: { pages: [{ pageid: 1, ns: 0, title: "Elon Musk", index: 1, pageimage: "Elon_Musk_2018.jpg" }] } } : { batchcomplete: true });
    if (u.pathname === "/commons/w/api.php") {
      const file = (title, { w = 1200, h = 1600, url = `${base}/img/${title.length}.jpg`, cats = "Elon Musk in 2022", mime = "image/jpeg" } = {}) => ({
        title: `File:${title}`,
        index: 0,
        imageinfo: [{ width: w, height: h, mime, url, thumburl: w > 1280 ? `${base}/thumb/wiki/1280px-${title.replace(/ /g, "_")}` : url, descriptionurl: `https://commons.wikimedia.org/wiki/File:${title.replace(/ /g, "_")}`, extmetadata: { ObjectName: { value: title.replace(/\.\w+$/, "") }, Categories: { value: cats }, Artist: { value: '<bdi><a href="https://example.org">Debbie Rowe</a></bdi>' }, LicenseShortName: { value: "CC BY-SA 3.0" } } }],
      });
      const files = {
        "Elon Musk 2018.jpg": file("Elon Musk 2018.jpg", { w: 3000, h: 4000, cats: "Elon Musk in 2018|Portrait photographs of businesspeople" }),
        "Elon Musk AI portrait.jpg": file("Elon Musk AI portrait.jpg", { cats: "AI-generated images|Elon Musk" }),
        "Elon Musk caricature.jpg": file("Elon Musk caricature.jpg", { cats: "Caricatures of Elon Musk" }),
        "Elon Musk at SpaceX.jpg": file("Elon Musk at SpaceX.jpg", { url: `${base}/img/ai.jpg`, cats: "Elon Musk in 2015" }),
        "Elon Musk 2022.jpg": file("Elon Musk 2022.jpg"),
        "Elon Musk logo.png": file("Elon Musk logo.png", { mime: "image/png" }),
        "Elon Musk small.jpg": file("Elon Musk small.jpg", { w: 400, h: 500 }),
      };
      const titles = u.searchParams.get("titles");
      if (titles) return json({ query: { pages: titles.split("|").map((t) => files[t.replace(/^File:/, "").replace(/_/g, " ")] || { title: t, missing: true }) } });
      if (u.searchParams.get("gsrnamespace") !== "6" || !/filemime:image\/jpeg/.test(q)) return res.writeHead(400).end("search files, JPEG only");
      return json(/elon musk/i.test(q) ? { query: { pages: Object.values(files).map((f, i) => ({ ...f, index: i + 1 })) } } : { batchcomplete: true });
    }
    if (u.pathname === "/pexels/videos/search") {
      if (req.headers.authorization !== "pk") return res.writeHead(401).end();
      const portrait = u.searchParams.get("orientation") === "portrait";
      return json({ videos: portrait ? [{ id: 7, width: 1080, height: 1920, duration: 8, url: "https://www.pexels.com/video/man-at-desk-7/", image: `${base}/file/t.jpg`, user: { name: "Ana" }, video_files: [{ file_type: "video/mp4", width: 1080, height: 1920, fps: 30, link: `${base}/file/7.mp4` }] }] : [] });
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

async function withFakes(fn) {
  const { srv, hits, base } = await fakeApis();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reel-stock-"));
  const env = { ...process.env };
  try {
    for (const s of ["pixabay", "pexels", "wikipedia", "commons"]) process.env[`REEL_${s.toUpperCase()}_API`] = `${base}/${s}`;
    delete process.env.PEXELS_API_KEY;
    process.env.PIXABAY_API_KEY = KEY;
    await fn({ ws, hits });
  } finally {
    process.env = env;
    srv.close();
  }
}

test("B-roll from Pixabay: AI and fantasy clips skipped, 4K for landscape, no reuse, cached", () =>
  withFakes(async ({ ws, hits }) => {
    // Pixabay turned off: the video still renders, with a note that says why.
    process.env.PIXABAY_API_KEY = "off";
    const none = [{ base: ws, library: [], broll: ["office desk"] }];
    await resolveBroll(none, { ws });
    assert.equal(none[0].broll[0].error, undefined);
    assert.match(none[0].broll[0].missing.reason, /PIXABAY_API_KEY=off/);

    // A placeholder pasted from instructions isn't taken for a key: the built-in one is used.
    process.env.PIXABAY_API_KEY = "<the team's Pixabay key>";
    assert.equal(stockKey("pixabay"), "58277522-9aa5dbf0e1f51622b68eb7ac1");

    process.env.PIXABAY_API_KEY = KEY;
    const videos = [{ base: ws, library: [], broll: ["office desk", { at: "x", q: "office desk" }, { at: "y", clip: "pixabay:33" }, { at: "z", clip: "pixabay:44" }] }];
    const credits = await resolveBroll(videos, { ws });
    const [a, b, c, d] = videos[0].broll;
    assert.deepEqual([a.missing, b.missing, c.missing, a.error], [undefined, undefined, undefined, undefined]);
    assert.equal(a.found, "pixabay:22"); // tagged "ai generated", flagged AI, and "nymph" clips skipped
    assert.equal(b.found, "pixabay:33"); // not the same clip twice
    assert.equal(c.found, "pixabay:33");
    assert.match(d.missing.reason, /AI-generated/); // even when asked for by id
    assert.ok(hits.includes("GET /file/22-4k.mp4")); // landscape → 4K, so the vertical crop stays sharp
    assert.equal(credits.length, 2);
    assert.equal(hits.filter((h) => h.startsWith("GET /pixabay/api/videos/?") && h.includes("q=office")).length, 1); // cached

    // An existing Pexels key is tried first.
    process.env.PEXELS_API_KEY = "pk";
    const both = [{ base: ws, library: [], broll: ["man at desk"] }];
    await resolveBroll(both, { ws });
    assert.equal(both[0].broll[0].found, "pexels:7");
    const list = await stockSearch("office desk", { ws, sites: ["pixabay"] });
    assert.deepEqual(list.map((x) => x.id), ["22", "33"]);
  }));

test("photos: Wikipedia's lead photo first, then Commons; AI, art and AI-marked files never used", () =>
  withFakes(async ({ ws, hits }) => {
    const v = [{ base: ws, library: [], stock: ["pixabay"], broll: [{ at: "a", photo: "Elon Musk" }, { at: "b", photo: "Elon Musk" }, { at: "c", q: "elon musk" }, { at: "d", clip: "pixabay-photo:502" }, { at: "e", clip: "wikimedia:File:Elon_Musk_2022.jpg" }] }];
    const credits = await resolveBroll(v, { ws });
    const [p1, p2, p3, p4, p5] = v[0].broll;
    assert.equal(p1.found, "wikimedia:Elon Musk 2018.jpg"); // the article's lead photo
    assert.ok(hits.includes("GET /thumb/wiki/1920px-Elon_Musk_2018.jpg")); // a standard thumbnail width, ~1920 px tall
    assert.match(p1.src, /\.jpg$/);
    // Next one: the AI-categorised file, the caricature, the PNG and the tiny one are passed
    // over; the file whose own metadata says AI is downloaded, rejected and remembered.
    assert.equal(p2.found, "wikimedia:Elon Musk 2022.jpg");
    assert.ok(hits.includes("GET /img/ai.jpg"));
    assert.match(fs.readFileSync(path.join(ws, ".reel", "stock", "rejected.json"), "utf8"), /Elon Musk at SpaceX\.jpg.*algorithmicmedia/);
    assert.ok(!fs.readdirSync(path.join(ws, ".reel", "stock")).some((f) => f.endsWith(".part")));
    // q with no matching video: the Pixabay photos (him only in passing, an AI portrait) aren't
    // good enough, so a Commons photo is used.
    assert.match(p3.found, /^wikimedia:/);
    assert.match(p4.missing.reason, /AI-generated/);
    assert.equal(p5.found, "wikimedia:Elon Musk 2022.jpg");
    const cr = credits.find((c) => c.id === "Elon Musk 2018.jpg");
    assert.deepEqual([cr.author, cr.license, cr.kind], ["Debbie Rowe", "CC BY-SA 3.0", "photo"]);
    assert.equal(hits.filter((h) => h === "GET /img/ai.jpg").length, 1); // a rejected file isn't fetched again
  }));
