const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("token");
const withToken = (u) => (token ? `${u}${u.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : u);

async function api(path, opts = {}) {
  const r = await fetch(withToken(path), { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const type = r.headers.get("Content-Type") || "";
  const body = type.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body.error || body || `HTTP ${r.status}`);
  return body;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- tabs ----------
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  for (const x of $("tabs").querySelectorAll("button")) x.setAttribute("aria-selected", String(x === b));
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${b.dataset.tab}`;
  if (b.dataset.tab === "hooks" && $("hookgen").src === "about:blank") $("hookgen").src = "/hook-gen/";
  if (b.dataset.tab === "videos") loadVideos();
  if (b.dataset.tab === "broll") loadNeeded();
  try {
    localStorage.setItem("reel-tab", b.dataset.tab);
  } catch {}
});

// ---------- status ----------
async function loadStatus() {
  const s = await api("/api/status");
  const chip = (ok, label) => `<span class="chip ${ok ? "ok" : "bad"}">${esc(label)}</span>`;
  $("status").innerHTML = [
    chip(s.ffmpeg, s.ffmpeg ? `ffmpeg ${s.ffmpeg.version}` : "ffmpeg missing"),
    chip(s.hookgen, "hook-gen"),
    chip(true, s.stock.length ? `B-roll: library + ${s.stock.join(", ")}` : "B-roll: library + Pexels links"),
  ].join("");
  $("newLook").innerHTML = s.looks.map((l) => `<option ${l === "white" ? "selected" : ""}>${esc(l)}</option>`).join("");
  $("mcpCfg").textContent = JSON.stringify({ mcpServers: { reel: { command: "npx", args: ["reel", "mcp"], cwd: s.workspace } } }, null, 2);
}

// ---------- batch editor ----------
async function loadFiles(select) {
  const f = await api("/api/files");
  const pick = $("batchPick");
  const cur = select || pick.value;
  pick.innerHTML = f.batches.length ? f.batches.map((b) => `<option ${b === cur ? "selected" : ""}>${esc(b)}</option>`).join("") : "<option value=''>no batch files yet</option>";
  if (pick.value) await openBatch(pick.value);
}
async function openBatch(file) {
  $("batchText").value = await api(`/api/batch?file=${encodeURIComponent(file)}`);
}
$("batchPick").addEventListener("change", () => openBatch($("batchPick").value));
$("reloadFiles").addEventListener("click", () => loadFiles());

const currentBatch = () => $("batchPick").value || "edit.yaml";
async function save() {
  await api(`/api/batch?file=${encodeURIComponent(currentBatch())}`, { method: "PUT", body: $("batchText").value, headers: { "Content-Type": "text/yaml" } });
}
function showOut(text) {
  $("planOut").hidden = false;
  $("planOut").textContent = text;
}
$("save").addEventListener("click", async () => {
  await save();
  showOut(`saved ${currentBatch()}`);
});
$("plan").addEventListener("click", async () => {
  showOut("checking…");
  try {
    await save();
    showOut((await api("/api/plan", { method: "POST", body: JSON.stringify({ batch: currentBatch() }) })).text);
  } catch (e) {
    showOut(`error: ${e.message}`);
  }
});
for (const [id, quality] of [["render", undefined], ["renderDraft", "draft"]]) {
  $(id).addEventListener("click", async () => {
    try {
      await save();
      await api("/api/render", { method: "POST", body: JSON.stringify({ batch: currentBatch(), quality }) });
      $("planOut").hidden = true;
    } catch (e) {
      showOut(`error: ${e.message}`);
    }
  });
}
$("newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = $("newVideos").value.split(/\s+/).filter(Boolean);
  if (!files.length) return;
  try {
    const job = await api("/api/new", { method: "POST", body: JSON.stringify({ batch: $("newFile").value, files, use: $("newLook").value }) });
    const done = await api(`/api/job?id=${job.id}&wait=1`);
    if (done.status === "done") await loadFiles($("newFile").value);
    else showOut(`error: ${done.error}`);
  } catch (err) {
    showOut(`error: ${err.message}`);
  }
});

