# Reel Editor

Batch video editor for agents. To EDIT VIDEOS, follow `.claude/skills/edit-videos/SKILL.md`
(`reel new` → fill hook/drop/broll in the YAML → `reel render`). The notes below are for
changing reel itself.

## Layout

- `bin/reel.js` CLI. `src/server.js` website + HTTP API, `src/mcp.js` MCP server; both are thin
  layers over the same functions as the CLI.
- `src/batch.js` batch YAML → per-video plans (`DEFAULTS` is the full option list) → parallel renders.
- `src/transcribe.js` + `py/transcribe.py` faster-whisper (VAD-split clips so retakes survive), cache in `.reel/`.
- `src/transcript.js` numbered lines, retake flags, phrase search. `src/edl.js` kept segments (frame-aligned).
- `src/captions.js` ASS subtitles; `src/styles.js` caption/text looks; `presets/*.yaml` looks.
- `src/hooks.js` drives hook-gen (`vendor/hook-gen`, git submodule) in headless Chromium and captures its PNG export.
- `src/broll.js` library search, the "B-roll needed" list (Pexels links), optional Pexels/Pixabay APIs. Never automate downloads from the Pexels website (their terms forbid it). `src/render.js` the ffmpeg filter graph. `src/qa.js` check + contact sheets.
- `fonts/` static caption fonts (rebuild with `scripts/build-fonts.py`); libass picks them by family name.

## Rules

- Output is always 1080x1920 at 60 fps (`W`, `H`, `FPS` in `src/util.js`).
- Each kept segment is trimmed by frame number and its audio by sample number; keep it that way
  (A/V sync across hundreds of cuts depends on it).
- Agent-facing output (CLI, MCP, API text) stays short: one line per video, errors that name the fix.
- No new dependencies without a strong reason (today: `yaml`, `playwright-core`).
- `npm test` runs unit tests and an end-to-end render (needs ffmpeg only).
