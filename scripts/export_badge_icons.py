"""Export the badge PNGs (assets/badges, 1024 px) as small icons for the Rotor hub (v0.83, R3).

  uv run python scripts/export_badge_icons.py

Writes hub/static/badges/<same name>.png at 96 px, 128-colour palette (~10 kB each), so the
service worker's precache stays small. Re-run after adding or changing a badge image; the
name map lives in hub/src/lib/shared/stats.ts (BADGE_ICONS, same as lib/badges.BADGE_ICONS).
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "badges"
DST = ROOT / "hub" / "static" / "badges"


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    total = 0
    for p in sorted(SRC.glob("*.png")):
        im = Image.open(p).convert("RGBA")
        im.thumbnail((96, 96), Image.LANCZOS)
        out = DST / p.name
        im.quantize(colors=128, method=Image.Quantize.FASTOCTREE).save(out, optimize=True)
        total += out.stat().st_size
    print(f"Exported {len(list(SRC.glob('*.png')))} icons, {total // 1024} kB → {DST}")


if __name__ == "__main__":
    main()