// ---------- jobs ----------
const jobs = new Map();
function renderJobs() {
  const list = [...jobs.values()].sort((a, b) => Number(b.id) - Number(a.id));
  if (!list.length) return;
  $("jobs").innerHTML = list
    .map((j) => {
      const bars = Object.entries(j.progress || {})
        .filter(([id]) => !j.results.some((r) => r.id === id))
        .map(([id, pct]) => `<div class="bar"><span>${esc(id)}</span><div class="track"><div class="fill" style="width:${pct}%"></div></div><span>${pct}%</span></div>`)
        .join("");
      const results = j.results
        .map((r) => (r.ok ? `<div class="result"><video src="${withToken(`/files/${encodeURI(r.out)}`)}" controls preload="metadata" playsinline></video>${esc(r.id)} · ${Math.round(r.duration * 10) / 10}s</div>` : `<div class="result err">✗ ${esc(r.id)}: ${esc(r.errors.join("; "))}</div>`))
        .join("");
      return `<article class="job"><header><span class="st ${j.status}">${j.status}</span><b>${esc(j.kind)}</b> ${esc(j.label)}<span class="grow"></span><small class="hint">${new Date(j.created).toLocaleTimeString()}</small></header>
        ${bars}${results ? `<div class="results">${results}</div>` : ""}
        ${j.error ? `<div class="result err">${esc(j.error)}</div>` : ""}
        ${j.log?.length && j.status !== "done" ? `<div class="log">${esc(j.log.slice(-6).join("\n"))}</div>` : ""}</article>`;
    })
    .join("");
}
function listen() {
  const ev = new EventSource(withToken("/api/events"));
  ev.onmessage = (m) => {
    const j = JSON.parse(m.data);
    jobs.set(j.id, j);
    renderJobs();
  };
  ev.onerror = () => {
    ev.close();
    setTimeout(listen, 3000);
  };
}

// ---------- videos ----------
async function loadVideos() {
  const vids = await api("/api/videos");
  $("videoList").innerHTML = vids.length ? vids.map((v) => `<li data-id="${esc(v.id)}"><b>${esc(v.id)}</b><span>${v.duration ?? "?"}s · ${v.lines ?? "?"} lines</span></li>`).join("") : `<p class="hint">Nothing transcribed yet.</p>`;
}
$("videoList").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  for (const x of $("videoList").children) x.classList.toggle("on", x === li);
  $("trTitle").textContent = li.dataset.id;
  $("trText").textContent = await api(`/api/transcript?id=${encodeURIComponent(li.dataset.id)}`);
});

// ---------- b-roll ----------
$("brollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("brollQ").value.trim();
  if (!q) return;
  $("brollOut").innerHTML = `<p class="hint">Searching…</p>`;
  const r = await api(`/api/broll?q=${encodeURIComponent(q)}`);
  const hint = r.error && r.error.match(/(https:\/\/www\.pexels\.com\S+)/);
  const lib = `<div class="clip lib">${r.library ? `Library match: <code>${esc(r.library.file)}</code> (${Math.round(r.library.score * 100)}%) — <code>{ at: "…", src: ${esc(r.library.file)} }</code>` : "No match in your library."}${hint ? ` · <a href="${esc(hint[1])}" target="_blank" rel="noopener">Search Pexels ↗</a>` : r.error ? ` · ${esc(r.error)}` : ""}</div>`;
  $("brollOut").innerHTML =
    lib +
    r.stock.map((c) => `<div class="clip" data-clip="${esc(`${c.site}:${c.id}`)}" title="${esc(c.title || c.page || "")}"><img src="${esc(c.thumb)}" alt="" loading="lazy"><div>${esc(c.site)} · ${Math.round(c.duration * 10) / 10}s · ${c.width}×${c.height}<br>${esc(c.author || String(c.title || "").slice(0, 40))}</div></div>`).join("");
});
$("brollOut").addEventListener("click", async (e) => {
  const c = e.target.closest(".clip[data-clip]");
  if (!c) return;
  await navigator.clipboard?.writeText(`{ at: "phrase", clip: "${c.dataset.clip}" }`).catch(() => {});
  c.querySelector("div").insertAdjacentHTML("beforeend", "<br><b>copied</b>");
});

