---
name: reel-client-editing
description: How to edit client videos with the reel batch editor (hook, captions, jump cuts, retakes, B-roll; 1080x1920 60fps). Use for every request to edit, cut, caption, add hooks or B-roll to client videos. Replaces the previous editor for these jobs.
---

# Editing client videos with reel

From now on, when you're asked to edit videos for a client, do the editing with **reel**
(https://github.com/ddeonmadeit/editor) instead of the previous editor. Everything else
stays the same: you already know where each client's raw footage and B-roll live and where
finished videos go. reel replaces only the editing step.

reel does all the video work. You read transcripts as text and write a short YAML file.
You never watch footage, pull frames, or write ffmpeg commands, which is what keeps jobs
fast and cheap.

---

## 1. One-time setup (do this once on this machine)

```bash
git clone --recursive https://github.com/ddeonmadeit/editor ~/reel-editor
cd ~/reel-editor && npm install && npm link     # puts `reel` on PATH
reel setup                                      # transcription model, hook renderer, hook-gen; checks ffmpeg
echo "COVERR_API_KEY=<the team's Coverr key>" >> ~/reel-editor/.env   # stock B-roll, see below
reel styles                                     # should list looks: getknown, green, orange, white
```

The Coverr key is free and instant: sign in at https://coverr.co/developers, then
Profile → API → create an application. (Pexels has paused new API keys; if the team gets
one later, add `PEXELS_API_KEY=` too and reel will use Pexels first.)

Needs Node 20+, Python 3 and ffmpeg (`brew install ffmpeg` on a Mac). If `reel` isn't found
later, use `node ~/reel-editor/bin/reel.js` instead. Don't also run `reel skill`; this file
is your instructions. To update reel later: `cd ~/reel-editor && git pull --recurse-submodules && npm install`.

## 2. Every job, step by step

**Work in one job folder** per batch (e.g. inside the client's folder:
`<client>/edits/<date>/`). Run every `reel` command from that folder; reel keeps its
transcript cache in a `.reel/` folder there.

1. **Transcribe and scaffold**

   ```bash
   reel new edit.yaml "<path to the client's raw videos>" --use <look> --prompt "<client name, brand/product names, people, places>"
   ```

   This writes `edit.yaml` with every video and its transcript inline as numbered lines:
   `n start text`. `R>n` means "probably a fumbled take, redone in line n"; those lines are
   already listed in `drop`. `--prompt` helps the transcriber spell the client's names.

2. **Read `edit.yaml` once and fill in every video in one edit** (section 3 says how):
   `hook`, `drop`, `broll`, and optionally `highlight`, `texts`, `fix`. Client-wide settings
   go under `defaults:` at the top, or in the client's look file (section 4).

3. **Check:** `reel plan edit.yaml`. It's instant. Each problem names its fix (e.g. a
   B-roll phrase that isn't in the edit, with the closest match). Fix and re-run until clean.

4. **Render:** `reel render edit.yaml`. All videos render in parallel; you get one line per
   video. Don't render videos one at a time.

5. **Verify:** `reel check out/` (1080x1920, 60 fps, audio, -14 LUFS). During the trial,
   also look at one contact sheet per batch: `reel sheet out/<first video>.mp4` (one small
   image). Only look at more if something seems wrong.

6. **Deliver** the files in `out/` the way you normally deliver. If stock clips were used,
   `out/credits.txt` lists them; pass it along.

7. **Report** to the team (section 7).

To redo one video after a change: `reel render edit.yaml --only <id>`.
For a quick low-quality preview: add `--quality draft`.

## 3. Editorial decisions

**Hook** (on screen for the first 4 seconds, made by hook-gen):
- One punchy line, 5-10 words, sentence case, ending in `!` or `?`, then 1-2 emoji.
- Lead with the most surprising concrete claim in the video: a number, a loss, a contrast,
  a famous person, a bold opinion. Usually a tightened version of what the speaker says
  first. Don't spoil the payoff.
- Use `\n` to choose the line break when two lines read better.
- Examples from our edits:
  - `"This motel in Parkes is double my age! 🏨👴"`
  - `"Being a master of one thing is\nholding you back! 🙈"`
  - `"Australia's best boxer tries our Drinks! 🥊🇦🇺"`
  - `"I lost $50K on my first motel deal 💸"`
- For Get Known's own content use `hook: { text: "...", preset: get-known }`.

**Drop** (line numbers to cut):
- Retakes: keep the last complete take, drop the earlier attempts. Check the pre-filled
  ones; remove any that aren't really retakes.
- False starts, "is this recording?", "let me start again", off-topic tangents, dead ends.
- Don't drop for pauses or "um"s; reel cuts those automatically.

**B-roll** (0-4 per video, 1.5-3 s each):
- Use it where the speaker names something visual (a place, an object, an action) or to
  break up a long talking stretch. Not during the hook, not over emotional to-camera moments.
- Write the phrase where it should start: `broll: ["new floors"]`. To show something other
  than the phrase itself, add a query: `{ at: "the bank", q: "bank building exterior" }`.
- The client's B-roll folder is searched first (by file names, folder names and an
  optional `tags.yaml`), then stock footage (Coverr; Pexels if a key is ever added). Make
  queries concrete ("motel room with new floor tiles", not "renovation"). reel leaves out
  clips marked or tagged as AI-generated, 3D or animated; never bring in AI-generated
  B-roll from anywhere else.
