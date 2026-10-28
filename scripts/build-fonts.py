"""Builds the static caption fonts in fonts/ from Google Fonts variable fonts.

libass (ffmpeg's subtitle renderer) can't pick a weight out of a variable font, so each
caption face is cut as its own static font with its own family name ("Arimo Bold Italic"),
which caption styles then name directly with no bold/italic flags.

  pip install fonttools
  python3 scripts/build-fonts.py <dir with the downloaded variable fonts>

Sources (all SIL OFL 1.1), from https://github.com/google/fonts:
  ofl/arimo/Arimo-Italic[wght].ttf
  ofl/inter/Inter-Italic[opsz,wght].ttf, ofl/inter/Inter[opsz,wght].ttf
  ofl/montserrat/Montserrat-Italic[wght].ttf, ofl/montserrat/Montserrat[wght].ttf
  ofl/tiktoksans/TikTokSans[opsz,slnt,wdth,wght].ttf
  ofl/anton/Anton-Regular.ttf, ofl/bebasneue/BebasNeue-Regular.ttf (static already, copied as is)
"""
import shutil
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
OUT = Path(__file__).resolve().parent.parent / "fonts"

# (output file, source file, axis location, family name)
CUTS = [
    ("Arimo-BoldItalic.ttf", "Arimo-Italic[wght].ttf", {"wght": 700}, "Arimo Bold Italic"),
    ("Inter-ExtraBoldItalic.ttf", "Inter-Italic[opsz,wght].ttf", {"wght": 800, "opsz": 32}, "Inter ExtraBold Italic"),
    ("Inter-Black.ttf", "Inter[opsz,wght].ttf", {"wght": 900, "opsz": 32}, "Inter Black"),
    ("Montserrat-ExtraBoldItalic.ttf", "Montserrat-Italic[wght].ttf", {"wght": 800}, "Montserrat ExtraBold Italic"),
    ("Montserrat-BlackItalic.ttf", "Montserrat-Italic[wght].ttf", {"wght": 900}, "Montserrat Black Italic"),
    ("Montserrat-ExtraBold.ttf", "Montserrat[wght].ttf", {"wght": 800}, "Montserrat ExtraBold"),
    ("TikTokSans-Bold.ttf", "TikTokSans[opsz,slnt,wdth,wght].ttf", {"wght": 700, "opsz": 36, "wdth": 100, "slnt": 0}, "TikTok Sans Bold"),
    ("TikTokSans-Black.ttf", "TikTokSans[opsz,slnt,wdth,wght].ttf", {"wght": 900, "opsz": 36, "wdth": 100, "slnt": 0}, "TikTok Sans Black"),
]
COPY = ["Anton-Regular.ttf", "BebasNeue-Regular.ttf"]


def rename(font, family):
    ps = family.replace(" ", "-")
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    for nid, value in ((1, family), (2, "Regular"), (3, f"{ps};reel"), (4, family), (6, ps)):
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)
    font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0b1100001) | 0b1000000  # REGULAR only
    font["head"].macStyle = 0


def main():
    OUT.mkdir(exist_ok=True)
    for out, src, loc, family in CUTS:
        font = instantiateVariableFont(TTFont(SRC / src), loc, updateFontNames=False)
        rename(font, family)
        font.save(OUT / out)
        print("built", out)
    for f in COPY:
        shutil.copy(SRC / f, OUT / f)
        print("copied", f)


if __name__ == "__main__":
    main()
