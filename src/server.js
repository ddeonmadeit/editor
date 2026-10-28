import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { listLooks } from "./batch.js";
import { manualHint, scanLibrary, searchLibrary, stockSearch, stockSites } from "./broll.js";
import { HOOK_PRESETS, renderHooks } from "./hooks.js";
import { Jobs } from "./jobs.js";
import { ffmpegCaps } from "./media.js";
import { serveFile } from "./static.js";
import { CAPTION_STYLES } from "./styles.js";
import { buildLines, formatTranscript } from "./transcript.js";
import { listIngested, loadTranscript, wordsOf } from "./transcribe.js";
import { HOOKGEN_DIR, IMAGE_EXT, ROOT, VIDEO_EXT, ensureDir, expandVideos, readJSON, round } from "./util.js";

// The "B-roll needed" lists (*broll-needed.json) up to three folders deep.
function findNeeded(ws) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /broll-needed\.json$/.test(e.name)) out.push(p);
    }
  };
  walk(ws, 0);
  return out;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// A route's non-JSON answer (text, PNG).
const RAW = Symbol("raw");
const raw = (body, type) => ({ [RAW]: true, body, type });

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

// The website: a dashboard for people, and a small HTTP API for agents that can't run the
// CLI. Binds to localhost unless told otherwise; set REEL_TOKEN before exposing it.
export async function serve({ ws = process.cwd(), port = 4317, host = "127.0.0.1" } = {}) {
  const jobs = new Jobs(ws);
  const token = process.env.REEL_TOKEN;
  const inWs = (p) => {
    const abs = path.resolve(ws, p);
    if (abs !== ws && !abs.startsWith(ws + path.sep)) throw new Error(`path outside the workspace: ${p}`);
    return abs;
  };
  // A batch given inline (YAML text) or as a file in the workspace.
  const batchArg = (b) => (typeof b === "string" && !b.includes("\n") ? inWs(b) : b);

  const routes = {
    "GET /api/status": async () => {
      const caps = await ffmpegCaps().catch(() => null);
      return { name: pkg.name, version: pkg.version, workspace: ws, ffmpeg: caps, looks: listLooks(), captionStyles: Object.keys(CAPTION_STYLES), hookPresets: HOOK_PRESETS, stock: stockSites(), hookgen: fs.existsSync(path.join(HOOKGEN_DIR, "index.html")) };
    },
    "GET /api/videos": async () =>
      listIngested(ws).map((v) => {
        const t = v.ready ? loadTranscript(ws, v.id) : null;
        return { id: v.id, src: path.relative(ws, v.src), ready: v.ready, duration: t && round(t.duration, 1), lines: t && buildLines(wordsOf(t)).length };
      }),
    "GET /api/transcript": async (q) => {
      const t = loadTranscript(ws, q.get("id"));
      if (!t) throw new Error(`not ingested: ${q.get("id")}`);
      const words = wordsOf(t);
      const lines = buildLines(words);
      if (q.get("format") === "json") return { id: t.id, duration: t.duration, lines: lines.map(({ id, s, e, text, retakeOf }) => ({ id, s: round(s, 2), e: round(e, 2), text, retakeOf })) };
      return raw(formatTranscript(t, lines), "text/plain; charset=utf-8");
    },
    "GET /api/files": async () => {
      // Videos and batch files in the workspace, for the dashboard pickers.
      const out = { batches: [], videos: [] };
      const walk = (d, depth) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const p = path.join(d, e.name);
          if (e.isDirectory() && depth < 3) walk(p, depth + 1);
          else if (/\.ya?ml$/i.test(e.name)) out.batches.push(path.relative(ws, p));
          else if (VIDEO_EXT.test(e.name)) out.videos.push(path.relative(ws, p));
        }
      };
      walk(ws, 0);
      return out;
    },
    "GET /api/batch": async (q) => raw(fs.readFileSync(inWs(q.get("file")), "utf8"), "text/yaml; charset=utf-8"),
    "PUT /api/batch": async (q, body) => {
      fs.writeFileSync(inWs(q.get("file")), body);
      return { ok: true };
    },
    "POST /api/plan": async (q, body) => ({ text: await jobs.plan(batchArg(JSON.parse(body).batch)) }),
    "POST /api/render": async (q, body) => {
      const b = JSON.parse(body);
      return jobs.summary(jobs.render(batchArg(b.batch), { only: b.only, quality: b.quality, jobs: b.jobs }));
    },
    "POST /api/ingest": async (q, body) => {
      const b = JSON.parse(body);
      return jobs.summary(jobs.ingest(expandVideos(b.files.map(inWs), ws), { model: b.model, lang: b.lang, prompt: b.prompt }));
    },
    "POST /api/new": async (q, body) => {
      const b = JSON.parse(body);
      return jobs.summary(jobs.newBatch(inWs(b.batch), b.files.map(inWs), { use: b.use, force: b.force }));
    },
    "GET /api/jobs": async () => jobs.list.map((j) => jobs.summary(j)),
    "GET /api/job": async (q) => {
      const j = jobs.get(q.get("id"));
      if (!j) throw new Error("no such job");
      if (q.get("wait")) await j.done;
      return jobs.summary(j);
    },
    "POST /api/hook": async (q, body) => {
      const b = JSON.parse(body);
      const [file] = await renderHooks([{ text: b.text, preset: b.preset, style: b.style }], { ws });
      return raw(fs.readFileSync(file), "image/png");
    },
    "GET /api/broll": async (q) => {
      const query = q.get("q");
      const hit = searchLibrary(scanLibrary([inWs(q.get("lib") || "broll")]), query);
      let stock = [], error;
      if (!stockSites().length) error = manualHint(query, "broll");
      else
        try {
          stock = (await stockSearch(query, { ws, perSite: 8 })).map(({ files, text, ...c }) => c);
        } catch (e) {
          error = e.message;
        }
      return { library: hit && { file: path.relative(ws, hit.file), score: hit.score }, stock, error };
    },
    // Every "B-roll needed" list in the workspace, with which clips are already in place.
    "GET /api/broll-needed": async () => {
      const lists = [];
      for (const f of findNeeded(ws)) {
        const j = readJSON(f, null);
        if (!j?.needs) continue;
        lists.push({ list: path.relative(ws, f), batch: j.batch, rerun: j.rerun, needs: j.needs.map((n, i) => ({ i, video: n.video, at: n.at, q: n.q, search: n.search, file: n.file, done: fs.existsSync(n.file) || fs.existsSync(n.file.replace(/\.mp4$/, ".mov")) })) });
      }
      return lists;
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) {
        if (token && req.headers.authorization !== `Bearer ${token}` && url.searchParams.get("token") !== token) return send(res, 401, { error: "unauthorized" });
        if (p === "/api/events") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          const onUpdate = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);
          jobs.on("update", onUpdate);
          const ping = setInterval(() => res.write(": ping\n\n"), 20000);
          req.on("close", () => {
            jobs.off("update", onUpdate);
            clearInterval(ping);
          });
          return;
        }
        if (p === "/api/broll-needed/upload" && req.method === "POST") {
          // Saves a downloaded clip under the name its "needed" entry asks for. Only paths
          // listed in a needed list inside the workspace can be written.
          const listFile = inWs(url.searchParams.get("list") || "");
          if (!/broll-needed\.json$/.test(listFile)) return send(res, 400, { error: "not a broll-needed list" });
          const need = readJSON(listFile, { needs: [] }).needs[Number(url.searchParams.get("i"))];
          if (!need) return send(res, 404, { error: "no such entry" });
          const ext = (path.extname(url.searchParams.get("name") || "") || ".mp4").toLowerCase();
          if (!VIDEO_EXT.test(ext) && !IMAGE_EXT.test(ext)) return send(res, 400, { error: `not a video or image: ${ext}` });
          const dest = need.file.replace(/\.[^.]+$/, ext);
          ensureDir(path.dirname(dest));
          await new Promise((resolve, reject) => req.pipe(fs.createWriteStream(dest)).on("finish", resolve).on("error", reject));
          return send(res, 200, { path: dest });
        }
        if (p === "/api/upload" && req.method === "POST") {
          // Raw body upload into uploads/ (for agents and browsers without file access).
          const name = path.basename(url.searchParams.get("name") || `upload-${Date.now()}.mp4`).replace(/[^\w.-]+/g, "-");
          const dest = path.join(ensureDir(inWs(url.searchParams.get("dir") || "uploads")), name);
          await new Promise((resolve, reject) => req.pipe(fs.createWriteStream(dest)).on("finish", resolve).on("error", reject));
          return send(res, 200, { path: path.relative(ws, dest) });
        }
        const fn = routes[`${req.method} ${p}`];
        if (!fn) return send(res, 404, { error: `no route ${req.method} ${p}` });
        const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : "";
        const out = await fn(url.searchParams, body);
        if (out && out[RAW]) return send(res, 200, out.body, out.type);
        return send(res, 200, out);
      }
      if (p === "/llms.txt") return serveFile(req, res, ROOT, "llms.txt");
      if (p === "/docs/spec") return serveFile(req, res, path.join(ROOT, "docs"), "SPEC.md");
      if (p.startsWith("/hook-gen/")) return serveFile(req, res, HOOKGEN_DIR, p.slice("/hook-gen/".length) || "index.html");
      if (p.startsWith("/files/")) {
        if (token && url.searchParams.get("token") !== token && req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
        return serveFile(req, res, ws, p.slice("/files/".length));
      }
      return serveFile(req, res, path.join(ROOT, "web"), p === "/" ? "index.html" : p.slice(1));
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  process.stdout.write(`reel dashboard: http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (workspace ${ws})\n`);
  return server;
}
