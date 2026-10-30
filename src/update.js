import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./util.js";

// Keeps an installed reel current without anyone running `git pull`: before a command, at
// most every `every` ms, fetch the branch reel was cloned from and fast-forward to it
// (submodules and npm packages too). Agents then get new features and the edit.yaml tips
// that explain them on their next job. Skipped when the checkout has local edits or local
// commits, has no upstream, or is offline; REEL_NO_UPDATE=1 turns it off. Returns
// { from, to, subject } when it updated, else null.
export function autoUpdate({ root = ROOT, every = 10 * 60 * 1000, log } = {}) {
  if (process.env.REEL_NO_UPDATE || !fs.existsSync(path.join(root, ".git"))) return null;
  const git = (args, timeout = 15000) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const stamp = path.join(root, ".git", "reel-update-check");
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < every) return null;
  } catch {}
  try {
    fs.writeFileSync(stamp, "");
  } catch {}
  if (!git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) return null;
  if (git(["status", "--porcelain", "--untracked-files=no"]) !== "") return null;
  if (git(["fetch", "--quiet"]) === null) return null;
  const behind = Number(git(["rev-list", "--count", "HEAD..@{u}"]));
  const ahead = Number(git(["rev-list", "--count", "@{u}..HEAD"]));
  if (!behind || ahead) return null;
  const from = git(["rev-parse", "--short", "HEAD"]);
  if (git(["merge", "--ff-only", "--quiet", "@{u}"], 60000) === null) return null;
  const to = git(["rev-parse", "--short", "HEAD"]);
  git(["submodule", "update", "--init", "--recursive", "--quiet"], 120000);
  const changed = git(["diff", "--name-only", from, to]) || "";
  if (/^package(-lock)?\.json$/m.test(changed)) spawnSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: root, stdio: "ignore", timeout: 300000, shell: process.platform === "win32" });
  const subject = git(["log", "-1", "--format=%s"]) || "";
  log?.(`reel updated ${from} → ${to}: ${subject}`);
  return { from, to, subject };
}
