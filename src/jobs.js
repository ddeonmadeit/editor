import { EventEmitter } from "node:events";
import path from "node:path";
import { formatPlan, planBatch, renderBatch } from "./batch.js";
import { newBatch } from "./scaffold.js";
import { ingest } from "./transcribe.js";

// Long-running work (transcribing, rendering) for the website and MCP server: one job at a
// time in arrival order, each rendering its videos in parallel. Progress goes out as events.
export class Jobs extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.list = [];
    this.queue = Promise.resolve();
    this.n = 0;
  }

  get(id) {
    return this.list.find((j) => j.id === id);
  }

  summary(j) {
    return { id: j.id, kind: j.kind, label: j.label, status: j.status, created: j.created, progress: j.progress, results: j.results, log: j.log.slice(-30), error: j.error, text: j.text };
  }

  add(kind, label, fn) {
    const job = { id: String(++this.n), kind, label, status: "queued", created: Date.now(), progress: {}, results: [], log: [], text: "" };
    this.list.unshift(job);
    this.list.length = Math.min(this.list.length, 50);
    const emit = () => this.emit("update", this.summary(job));
    const log = (s) => {
      job.log.push(s);
      emit();
    };
    job.done = (this.queue = this.queue.then(async () => {
      job.status = "running";
      emit();
      try {
        await fn(job, { log, emit });
        job.status = job.results.some((r) => !r.ok) ? "failed" : "done";
      } catch (e) {
        job.status = "failed";
        job.error = e.message;
      }
      emit();
    }));
    emit();
    return job;
  }

  render(batch, { only, quality, jobs } = {}) {
    const label = typeof batch === "string" && !batch.includes("\n") ? path.basename(batch) : "batch";
    return this.add("render", label, async (job, { log, emit }) => {
      const r = await renderBatch(batch, {
        ws: this.ws,
        only,
        quality,
        jobs,
        onLog: log,
        onProgress: (id, pct) => {
          job.progress[id] = pct;
          emit();
        },
        onDone: (res) => {
          job.results.push({ ...res, out: res.out && path.relative(this.ws, res.out) });
          emit();
        },
      });
      job.text = [
        ...job.results.map((x) => (x.ok ? `✓ ${x.id} → ${x.out} ${Math.round(x.duration * 10) / 10}s${x.warnings?.length ? `  note: ${x.warnings.join("; ")}` : ""}` : `✗ ${x.id}: ${x.errors.join("; ")}`)),
        ...r.warnings.map((w) => `note: ${w}`),
        `${job.results.filter((x) => x.ok).length}/${job.results.length} rendered in ${Math.round(r.secs)}s`,
        ...(r.needed ? [`B-roll needed: ${r.needed.count} clip(s), no match in the library → ${r.needed.file}`] : []),
      ].join("\n");
    });
  }

  ingest(files, opts = {}) {
    return this.add("ingest", `${files.length} video(s)`, async (job, { log }) => {
      const res = await ingest(files, { ws: this.ws, ...opts, onLog: log });
      job.text = res.map((r) => `${r.id} ${Math.round(r.transcript.duration * 10) / 10}s${r.cached ? " (cached)" : ""}`).join("\n");
    });
  }

  newBatch(file, inputs, opts = {}) {
    return this.add("new", path.basename(file), async (job, { log }) => {
      const r = await newBatch(file, inputs, { ws: this.ws, ...opts, onLog: log });
      job.text = `wrote ${path.relative(this.ws, r.file)} (${r.videos} videos)`;
    });
  }

  async plan(batch) {
    const { plans, warnings, needed } = await planBatch(batch, { ws: this.ws });
    return [...warnings.map((w) => `note: ${w}`), ...plans.map((p) => formatPlan(p, this.ws)), ...(needed ? [`B-roll needed: ${needed.count} clip(s), no match in the library → ${needed.file}`] : [])].join("\n");
  }
}
