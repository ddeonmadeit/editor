import fs from "node:fs";
import path from "node:path";
import { staticServer } from "./static.js";
import { HOOKGEN_DIR, HOOKGEN_URL, ensureDir, sha1, stateDir } from "./util.js";

// Hooks are made by hook-gen itself (https://github.com/ddeonmadeit/hook-gen): its page is
// loaded in headless Chromium, given the text and style, and its own "Download PNG" export
// is captured. So a hook here is pixel-for-pixel what the hook-gen site makes.

export const HOOK_PRESETS = ["tiktok-classic", "get-known"];
const STYLE_KEY = "hook-gen-style"; // hook-gen keeps its current style in this localStorage key

// The export renders text at 144 px; size scales that to the frame.
export const HOOKGEN_FONT_PX = 144;

function hookgenVersion() {
  try {
    return String(fs.statSync(path.join(HOOKGEN_DIR, "app.js")).mtimeMs);
  } catch {
    return "live";
  }
}

async function launch() {
  const { chromium } = await import("playwright-core");
  const tries = [{}];
  if (process.env.REEL_CHROMIUM) tries.unshift({ executablePath: process.env.REEL_CHROMIUM });
  tries.push({ channel: "chrome" }, { channel: "msedge" });
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (fs.existsSync(p)) tries.push({ executablePath: p });
  let last;
  for (const opts of tries) {
    try {
      return await chromium.launch({ ...opts, args: ["--no-sandbox"] });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`can't start a browser to render hooks (${last?.message?.split("\n")[0]}). Run: reel setup   or set REEL_CHROMIUM to a Chrome/Chromium binary`);
}

// Renders hooks to PNG files (cached by text + style). items: [{ text, preset, style }].
// Returns the PNG paths in the same order.
export async function renderHooks(items, { ws = process.cwd(), onLog } = {}) {
  const dir = ensureDir(path.join(stateDir(ws), "hooks"));
  const ver = hookgenVersion();
  const jobs = items.map((it) => {
    const key = sha1(it.text, it.preset || "", it.style || {}, ver).slice(0, 16);
    return { ...it, file: path.join(dir, `${key}.png`) };
  });
  const todo = jobs.filter((j) => !fs.existsSync(j.file));
  if (todo.length) {
    const local = fs.existsSync(path.join(HOOKGEN_DIR, "index.html"));
    const server = local ? await staticServer(HOOKGEN_DIR) : null;
    const base = server ? server.url : HOOKGEN_URL;
    const browser = await launch();
    try {
      const ctx = await browser.newContext({ acceptDownloads: true, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const styleCache = new Map();
      // hook-gen's own preset buttons define what a preset looks like; read it back once.
      const styleFor = async (preset, overrides) => {
        const k = JSON.stringify([preset, overrides]);
        if (styleCache.has(k)) return styleCache.get(k);
        await page.goto(base, { waitUntil: "load" });
        await page.evaluate((key) => localStorage.removeItem(key), STYLE_KEY);
        await page.reload({ waitUntil: "load" });
        if (preset && preset !== "tiktok-classic") {
          const btn = page.locator(`.preset-apply[data-id="${preset}"]`);
          if (!(await btn.count())) throw new Error(`hook preset "${preset}" isn't in hook-gen (have: ${(await page.$$eval(".preset-apply", (b) => b.map((x) => x.dataset.id))).join(", ")})`);
          await btn.click();
        }
        const style = { ...(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), STYLE_KEY)) || "{}")), ...(overrides || {}) };
        styleCache.set(k, style);
        return style;
      };
      let loaded = null;
      for (const j of todo) {
        const style = await styleFor(j.preset, j.style);
        const sk = JSON.stringify(style);
        if (loaded !== sk) {
          await page.evaluate(([key, v]) => localStorage.setItem(key, v), [STYLE_KEY, sk]);
          await page.reload({ waitUntil: "load" });
          loaded = sk;
        }
        await page.fill("#text", j.text);
        const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click("#download")]);
        await dl.saveAs(j.file);
        onLog?.(`hook rendered: ${Array.from(j.text.replace(/\s+/g, " ")).slice(0, 50).join("")}`);
      }
    } finally {
      await browser.close();
      server?.close();
    }
  }
  return jobs.map((j) => j.file);
}
