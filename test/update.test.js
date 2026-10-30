import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { autoUpdate } from "../src/update.js";

// An "origin" with a new commit after the install was cloned: reel fast-forwards to it, but
// never over local edits, and checks at most once per interval.
test("auto-update fast-forwards a clean install, leaves local edits alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-update-"));
  const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" }).toString().trim();
  const origin = path.join(dir, "origin.git"), dev = path.join(dir, "dev"), install = path.join(dir, "install");
  git(dir, "init", "-q", "--bare", "-b", "master", origin);
  git(dir, "clone", "-q", origin, dev);
  fs.writeFileSync(path.join(dev, "a.txt"), "1");
  git(dev, "add", ".");
  git(dev, "commit", "-q", "-m", "first");
  git(dev, "push", "-q", "origin", "HEAD:master");
  git(dir, "clone", "-q", origin, install);
  const publish = (text, msg) => {
    fs.writeFileSync(path.join(dev, "a.txt"), text);
    git(dev, "commit", "-q", "-am", msg);
    git(dev, "push", "-q", "origin", "HEAD:master");
  };
  const env = process.env.REEL_NO_UPDATE;
  delete process.env.REEL_NO_UPDATE;
  try {
    publish("2", "photo B-roll");
    const r = autoUpdate({ root: install, every: 0 });
    assert.equal(r.subject, "photo B-roll");
    assert.equal(fs.readFileSync(path.join(install, "a.txt"), "utf8"), "2");
    assert.equal(autoUpdate({ root: install, every: 0 }), null); // already current

    publish("3", "next");
    assert.equal(autoUpdate({ root: install, every: 60000 }), null); // checked a moment ago
    fs.writeFileSync(path.join(install, "a.txt"), "local edit");
    assert.equal(autoUpdate({ root: install, every: 0 }), null);
    assert.equal(fs.readFileSync(path.join(install, "a.txt"), "utf8"), "local edit");
  } finally {
    if (env !== undefined) process.env.REEL_NO_UPDATE = env;
  }
});