- A specific file: `{ at: "the sign", src: /path/to/sign.mp4 }`. To see stock options:
  `reel broll "query"` (add `--sheet` for one thumbnail image), then pin one with
  `{ at: "...", clip: "coverr:<id>" }`.
- Coverr's free plan allows 50 searches an hour (searches are cached for a day). For big
  batches, lean on the client's library and keep stock to the moments that need it.
- Speaker on top, B-roll below: add `layout: split`.

**Captions and looks** (`use:` at the top, or per video):
- `white`: white bold-italic, soft shadow, mid-frame. Default for talking heads.
- `orange`: orange bold-italic with a dark edge, lower. Moody, dark, podcast-style footage.
- `green`: big condensed caps, green stroke, looser cuts, no punch-in. Street, vlog,
  product and reaction footage.
- `getknown`: Get Known brand hook with white captions.

**Extras:**
- `highlight: ["$50,000", "Monday"]` colours 1-3 key words (money, numbers, names).
- `fix: { parks: Parkes }` corrects names the transcript misspelled (captions only). The
  transcript lines show what was heard, so you'll spot these while reading.
- Money counter like the motel video: `texts: [{ at: 0, text: "-$50,000", style: red, count: 1, dur: 3.5 }]`.
- `flash: [{ at: "lost everything" }]` red flash on a word. `music: { src: <file>, volume: 0.1 }`.
- `pacing: tight | normal | loose` for how hard pauses are cut (default normal).
- `name: acme-ad-1` sets the output file name (default: the source file's name).

Full reference: `reel help spec`.

## 4. Keep each client consistent: a look file

Make one look file per client the first time you edit for them, e.g.
`<client folder>/look.yaml`, and use it every time: `use: /abs/path/to/look.yaml`.

```yaml
# Acme Motels
captions: { style: white }
hook: { preset: tiktok-classic }
pacing: normal
zoom: 1.1
library: [/abs/path/to/acme/broll]            # their B-roll folder(s); absolute paths
fix: { parks: Parkes, "bushman's": Bushmans }  # names that get misheard
```

Anything in a look file can be overridden per video in `edit.yaml`. Add to `fix` whenever
you find a new misheard name.

## 5. Rules that keep it fast and cheap

- Never open or watch videos, extract frames, or run ffmpeg/ffprobe yourself.
- Read transcripts only in `edit.yaml` (or `reel transcript <id>`). Don't use `--words`.
- Point at moments by phrase (`at: "new floors"`), never by working out timestamps.
- One editing pass over `edit.yaml`, then one `reel plan`, one `reel render` for the batch.
- `reel render` waits until it's done and prints one line per video; don't poll.
- Several batches at once (e.g. one subagent per client) is fine: each uses its own job
  folder, and reel shares the CPU between them automatically.

## 6. A filled-in example

```yaml
use: /Clients/Acme/look.yaml
out: out
videos:
  - src: ../raw/IMG_1201.MOV  # IMG_1201 52.1s
    hook: "I lost $50K on my first motel deal 💸"
    drop: [2, 9]
    highlight: ["$50,000"]
    texts: [{ at: 0, text: "-$50,000", style: red, count: 1, dur: 3.5 }]
    broll:
      - { at: "shitty lawyer", q: "lawyer office desk paperwork" }
    # 1 0 I lost $50,000 on my first motel deal.
    # 2 2.6 So when I locked in my first motel, I put a 50-  R>3
    # 3 5.2 So when I locked in my first motel, I put a $50,000 deposit to secure the deal.
    # ...
  - src: ../raw/IMG_1202.MOV  # IMG_1202 30s
    hook: "This motel in Parkes is double my age! 🏨👴"
    drop: []
    broll: ["new floors", { at: "new aircon", q: "air conditioner unit outside" }]
```

## 7. Report back

Keep it short:

```
<Client>: 4/4 videos edited with reel, delivered to <place>
✓ IMG_1201 38.4s  hook "I lost $50K on my first motel deal 💸"  dropped 2,9  B-roll: 1 Coverr
✓ IMG_1202 28.4s  hook "This motel in Parkes is double my age! 🏨👴"  B-roll: 2 library
Notes: <anything odd, anything reel couldn't do, anything that needed a second try>
```

## 8. Trial period

- Unless told otherwise, deliver reel's renders to a separate folder next to the usual
  delivery (e.g. `.../reel-test/`) so the team can compare with the old editor.
- If a client asks for something reel can't do (a specific transition, an effect), say so
  in the report. Don't quietly switch back to the old editor; the team needs to know.

## 9. When something goes wrong

| message | do |
|---|---|
| `"..." isn't in the edited video (closest: "...")` | use the closest phrase, or a phrase from a line you didn't drop |
| `unknown key "..." (did you mean "..."?)` | fix the key name |
| `no match in the B-roll library, and no stock footage key is set` | add `COVERR_API_KEY` to `~/reel-editor/.env` |
| `Coverr rate limit hit` | use library clips or `src:` files, or retry in an hour |
| `no stock footage for "..."` | try different, more concrete words |
| `faster-whisper isn't installed` / `can't start a browser` | run `reel setup` |
| `nothing left after cutting` | you dropped every line; check `drop` |
| a caption word is spelled wrong | add it to `fix:` |
| a cut feels too abrupt or too slow | `pacing: loose` or `pacing: tight` for that video |
| a render fails with an ffmpeg error | report the line to the team; render the rest |

Anything else: `reel help spec` has every option.