// ---------- B-roll needed ----------
async function loadNeeded() {
  const lists = await api("/api/broll-needed");
  const open = lists.flatMap((l) => l.needs.map((n) => ({ ...n, list: l.list, batch: l.batch, rerun: l.rerun })));
  if (!open.length) {
    $("needed").innerHTML = `<p class="hint">Nothing needed. When a render can't find a clip, it shows up here.</p>`;
    return;
  }
  $("needed").innerHTML = lists
    .map(
      (l) => `<div><p class="hint">${esc(l.batch || l.list)}: download each clip from Pexels (vertical if possible, nothing AI-made), drop it on its row, then <code>${esc(l.rerun)}</code></p><div class="need-list">${l.needs
        .map(
          (n) => `<div class="need ${n.done ? "done" : ""}" data-list="${esc(l.list)}" data-i="${n.i}">
            <span><b>${esc(n.video)}</b> at “${esc(n.at)}”: ${esc(n.q)} ${n.done ? "✓ in place" : ""}</span>
            <span><a href="${esc(n.search)}" target="_blank" rel="noopener">Pexels ↗</a> <label class="ghost"><input type="file" accept="video/*,image/*" hidden>choose file</label></span>
            <small>${esc(n.file)}</small></div>`,
        )
        .join("")}</div></div>`,
    )
    .join("");
}
async function fillNeed(row, file) {
  row.querySelector("small").textContent = `saving ${file.name}…`;
  const r = await fetch(withToken(`/api/broll-needed/upload?list=${encodeURIComponent(row.dataset.list)}&i=${row.dataset.i}&name=${encodeURIComponent(file.name)}`), { method: "POST", body: file });
  const j = await r.json();
  row.querySelector("small").textContent = r.ok ? `saved ${j.path}` : `error: ${j.error}`;
  if (r.ok) row.classList.add("done");
}
$("needed").addEventListener("change", (e) => {
  const row = e.target.closest(".need");
  if (row && e.target.files?.[0]) fillNeed(row, e.target.files[0]);
});
$("needed").addEventListener("dragover", (e) => {
  const row = e.target.closest(".need");
  if (!row) return;
  e.preventDefault();
  e.stopPropagation();
  row.classList.add("over");
});
$("needed").addEventListener("dragleave", (e) => e.target.closest(".need")?.classList.remove("over"));
$("needed").addEventListener("drop", (e) => {
  const row = e.target.closest(".need");
  if (!row) return;
  e.preventDefault();
  e.stopPropagation();
  row.classList.remove("over");
  if (e.dataTransfer.files[0]) fillNeed(row, e.dataTransfer.files[0]);
});
$("neededReload").addEventListener("click", loadNeeded);

// ---------- uploads ----------
let dragDepth = 0;
// The page-wide drop zone uploads footage; on the B-roll tab, rows take the drops instead.
const onBrollTab = () => !$("tab-broll").hidden;
addEventListener("dragenter", (e) => {
  if (onBrollTab() || ![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  $("drop").hidden = false;
});
addEventListener("dragleave", () => {
  if (--dragDepth <= 0) $("drop").hidden = true;
});
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  if (onBrollTab()) return;
  dragDepth = 0;
  $("drop").hidden = true;
  const paths = [];
  for (const f of e.dataTransfer.files) {
    showOut(`uploading ${f.name}…`);
    const r = await fetch(withToken(`/api/upload?name=${encodeURIComponent(f.name)}`), { method: "POST", body: f });
    paths.push((await r.json()).path);
  }
  showOut(`uploaded: ${paths.join(" ")}`);
  $("newVideos").value = paths.join(" ");
  document.querySelector(".newbatch").open = true;
});

// ---------- start ----------
(async () => {
  listen();
  await loadStatus().catch((e) => showOut(`error: ${e.message}`));
  for (const j of await api("/api/jobs")) jobs.set(j.id, j);
  renderJobs();
  await loadFiles();
  try {
    const t = localStorage.getItem("reel-tab");
    if (t) document.querySelector(`#tabs button[data-tab="${t}"]`)?.click();
  } catch {}
})();
