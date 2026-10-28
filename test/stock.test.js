import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBroll, stockSearch } from "../src/broll.js";

// A fake of the Pixabay and Pexels APIs, shaped like their documented responses. It logs
// requests so caching and the chosen file size can be checked.
function fakeApis() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(`${req.method} ${u.pathname}${u.search}`);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (v) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (u.pathname.startsWith("/file/")) return res.end("not really an mp4");
    if (u.pathname === "/pixabay/api/videos/") {
      if (u.searchParams.get("key") !== "xk") return res.writeHead(400).end("[ERROR 400] Invalid or missing API key");
      if (u.searchParams.get("q") && u.searchParams.get("video_type") !== "film") return res.writeHead(400).end("searches must ask for filmed footage");
      const v = (id, tags) => ({
        id,
        pageURL: `https://pixabay.com/videos/${tags.split(", ").join("-")}-${id}/`,
        tags,
        duration: 9,
        user: "Sam",
        videos: {
          large: { url: `${base}/file/${id}-4k.mp4`, width: 3840, height: 2160, thumbnail: `${base}/file/t.jpg` },
          medium: { url: `${base}/file/${id}-hd.mp4`, width: 1920, height: 1080, thumbnail: `${base}/file/t.jpg` },
          small: { url: `${base}/file/${id}-sd.mp4`, width: 1280, height: 720, thumbnail: `${base}/file/t.jpg` },
        },
      });
      return json({ total: 4, totalHits: 4, hits: [v(11, "ai generated, office, desk"), v(12, "woman, nymph, cherry blossoms"), v(22, "office, desk, paperwork"), v(33, "office, desk, laptop")] });
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

test("B-roll from Pixabay: AI and fantasy clips skipped, 4K for landscape, no reuse, cached", async () => {
  const { srv, hits, base } = await fakeApis();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reel-stock-"));
  const env = { ...process.env };
  try {
    process.env.REEL_PIXABAY_API = `${base}/pixabay`;
    process.env.REEL_PEXELS_API = `${base}/pexels`;
    delete process.env.PEXELS_API_KEY;
    delete process.env.PIXABAY_API_KEY;

    // No key: the video still renders, with a note that says how to get one.
    const none = [{ base: ws, library: [], broll: ["office desk"] }];
    await resolveBroll(none, { ws });
    assert.equal(none[0].broll[0].error, undefined);
    assert.match(none[0].broll[0].missing.reason, /PIXABAY_API_KEY/);

    process.env.PIXABAY_API_KEY = "xk";
    const videos = [{ base: ws, library: [], broll: ["office desk", { at: "x", q: "office desk" }, { at: "y", clip: "pixabay:33" }] }];
    const credits = await resolveBroll(videos, { ws });
    const [a, b, c] = videos[0].broll;
    assert.deepEqual([a.missing, b.missing, c.missing, a.error], [undefined, undefined, undefined, undefined]);
    assert.equal(a.found, "pixabay:22"); // "ai generated" and "nymph" clips skipped
    assert.equal(b.found, "pixabay:33"); // not the same clip twice
    assert.equal(c.found, "pixabay:33");
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
  } finally {
    process.env = env;
    srv.close();
  }
});
