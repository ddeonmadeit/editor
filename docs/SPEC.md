# Batch file reference

A batch is one YAML (or JSON) file that describes every video to edit. Paths are relative
to the batch file. Every output is 1080x1920, 60 fps, H.264 + AAC, loudness -14 LUFS.

```yaml
use: white                 # look: white | orange | green | getknown | path/to/look.yaml
out: out                   # output folder (default out/)
jobs: 2                    # videos rendered at once (default: by CPU count)
defaults:                  # applied to every video (any per-video key below)
  pacing: tight
videos:
  - src: raw/IMG_1201.MOV
    hook: "I lost $50K on my first motel deal 💸"
    drop: [2, 7-9]
    broll: ["new floors", "aircon"]
  - src: raw/IMG_1202.MOV
    use: green               # a different look for this one
    hook: { text: "This motel is double my age! 🏨👴", preset: get-known }
```

`src` may be a glob (`raw/*.mov`): every match gets the same settings. Settings merge in
this order: built-in defaults ← `use` look(s) ← `defaults` ← the video's own keys.

## Cutting

| key | default | meaning |
|---|---|---|
| `drop` | `[]` | transcript line numbers to remove: `[3, 5-7]` or `"3,5-7"` (retakes, rambles) |
| `keep` | | the opposite: only these lines survive |
| `cut` | `[]` | phrases to remove: `["you know", {from: "So basically", to: "anyway"}]`, or source seconds `[[12.5, 14]]` |
| `retakes` | `false` | `auto` drops every line the transcript flags `R>n` |
| `fillers` | `true` | remove um / uh / erm |
| `pacing` | `normal` | pause cutting: `tight` (≤0.22 s kept) · `normal` (≤0.38 s) · `loose` (≤0.7 s) · `off` (keep pauses), or `{gap, pre, tail}` in seconds |
| `trim` | | `[start, end]` source seconds to use at all |
| `speed` | `1` | e.g. `1.1` for 10% faster delivery (pitch kept) |

Cut points snap to where speech really starts and stops (from the audio envelope), so word
tails aren't clipped. Every cut is frame-aligned and sample-exact, so lip sync never drifts.

## Hook (first 4 seconds)

