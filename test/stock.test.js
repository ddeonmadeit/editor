import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBroll, stockSearch } from "../src/broll.js";

// A fake of the three stock APIs, shaped like their documented responses. It counts
// requests so caching and Coverr's download report can be checked.
function fakeApis() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(`${req.method} ${u.pathname}`);
    const json = (v) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (u.pathname.startsWith("/file/")) return res.end("not really an mp4");
    if (u.pathname.startsWith("/coverr/")) {
      if (req.headers.authorization !== "Bearer ck") return res.writeHead(401).end();
      if (req.method === "PATCH") return res.writeHead(204).end();
      const v = (id, extra) => ({ id, title: `Clip ${id}`, is_vertical: false, max_width: 1920, max_height: 1080, duration: 8, thumbnail: `${base}/file/t.jpg`, urls: { mp4_download: `${base}/file/${id}.mp4` }, ...extra });
      if (u.pathname === "/coverr/videos/PINNED") return json(v("PINNED"));
      return json({ page: 0, pages: 1, total: 3, hits: [v("AIclip", { is_ai_generated: true, is_vertical: true }), v("land1"), v("vert1", { is_vertical: true, max_width: 1080, max_height: 1920 })] });
    }
    if (u.pathname === "/pixabay/api/videos/") {
      const v = (id, tags) => ({ id, pageURL: `https://pixabay.com/videos/x-${id}/`, tags, duration: 6, user: "Sam", videos: { medium: { url: `${base}/file/${id}.mp4`, width: 1920, height: 1080, thumbnail: `${base}/file/t.jpg` } } });
      return json({ total: 2, totalHits: 2, hits: [v(11, "office, ai generated, futuristic"), v(22, "office, desk, paperwork")] });
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("stock B-roll: Coverr then Pixabay, AI clips skipped, no reuse, cached searches", async () => {
  const { srv, hits, base } = await fakeApis();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reel-stock-"));
  const env = { ...process.env };
  try {
    process.env.REEL_COVERR_API = `${base}/coverr`;
    process.env.REEL_PIXABAY_API = `${base}/pixabay`;
    delete process.env.PEXELS_API_KEY;
    delete process.env.COVERR_API_KEY;
    delete process.env.PIXABAY_API_KEY;

    // No keys: a clear message that says how to get one.
    const none = [{ base: ws, library: [], broll: ["new floors"] }];
    await resolveBroll(none, { ws });
    assert.match(none[0].broll[0].error, /COVERR_API_KEY/);

    process.env.COVERR_API_KEY = "ck";
    process.env.PIXABAY_API_KEY = "pk";
    const videos = [
      { base: ws, library: [], broll: ["new floors", { at: "x", q: "new floors" }, { at: "y", pixabay: "office" }, { at: "z", clip: "coverr:PINNED" }] },
    ];
    const credits = await resolveBroll(videos, { ws });
    const [a, b, c, d] = videos[0].broll;
    assert.deepEqual([a.error, b.error, c.error, d.error], [undefined, undefined, undefined, undefined]);
    assert.equal(a.found, "coverr:vert1"); // vertical first, the AI clip skipped
    assert.equal(b.found, "coverr:land1"); // not the same clip twice
    assert.equal(c.found, "pixabay:22"); // tagged "ai generated" skipped
    assert.equal(d.found, "coverr:PINNED");
    for (const x of [a, b, c, d]) assert.ok(fs.existsSync(x.src));
    assert.equal(credits.length, 4);
    assert.equal(hits.filter((h) => h === "GET /coverr/videos").length, 1); // one search, cached
    assert.equal(hits.filter((h) => h.startsWith("PATCH /coverr/videos/")).length, 3); // downloads reported
    assert.ok(!hits.some((h) => h.includes("AIclip")));

    const list = await stockSearch("new floors", { ws });
    assert.ok(list.every((x) => x.id !== "AIclip" && x.id !== "11"));
  } finally {
    process.env = env;
    srv.close();
  }
});
