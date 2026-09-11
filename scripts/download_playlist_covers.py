"""Download alle playlist-covers van het eigen account naar cover_backup/."""
import json, pathlib, re, sys
import requests
import lib.spotify as S

sp = None
for name in ("get_spotify_client", "get_client", "get_spotify", "spotify_client", "client"):
    fn = getattr(S, name, None)
    if callable(fn):
        sp = fn()
        break
if sp is None:
    sys.exit("Geen client-factory gevonden in lib/spotify.py. Beschikbaar: "
             + ", ".join(n for n in dir(S) if not n.startswith("_")))

OUT = pathlib.Path("cover_backup")
(OUT / "custom").mkdir(parents=True, exist_ok=True)
(OUT / "mosaic").mkdir(parents=True, exist_ok=True)

me = sp.me()["id"]
items, res = [], sp.current_user_playlists(limit=50)
while res:
    items.extend(res["items"])
    res = sp.next(res) if res.get("next") else None

def slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")[:80] or "untitled"

MANAGED = ("· Auto 🤖🔄", "· Auto 🤖📸", "· Custom 🎧")
manifest, n_custom, n_mosaic = [], 0, 0

for pl in items:
    if not pl or pl["owner"]["id"] != me:
        continue
    imgs = pl.get("images") or []
    if not imgs:
        continue
    img = max(imgs, key=lambda i: (i.get("width") or 0))
    url = img["url"]
    kind = "mosaic" if ("mosaic." in url or "spotifycdn.com" in url) else "custom"
    managed = any(pl["name"].endswith(s) for s in MANAGED)
    fname = f"{slug(pl['name'])}__{pl['id']}.jpg"
    path = OUT / kind / fname
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        path.write_bytes(r.content)
    except Exception as e:
        print(f"  FOUT {pl['name']}: {e}")
        continue
    n_custom += kind == "custom"
    n_mosaic += kind == "mosaic"
    manifest.append({
        "name": pl["name"], "id": pl["id"], "kind": kind, "managed": managed,
        "url": url, "width": img.get("width"), "height": img.get("height"),
        "bytes": len(r.content), "file": str(path),
    })

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
print(f"\n{len(manifest)} covers opgeslagen — {n_custom} eigen upload, {n_mosaic} mozaïek")
print(f"Eigen uploads staan in {OUT / 'custom'}")
