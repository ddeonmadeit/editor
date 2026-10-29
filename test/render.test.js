import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderBatch } from "../src/batch.js";
import { probe } from "../src/media.js";
import { check } from "../src/qa.js";
import { saveTranscript } from "../src/transcribe.js";

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

// End to end without whisper or a browser: a synthetic 30 fps landscape clip with three
// "sentences" of tone separated by silence, an imported transcript, a still B-roll and a
// pre-made hook PNG. The result must be 1080x1920 at 60 fps with the pauses cut out, and the
// still must fill the frame and pan left to right.
test("renders a batch to 1080x1920 60fps", { skip: !hasFfmpeg, timeout: 300000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "reel-e2e-"));
  const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
  // Tone on for 2 s, off for 1.5 s, three times.
  ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=10", "-f", "lavfi", "-i", "sine=f=220:d=10", "-af", "volume='if(lt(mod(t,3.5),2),1,0)':eval=frame", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path.join(ws, "talk.mp4"));
  // A white landscape still with a black bar down the middle.
  ff("-f", "lavfi", "-i", "color=c=white:s=1600x900,drawbox=x=792:y=0:w=16:h=900:color=black:t=fill", "-frames:v", "1", path.join(ws, "still.png"));
  ff("-f", "lavfi", "-i", "color=c=white@1:s=600x160,format=rgba", "-frames:v", "1", path.join(ws, "hook.png"));
  const words = [];
  for (let k = 0; k < 3; k++) for (let i = 0; i < 6; i++) words.push([k * 3.5 + i * 0.33, k * 3.5 + i * 0.33 + 0.3, `${["one", "two", "three"][k]}${i}${i === 5 ? "." : ""}`]);
  await saveTranscript(ws, path.join(ws, "talk.mp4"), { words });
  const batch = {
    out: "out",
    videos: [
      {
        src: "talk.mp4",
        hook: { png: "hook.png", dur: 2 },
        drop: [2],
        broll: [{ at: 2.4, src: "still.png", dur: 1 }],
        texts: [{ at: 0, text: "-$5,000", style: "red", count: 0.5, dur: 1 }],
        flash: [{ at: "one3" }],
        highlight: ["one2"],
      },
    ],
  };
  const r = await renderBatch(batch, { ws, quality: "draft", jobs: 1 });
  assert.deepEqual(
    r.results.map((x) => x.errors || []),
    [[]],
  );
  const out = path.join(ws, "out", "talk.mp4");
  const info = await probe(out);
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.equal(Math.round(info.fps), 60);
  assert.ok(info.hasAudio);
  // Two 2 s sentences survive (the middle one is dropped, pauses are cut).
  assert.ok(info.duration > 3.5 && info.duration < 5, `duration ${info.duration}`);
  const c = await check(out);
  assert.ok(c.ok, c.problems.join(", "));
  // The bar, found in a row near the top: on screen early and late in the still's second,
  // and further left later on (the view moves right).
  const barX = (t) => {
    const row = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "format=gray,crop=1080:1:0:200", "-f", "rawvideo", "-"]);
    let sum = 0, n = 0;
    row.forEach((v, x) => v < 100 && ((sum += x), n++));
    return n ? sum / n : -1;
  };
  const early = barX(2.45), late = barX(3.3);
  assert.ok(early > 400 && early < 700 && late > 400, `bar at ${early} then ${late}`);
  assert.ok(late < early - 15, `pans left to right: bar at ${early} then ${late}`);
});