Made by [hook-gen](https://github.com/ddeonmadeit/hook-gen) itself (headless browser), so it
looks exactly like the hook-gen site: TikTok-style box, TikTok Sans, real Apple emoji.

```yaml
hook: "Text with emoji 🚀"         # shorthand
hook:
  text: "Line one\nline two 💸"     # \n forces a line break
  preset: tiktok-classic            # or get-known (any hook-gen built-in preset)
  style: { box: "#000000", text: "#ffffff", width: 14 }   # hook-gen style overrides
  dur: 4                            # seconds on screen
  y: 0.5                            # vertical centre (0 top .. 1 bottom), or top/center/bottom
  size: 84                          # text size in px on the 1080x1920 frame
  png: hooks/custom.png             # use a PNG exported from hook-gen instead of text
```

`style` takes hook-gen's own settings: `font` (tiktok, tiktok-bold, montserrat, anton, …),
`box`, `text`, `opacity`, `roundTop`, `roundBottom`, `gap`, `join` (merge|stack),
`padSide`, `padTop`, `padBottom`, `accent`, `lastBox`, `lastText`, `align`, `width`.
`hook: false` = no hook. Captions start when the hook ends.

## Captions

```yaml
captions: white            # style name, or false for none
captions:
  style: green             # white | orange | green | tiktok | bold
  size: 140                # px
  y: 0.55                  # vertical centre
  words: 2                 # max words per caption
  chars: 14                # max characters per caption
  case: upper              # none | upper | lower
  color: "#ffffff"
  stroke: 6
  strokeColor: "#000000"
  shadow: false            # or { x, y, blur, color, alpha }
  active: "#ffd60a"        # light up the word being spoken (karaoke)
  pop: 0.12                # pop-in scale (0 = off)
  afterHook: true          # hide captions while the hook is up
highlight: ["$50,000", "Monday"]   # words drawn in the style's highlight colour
fix: { parks: Parkes, "Travel Pinot": Travelpreneur }   # caption spelling (names, brands)
```

`fix` corrects what the captions show (and what `at:` phrases match) without touching the
audio. Keys are matched case- and punctuation-insensitively; several words can become one.
Put client-wide names under `defaults:` or in the client's look file.

| style | look | from |
|---|---|---|
| `white` | Arimo Bold Italic 130px, white, soft drop shadow, centred | "double my age", "I lost 50K" |
| `orange` | Arimo Bold Italic 120px, orange, dark brown edge, 60% down | "master of one" |
| `green` | Anton 148px caps, mint fill, green stroke, dark rim | "best boxer tries our drinks" |
| `tiktok` | TikTok Sans Black, white, black stroke | TikTok native |
| `bold` | Montserrat Black Italic caps, spoken word in yellow | karaoke |

## B-roll

Ask for B-roll by what it should show. Your library folders are searched first (file
names, folder names, and an optional `tags.yaml` per folder), then Pixabay: real filmed
footage, ranked by how many of your words its tags have (then how prominent those tags
are, then vertical first), with AI-tagged, 3D, animated and fantasy clips left out. Landscape clips are fetched in 4K so the vertical
crop stays sharp. A clip isn't reused within a batch while another match exists. If
nothing matches most of the words, the video renders without that clip and the plan says
so: use other words and re-render. Write `q` as 1-3 common keywords, the way stock clips
are tagged ("air conditioning", "signing contract"); long descriptions match nothing.
Clips used are listed in `out/credits.txt`.

A Pixabay key is built in; `PIXABAY_API_KEY` in the environment or `.env` overrides it, and
`PIXABAY_API_KEY=off` turns Pixabay off. Searches are cached for a day. An existing
`PEXELS_API_KEY` also works and is tried first.

```yaml
broll:
  - "new floors"                                   # at that phrase, search for it
  - { at: "new aircon", q: "air conditioning" }    # at a phrase, search for something else
  - { at: "the banker", src: broll/bank.mp4 }       # a specific file
  - { at: "Friday", clip: "pixabay:124947" }        # an exact clip (ids from `reel broll`)
  - { at: 12.5, src: broll/sign.jpg, dur: 1.5 }     # at output second 12.5; stills get a slow push-in
  - { at: "my documentary", to: "business", q: "film camera", layout: split }
library: [broll, ~/Footage/motel]                  # where to look first (default: broll/)
stock: [pixabay]                                   # stock sites to try (default: pexels, pixabay; those with a key)
```

| key | meaning |
|---|---|
| `at` | a phrase (first match in the edited video), output seconds, or `{line: n}` |
| `to` | phrase or seconds where it ends; otherwise `dur` (default: the phrase + 0.4 s, at least 2 s) |
| `q` / `src` / `clip` | what to show (see above) |
| `from` | start this many seconds into the clip |
| `layout` | `full` (default) or `split` (speaker top half, B-roll bottom half) |
| `audio` | B-roll sound volume, 0..1 (default 0, muted) |
| `fit` | `cover` (default) or `blur` |

`tags.yaml` example: `IMG_2034.MOV: new floor tiles being laid in a motel room`.
`tags.yaml` example: `IMG_2034.MOV: new floor tiles being laid in a motel room`.

## Text callouts, flashes, sound

```yaml
texts:
  - { at: 0, text: "-$50,000", style: red, count: 1, dur: 3.5 }   # counts up over 1 s
  - { at: "Monday", text: "MONDAY", style: yellow, y: top }
flash:
  - { at: "shitty lawyer", color: "#ff0000", dur: 0.15, alpha: 0.4 }
music: { src: music/beat.mp3, volume: 0.12, duck: true }   # ducks under speech
sfx:
  - { at: "boom", src: sfx/whoosh.wav, volume: 0.8 }
```

Text styles: `red`, `white`, `yellow`, `green`. Positions: `top`, `upper`, `center`,
`lower`, `bottom`, or a 0..1 number.

## Picture and sound

| key | default | meaning |
|---|---|---|
| `zoom` | `1.1` | punch-in on every other cut, hides jump cuts (`1` or `false` = off) |
| `focus` | `0.35` | where punch-ins and crops aim, 0 top .. 1 bottom |
| `fit` | `cover` | non-vertical footage: `cover` (crop) or `blur` (fit on a blurred fill) |
| `grade` | none | `punchy`, `warm`, `cool`, `film`, `bw`, a `.cube` LUT path, or `{contrast, saturation, brightness, gamma}` |
| `audio` | | `{ loudness: -14, enhance: true, denoise: false }`; `enhance` = high-pass, gentle compression, presence |
| `quality` | `high` | `draft` (fast preview), `high`, `max` |
| `encoder` | `auto` | `x264`, `videotoolbox` (Mac, auto there), `nvenc` |
| `name` | source id | output file name (without .mp4) |

HDR iPhone footage (HLG / Dolby Vision) is tone-mapped to SDR automatically.

## Looks

A look is a YAML file of defaults. Built in: `white`, `orange`, `green`, `getknown` (in
`presets/`). Make your own (`mybrand.yaml` next to the batch) and `use: mybrand`.

## Errors

`reel plan` reports problems per video with the fix, e.g.
`broll[1] "new flors": "new flors" isn't in the edited video (closest: "new floors")` or
`videos[0]: unknown key "brol" (did you mean "broll"?)`. A video with errors is skipped;
the rest of the batch still renders.
