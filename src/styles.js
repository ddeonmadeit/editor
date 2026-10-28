// Caption looks, measured from the reference edits. Sizes are px on the 1080x1920 frame,
// y is the vertical centre as a fraction of the height. Fonts are the static faces in fonts/.
export const CAPTION_STYLES = {
  // "This motel in Parkes..." / "I lost 50K...": white bold italic, soft drop shadow, mid-frame.
  white: {
    font: "Arimo Bold Italic",
    size: 130,
    color: "#ffffff",
    stroke: 0,
    shadow: { x: 4, y: 6, blur: 9, color: "#000000", alpha: 0.65 },
    y: 0.5,
    words: 3,
    chars: 16,
    highlight: "#ffd60a",
  },
  // "Being a master of one thing...": orange bold italic with a dark brown edge.
  orange: {
    font: "Arimo Bold Italic",
    size: 120,
    color: "#ff9412",
    stroke: 5,
    strokeColor: "#2b1100",
    shadow: { x: 2, y: 4, blur: 4, color: "#000000", alpha: 0.55 },
    y: 0.6,
    words: 3,
    chars: 16,
    highlight: "#ffffff",
  },
  // "Australia's best boxer...": condensed caps, pale mint fill, green stroke, dark rim.
  green: {
    font: "Anton",
    size: 148,
    color: "#f2fff3",
    stroke: 7,
    strokeColor: "#1fbf4a",
    outer: 3,
    outerColor: "#08391a",
    shadow: { x: 0, y: 4, blur: 6, color: "#000000", alpha: 0.45 },
    case: "upper",
    y: 0.565,
    words: 2,
    chars: 14,
    highlight: "#ffe600",
  },
  // TikTok-native look: TikTok Sans Black, white with a black stroke.
  tiktok: {
    font: "TikTok Sans Black",
    size: 110,
    color: "#ffffff",
    stroke: 8,
    strokeColor: "#000000",
    shadow: null,
    y: 0.62,
    words: 3,
    chars: 18,
    highlight: "#fe2c55",
  },
  // Big bold caps with the spoken word lit up (karaoke).
  bold: {
    font: "Montserrat Black Italic",
    size: 112,
    color: "#ffffff",
    stroke: 6,
    strokeColor: "#000000",
    shadow: { x: 0, y: 5, blur: 4, color: "#000000", alpha: 0.5 },
    case: "upper",
    y: 0.6,
    words: 3,
    chars: 16,
    active: "#ffd60a",
    highlight: "#ffd60a",
  },
};

// Looks for on-screen text callouts (`texts:` in a batch), e.g. the red money counter.
export const TEXT_STYLES = {
  red: { font: "Inter Black", size: 136, color: "#ff2222", stroke: 5, strokeColor: "#4a0000", shadow: { x: 0, y: 5, blur: 6, color: "#000000", alpha: 0.5 } },
  white: { font: "Inter Black", size: 124, color: "#ffffff", stroke: 5, strokeColor: "#000000", shadow: { x: 0, y: 5, blur: 6, color: "#000000", alpha: 0.5 } },
  yellow: { font: "Inter Black", size: 124, color: "#ffd60a", stroke: 5, strokeColor: "#000000", shadow: { x: 0, y: 5, blur: 6, color: "#000000", alpha: 0.5 } },
  green: { font: "Anton", size: 160, color: "#effff0", stroke: 5, strokeColor: "#1fbf4a", outer: 3, outerColor: "#08391a", shadow: null },
};

export const POSITIONS = { top: 0.13, upper: 0.3, center: 0.5, middle: 0.5, lower: 0.68, bottom: 0.8 };

export function captionStyle(c) {
  const base = CAPTION_STYLES[c.style || "white"];
  if (!base) throw new Error(`captions.style "${c.style}" unknown (have: ${Object.keys(CAPTION_STYLES).join(", ")})`);
  const s = { ...base };
  for (const k of ["font", "size", "color", "stroke", "strokeColor", "outer", "outerColor", "case", "words", "chars", "highlight", "active", "pop"]) if (c[k] !== undefined) s[k] = c[k];
  if (c.shadow === false || c.shadow === null) s.shadow = null;
  else if (c.shadow && typeof c.shadow === "object") s.shadow = { ...(base.shadow || { x: 3, y: 4, blur: 6, color: "#000000", alpha: 0.6 }), ...c.shadow };
  if (c.y !== undefined) s.y = typeof c.y === "string" ? POSITIONS[c.y] ?? base.y : c.y;
  return s;
}
