import fs from "node:fs";
import path from "node:path";
import { describeLibrary, pexelsSearch, scanLibrary, searchLibrary } from "./broll.js";
import { Jobs } from "./jobs.js";
import { check, formatCheck, sheet } from "./qa.js";
import { buildLines, formatTranscript } from "./transcript.js";
import { listIngested, loadTranscript, wordsOf } from "./transcribe.js";
import { ROOT, VIDEO_EXT } from "./util.js";

// MCP server over stdio (newline-delimited JSON-RPC), for Claude Desktop and other MCP
// clients. Same workflow as the CLI; every tool answers in a few compact lines.

const TOOLS = [
  {
    name: "reel_new",
    description: "Transcribe videos and write a batch file with every transcript inline (numbered lines, likely retakes pre-filled in drop). Then edit the file: set hook per video, adjust drop, add broll. Next: reel_render.",
    inputSchema: { type: "object", properties: { batch: { type: "string", description: "batch file to create, e.g. edit.yaml" }, videos: { type: "array", items: { type: "string" }, description: "files, folders or globs, e.g. raw/*.mov" }, use: { type: "string", description: "look: white | orange | green | getknown" }, force: { type: "boolean" } }, required: ["batch", "videos"] },
  },
  {
    name: "reel_transcript",
    description: "Numbered transcript lines (`n start text`, R>n marks a likely retake) for ingested videos.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "video ids or file paths; empty = all" } } },
  },
  {
    name: "reel_plan",
    description: "Check a batch without rendering: per video the length after cuts, hook, captions, resolved B-roll timings, and any errors with suggestions.",
    inputSchema: { type: "object", properties: { batch: { type: "string", description: "batch file path, or YAML text" } }, required: ["batch"] },
  },
  {
    name: "reel_render",
    description: "Render every video in a batch (in parallel) to 1080x1920 60fps MP4. Waits and returns one line per video.",
    inputSchema: { type: "object", properties: { batch: { type: "string" }, only: { type: "array", items: { type: "string" } }, quality: { type: "string", enum: ["draft", "high", "max"] } }, required: ["batch"] },
  },
  {
    name: "reel_check",
    description: "Verify rendered files: 1080x1920, 60 fps, audio present, loudness near -14 LUFS.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "files or folders (default out/)" } } },
  },
  {
    name: "reel_sheet",
    description: "One contact-sheet image of evenly spaced frames from a video, with timestamps. The cheap way to look at an edit.",
    inputSchema: { type: "object", properties: { video: { type: "string" }, at: { type: "array", items: { type: "number" }, description: "specific seconds instead of evenly spaced" } }, required: ["video"] },
  },
  {
    name: "reel_broll",
    description: "Find B-roll for a phrase: your library folder first, then Pexels (real footage, vertical first). Returns ids to use as broll: [{ at, pexels: id }].",
    inputSchema: { type: "object", properties: { q: { type: "string" }, library: { type: "string", description: "library folder (default broll)" } }, required: ["q"] },
  },
  {
    name: "reel_library",
    description: "List the B-roll library folder: name, length, size, tags.",
    inputSchema: { type: "object", properties: { dir: { type: "string" } } },
  },
  {
    name: "reel_spec",
    description: "The batch file reference (every key, with examples).",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function startMcp({ ws = process.cwd() } = {}) {
  const jobs = new Jobs(ws);
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const abs = (p) => path.resolve(ws, p);

  const call = {
    async reel_new({ batch, videos, use, force }) {
      const j = jobs.newBatch(abs(batch), videos, { use, force });
      await j.done;
      if (j.status !== "done") throw new Error(j.error);
      return text(`${j.text}\n\n${fs.readFileSync(abs(batch), "utf8")}`);
    },
    async reel_transcript({ ids } = {}) {
      const list = ids?.length ? ids : listIngested(ws).filter((x) => x.ready).map((x) => x.id);
      return text(
        list
          .map((id) => {
            const t = loadTranscript(ws, id);
            return t ? formatTranscript(t, buildLines(wordsOf(t))) : `# ${id}: not ingested`;
          })
          .join("\n"),
      );
    },
    async reel_plan({ batch }) {
      return text(await jobs.plan(batch.includes("\n") ? batch : abs(batch)));
    },
    async reel_render({ batch, only, quality }, progress) {
      const j = jobs.render(batch.includes("\n") ? batch : abs(batch), { only, quality });
      const onUpdate = (s) => s.id === j.id && progress?.(s);
      jobs.on("update", onUpdate);
      await j.done;
      jobs.off("update", onUpdate);
      if (j.error) throw new Error(j.error);
      return text(j.text);
    },
    async reel_check({ paths } = {}) {
      const files = (paths?.length ? paths : ["out"]).map(abs).flatMap((p) => (fs.existsSync(p) && fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => VIDEO_EXT.test(f)).map((f) => path.join(p, f)) : [p]));
      const lines = [];
      for (const f of files) lines.push(formatCheck(await check(f), ws));
      return text(lines.join("\n") || "nothing to check");
    },
    async reel_sheet({ video, at }) {
      const file = await sheet(abs(video), { ws, at });
      return { content: [{ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" }, { type: "text", text: path.relative(ws, file) }] };
    },
    async reel_broll({ q, library }) {
      const hit = searchLibrary(scanLibrary([abs(library || "broll")]), q);
      const lines = [hit ? `library: ${path.relative(ws, hit.file)} (${Math.round(hit.score * 100)}%)` : "library: no match"];
      try {
        for (const v of (await pexelsSearch(q)).slice(0, 8)) lines.push(`pexels ${v.id} ${v.width}x${v.height} ${v.duration}s ${v.url}`);
      } catch (e) {
        lines.push(`pexels: ${e.message}`);
      }
      return text(lines.join("\n"));
    },
    async reel_library({ dir } = {}) {
      return text((await describeLibrary([abs(dir || "broll")])).text || "empty library");
    },
    async reel_spec() {
      return text(fs.readFileSync(path.join(ROOT, "docs", "SPEC.md"), "utf8"));
    },
  };

  const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const handle = async (msg) => {
    const { id, method, params } = msg;
    if (method === "initialize") return write({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "reel", version: "0.1.0" }, instructions: "Batch video editor. Flow: reel_new (transcribe + batch file) → edit the YAML (hook, drop, broll) → reel_plan → reel_render → reel_check. reel_spec has every option." } });
    if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const fn = call[params?.name];
      if (!fn) return write({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      const token = params?._meta?.progressToken;
      const progress = token === undefined ? null : (s) => {
        const vals = Object.values(s.progress || {});
        const pct = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        write({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: Math.round(pct), total: 100, message: `${s.results.length} done` } });
      };
      try {
        return write({ jsonrpc: "2.0", id, result: await fn(params.arguments || {}, progress) });
      } catch (e) {
        return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${e.message}` }], isError: true } });
      }
    }
    if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  };

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      handle(msg);
    }
  });
  await new Promise((resolve) => process.stdin.on("end", resolve));
}

