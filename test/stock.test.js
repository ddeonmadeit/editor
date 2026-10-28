import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { neededName, resolveBroll, stockSearch, writeNeeded } from "../src/broll.js";

// A fake of the Pexels and Pixabay APIs, shaped like their documented responses. It counts
// requests so caching can be checked.
function fakeApis() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(`${req.method} ${u.pathname}${u.search}`);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (v) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (u.pathname.startsWith("/file/")) return res.end("not really an mp4");
    if (u.pathname === "/pexels/videos/search") {
      if (req.headers.authorization !== "pk") return res.writeHead(401).end();
      const v = (id, slug, w, h) => ({ id, width: w, height: h, duration: 7, url: `https://www.pexels.com/video/${slug}-${id}/`, image: `${base}/file/t.jpg`, user: { name: "Ana" }, video_files: [{ file_type: "video/mp4", width: w, height: h, fps: 30, link: `${base}/file/${id}.mp4` }] });
      const portrait = u.searchParams.get("orientation") === "portrait";
      return json({ videos: portrait ? [v(1, "ai-generated-office", 1080, 1920), v(2, "man-at-desk", 1080, 1920), v(3, "woman-typing", 1080, 1920)] : [] });
    }
    if (u.pathname === "/pixabay/api/videos/") {
      const v = (id, tags) => ({ id, pageURL: `https://pixabay.com/videos/x-${id}/`, tags, duration: 6, user: "Sam", videos: { medium: { url: `${base}/file/${id}.mp4`, width: 1920, height: 1080, thumbnail: `${base}/file/t.jpg` } } });
      return json({ hits: [v(11, "office, ai generated, futuristic"), v(22, "office, desk, paperwork")] });
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("B-roll without a key becomes a needed entry with a Pexels search and a file name", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reel-need-"));
  const env = { ...process.env };
  try {
    delete process.env.PEXELS_API_KEY;
    process.env.PIXABAY_API_KEY = "x"; // set, but Pixabay is opt-in
    const videos = [{ base: ws, library: ["broll"], broll: ["new floors", { at: "the bank", q: "Bank building, exterior" }] }];
    await resolveBroll(videos, { ws });
    const [a, b] = videos[0].broll;
    assert.equal(a.error, undefined);
    assert.equal(a.missing.search, "https://www.pexels.com/search/videos/new%20floors/?orientation=portrait");
    assert.equal(a.missing.file, path.join(ws, "broll", "new-floors.mp4"));
    assert.equal(neededName(b.missing.q), "bank-building-exterior.mp4");

    const md = writeNeeded({ dir: ws, batchName: "edit.yaml", needs: [{ video: "IMG_1", at: "new floors", ...a.missing }], rerun: "reel render edit.yaml --only IMG_1" });
    assert.equal(path.basename(md), "edit-broll-needed.md");
    const text = fs.readFileSync(md, "utf8");
    assert.match(text, /IMG_1\*\* at "new floors"/);
    assert.match(text, /reel render edit\.yaml --only IMG_1/);
    assert.ok(fs.existsSync(path.join(ws, "edit-broll-needed.json")));

    // Once someone saves the clip under that name, the library finds it.
    fs.mkdirSync(path.join(ws, "broll"));
    fs.writeFileSync(a.missing.file, "");
    const again = [{ base: ws, library: ["broll"], broll: ["new floors"] }];
    await resolveBroll(again, { ws });
    assert.equal(again[0].broll[0].found, "library:new-floors.mp4");

    // An empty list clears the files.
    writeNeeded({ dir: ws, batchName: "edit.yaml", needs: [], rerun: "" });
    assert.ok(!fs.existsSync(md));
  } finally {
    process.env = env;
  }
});

test("stock sites: Pexels with a key, Pixabay only when asked, AI clips skipped, searches cached", async () => {
  const { srv, hits, base } = await fakeApis();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reel-stock-"));
  const env = { ...process.env };
  try {
    process.env.REEL_PEXELS_API = `${base}/pexels`;
    process.env.REEL_PIXABAY_API = `${base}/pixabay`;
    process.env.PEXELS_API_KEY = "pk";
    process.env.PIXABAY_API_KEY = "xk";
    const videos = [
      { base: ws, library: [], broll: ["office desk", { at: "x", q: "office desk" }, { at: "y", pixabay: "office" }, { at: "z", clip: "pexels:3" }] },
      { base: ws, library: [], stock: ["pixabay"], broll: ["office"] },
    ];
    const credits = await resolveBroll(videos, { ws });
    const [a, b, c, d] = videos[0].broll;
    assert.deepEqual([a.error, b.error, c.error, d.error, a.missing, b.missing], [undefined, undefined, undefined, undefined, undefined, undefined]);
    assert.equal(a.found, "pexels:2"); // the AI-slug clip skipped
    assert.equal(b.found, "pexels:3"); // not the same clip twice
    assert.equal(c.found, "pixabay:22"); // tagged "ai generated" skipped
    assert.equal(d.found, "pexels:3");
    assert.equal(videos[1].broll[0].found, "pixabay:22");
    for (const x of [a, b, c, d]) assert.ok(fs.existsSync(x.src));
    assert.equal(credits.length, 3);
    assert.equal(hits.filter((h) => h.startsWith("GET /pexels/videos/search") && h.includes("portrait")).length, 1); // cached
    const list = await stockSearch("office desk", { ws });
    assert.ok(list.every((x) => x.site === "pexels" && x.id !== "1"));
  } finally {
    process.env = env;
    srv.close();
  }
});
