---
name: edit-videos
description: Edit talking-head videos into finished 1080x1920 60fps shorts (hook, captions, jump cuts, B-roll) with the `reel` batch editor, several videos at once and with very few tokens. Use when asked to edit, cut, caption, add hooks or B-roll to, or batch-process vertical videos (TikTok, Reels, Shorts).
---

# Editing videos with reel

`reel` does all the video work. You only read text and write a small YAML file. Never
watch videos, extract frames, or write ffmpeg commands yourself: that is what burns tokens.

## The whole job (3 commands)

1. `reel new edit.yaml <videos or folder>`
   Transcribes every video (cached) and writes `edit.yaml` with each transcript inline as
   numbered comment lines `n start text`. `R>n` marks a likely fumbled take (redone in line
   n); those are already in `drop`.
2. Read `edit.yaml` once, then fill in each video in one edit:
   - `hook:` the scroll-stopping line shown for the first 4 s. Short (5-10 words), concrete,
     a number or tension if the script has one, 1-2 emoji at the end. Usually a tightened
     version of the opening claim, e.g. `"I lost $50K on my first motel deal 💸"`.
     Use `\n` to break lines where they read best.
   - `drop:` line numbers to cut: retakes (keep the LAST good take), false starts, rambles,
     off-topic bits, "is it recording?". Check the pre-filled retakes; remove any wrong one.
   - `broll:` 0-4 moments that benefit from cutaways, as the phrase where it should start:
     `broll: ["new floors", { at: "the bank", q: "bank building exterior" }]`. The user's
     `broll/` folder is searched first, then stock sites (real footage, AI clips left out). Don't add B-roll over
     the hook or over emotional face-to-camera moments.
   - Optional: `highlight: ["$50,000"]`, `texts:` callouts, a different `use:` look.
   - Names the transcript got wrong: `fix: { parks: Parkes }` (captions only; put
     client-wide names under `defaults:`).
3. `reel render edit.yaml` renders every video in parallel; one line per video.
   Then `reel check out/` (format/loudness) if you want proof.

If `render` reports an error for a video, it says exactly what to fix (e.g. a phrase that
isn't in the transcript, with the closest match). Fix that line and run
`reel render edit.yaml --only <id>`.

## Rules that keep it cheap

- Read transcripts from `edit.yaml` (or `reel transcript <id>`), never word-level output.
- Refer to moments by phrase (`at: "new floors"`), never by computing timestamps.
- Make all edits in one pass over the YAML, then one `render`. Don't render one video at a
  time; the batch already runs in parallel.
- `reel plan edit.yaml` checks everything without rendering (instant).
- To look at a result, `reel sheet out/<id>.mp4` gives ONE small contact-sheet image;
  use `--at 1,4,9` for specific seconds. Only do this if something seems wrong.
- `--quality draft` for a quick preview render.

## Looks (set with `use:` at the top or per video)

- `white`: white bold-italic captions with a soft shadow, mid-frame (default)
- `orange`: orange bold-italic captions with a dark edge, lower third
- `green`: big condensed caps (Anton), mint fill, green stroke, looser cuts, no punch-in
- `getknown`: Get Known brand hook (ink boxes, gold payoff line) + white captions

Hook presets come from hook-gen: `tiktok-classic` (default white box) and `get-known`.

## Useful extras

```yaml
pacing: tight            # tight | normal | loose | off (how hard pauses are cut)
retakes: auto            # drop every flagged retake without listing them
cut: ["you know what I mean"]       # remove a phrase
texts: [{ at: 0, text: "-$50,000", style: red, count: 1, dur: 3.5 }]   # counting number
flash: [{ at: "lost it all" }]      # red flash on a word
music: { src: music/track.mp3, volume: 0.1 }
speed: 1.1
```

Everything else: `reel help spec`. B-roll candidates for a phrase: `reel broll "query"`
(add `--sheet` for one thumbnail image). What's in the library: `reel library`.

## Setup (only if a command says something is missing)

If `reel` isn't on PATH, run it as `node <editor repo>/bin/reel.js` (or `npm link` once in
the repo).
`reel setup` installs/checks ffmpeg, faster-whisper, the hook renderer and hook-gen.
Stock B-roll needs a key in the environment or `.env`: `COVERR_API_KEY` (free, instant at
coverr.co/developers), `PIXABAY_API_KEY`, or an existing `PEXELS_API_KEY`.
