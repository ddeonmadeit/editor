# Reel Editor

Open-source batch video editor built for Claude and other AI agents. Point it at raw
talking-head clips; get finished **1080×1920, 60 fps** shorts with a hook, captions, jump
cuts, retakes removed, punch-ins and B-roll, many videos at once.

The agent never watches video or writes ffmpeg. It reads transcripts as numbered lines and
writes a few lines of YAML per video. That is what makes it fast, cheap in tokens and
consistent: every video goes through the same tuned pipeline.

```yaml
use: white
videos:
  - src: raw/IMG_1201.MOV
    hook: "I lost $50K on my first motel deal 💸"   # first 4 s, rendered by hook-gen
    drop: [2]                                      # transcript lines to cut (retakes)
    broll: ["new floors", "the bank"]              # from your B-roll folder; missing clips get a Pexels list
  - src: raw/IMG_1202.MOV
    hook: "This motel in Parkes is double my age! 🏨👴"
```

```
$ reel render edit.yaml
✓ IMG_1201 → out/IMG_1201.mp4 38.4s (23 cuts, 41 captions) in 31s
✓ IMG_1202 → out/IMG_1202.mp4 28.4s (11 cuts, 40 captions) in 27s
2/2 rendered in 33s
```

## What it does

- **Hooks** from [hook-gen](https://github.com/ddeonmadeit/hook-gen), pixel-identical to the
  site (TikTok Sans, real Apple emoji, presets like Get Known), on screen for the first 4 s.
- **Transcription** with word timestamps (faster-whisper, local). Speech is split at pauses
  first, so fumbled takes stay in the transcript instead of being silently merged.
- **Retake detection**: lines that get restarted are flagged and pre-filled for cutting.
- **Jump cuts**: pauses and filler words removed; cut points snap to real speech onset and
  offset; frame-aligned and sample-exact, so lip sync never drifts.
- **Punch-ins** on alternate cuts to hide jumps; HDR iPhone footage tone-mapped to SDR.
- **Captions** in the reference looks: white bold-italic with soft shadow, orange with a dark
  edge, condensed green caps, TikTok native, karaoke; pop-in, highlighted words.
- **B-roll** by phrase from your library folders (file names, folders, `tags.yaml`), no reuse
  within a batch. A clip the library doesn't have doesn't stop the render: it goes on a
  "B-roll needed" list with a Pexels search link (vertical clips) and the file name to save
  it as; drop the download in (or onto its row in the dashboard) and re-render. With a
  Pexels API key the gaps fill automatically. Full-screen or split-screen; stills get a slow
  push-in.
- **Callouts**: counting money tickers (`-$50,000` ticking up like the reference), colour
  flashes, music with ducking, sound effects.
- **Audio**: high-pass, gentle compression, presence lift, two-pass loudness to -14 LUFS.
- **Batch rendering** in parallel, with machine-wide render slots so several agents can
  render at the same time without fighting over the CPU.
- **QA**: `reel check` verifies every output; `reel sheet` makes one contact-sheet image.

## Install

Needs Node 20+, ffmpeg (with libass and libx264; the standard builds have both), Python 3.

```bash
git clone --recursive https://github.com/ddeonmadeit/editor
cd editor
npm install
npm link            # puts `reel` on your PATH
reel setup          # faster-whisper + model, browser for hooks, hook-gen; checks ffmpeg
reel skill          # optional: teach Claude Code the workflow in every folder
```

macOS: `brew install ffmpeg python`. Ubuntu: `apt install ffmpeg python3-venv`.
### B-roll that isn't in your library

No key needed. reel lists what's missing in `<batch>-broll-needed.md` (and in the
dashboard's B-roll tab) with a Pexels search link and the file name to save each clip as.
Someone grabs those few clips from Pexels and drops them in; the next render uses them.
reel never downloads from the Pexels website itself: Pexels' terms forbid automated
downloading, and new API keys are paused.

If you have a Pexels API key, put `PEXELS_API_KEY=...` in `.env` (project folder or the
repo) and gaps fill automatically. Pixabay (`PIXABAY_API_KEY`, free) is supported but off
unless a batch sets `stock: [pexels, pixabay]`, because Pixabay accepts AI-generated uploads
and its API can't filter them out.

## Use it with Claude Code

In the folder with your footage:

> edit the videos in raw/ with reel, white look

Claude follows the bundled skill (`.claude/skills/edit-videos`):

1. `reel new edit.yaml raw/` – transcribes everything and writes `edit.yaml` with each
   transcript inline as numbered lines; likely retakes are already in `drop`.
2. Fills in `hook`, `drop` and `broll` for every video in one edit.
3. `reel render edit.yaml` – all videos, in parallel. `reel check out/` to confirm.

A typical 5-video batch is a few thousand tokens in total: reading one YAML file and
writing a few lines per video.

Several agents can work at once (e.g. one per batch): transcripts and render slots are
shared safely through the `.reel/` folder and machine-wide locks.

## Website and API

```bash
reel serve            # http://localhost:4317
```

A dashboard for people (edit batches, render, watch progress and results, search B-roll,
design hooks in the embedded hook-gen, drag-and-drop uploads) and an HTTP API for agents
that can't run commands: `POST /api/render {"batch": "edit.yaml"}`, then
`GET /api/job?id=1&wait=1`. Compact reference for models at `/llms.txt`. It binds to
localhost; set `REEL_TOKEN` and `--host 0.0.0.0` to host it (the Dockerfile does that).

## MCP

```bash
claude mcp add reel -- reel mcp                # Claude Code
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "reel": { "command": "reel", "args": ["mcp"], "cwd": "/path/to/footage" } } }
```

Tools: `reel_new`, `reel_transcript`, `reel_plan`, `reel_render`, `reel_check`,
`reel_sheet` (returns the image), `reel_broll`, `reel_library`, `reel_spec`.

## Commands

```
reel new edit.yaml raw/*.mov     transcribe + batch file with transcripts inline
reel render edit.yaml            render (--only id,id --jobs N --quality draft|high|max)
reel plan edit.yaml              check without rendering
reel ingest raw/*.mov            transcribe only (--model, --lang, --prompt "names")
reel transcript <id>             numbered transcript
reel check out/                  1080x1920, 60 fps, audio, -14 LUFS
reel sheet out/x.mp4             contact sheet PNG (--at 1,5,9)
reel broll "query"               library match, else a Pexels link + file name
reel library [broll/]            list the B-roll folder (--sheet)
reel hook "text" -o hook.png     one hook via hook-gen (--preset get-known)
reel styles                      looks, caption styles, hook presets
reel serve | reel mcp | reel setup | reel skill | reel help spec
```

Every batch option: [docs/SPEC.md](docs/SPEC.md).

## Looks

`white`, `orange`, `green` and `getknown` (in `presets/`) were measured from reference
edits: caption font, size, colour, stroke, shadow and position, pacing and punch-in. Add your
own as a YAML file of defaults and `use:` it.

## Speed

On a 4-core cloud VM (no GPU) a 3-video batch (73 s of output) renders in 86 s at the
default quality. On a Mac reel switches to the VideoToolbox hardware encoder automatically,
which is typically several times faster than software x264. `--quality draft` is quicker
still for previews.

## How it works

`src/transcribe.js` + `py/transcribe.py` (faster-whisper, VAD-split) → `src/transcript.js`
(numbered lines, retakes, phrase lookup) → `src/edl.js` (what survives, frame-aligned) →
`src/captions.js` (ASS subtitles) + `src/hooks.js` (hook-gen in headless Chromium) +
`src/broll.js` (library, needed list, optional stock APIs) → `src/render.js` (one ffmpeg filter graph per video:
trim/crop/scale each kept segment once, overlays, libass, loudness, x264/VideoToolbox) →
`src/batch.js` (plans and renders a batch in parallel). `src/server.js` and `src/mcp.js` are
thin layers over the same functions.

## Credits and licences

Code: MIT. Caption fonts in `fonts/` are static cuts of Arimo, Inter, Montserrat, TikTok
Sans, Anton and Bebas Neue under the SIL Open Font License (see `fonts/LICENSES.md`).
Hooks: [hook-gen](https://github.com/ddeonmadeit/hook-gen) (git submodule). Pexels clips are
under the [Pexels license](https://www.pexels.com/license/) (free to use, no attribution
required); clips fetched through an API key are listed in `out/credits.txt`.
