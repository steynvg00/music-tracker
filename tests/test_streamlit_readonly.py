"""R3 (v0.83): Streamlit is read-only. Its pages carry a "Moved to Rotor" banner, and the playlist
page no longer writes to Spotify or the database (create / extend / keep / delete / rebuild /
order moved to Rotor)."""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WRITERS = {
    "create_temp_playlist",
    "delete_custom_playlist",
    "request_force_refresh",
    "upsert_order_pref",
    "get_spotify_client",
}


def _names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            out.add(node.id)
        elif isinstance(node, ast.Attribute):
            out.add(node.attr)
        elif isinstance(node, ast.alias):
            out.add(node.asname or node.name)
    return out


def test_playlist_page_has_no_write_paths():
    src = (ROOT / "views" / "playlist_modification.py").read_text()
    names = _names(ROOT / "views" / "playlist_modification.py")
    assert not (names & WRITERS), names & WRITERS
    assert "psycopg.connect" not in src and "write_conn" not in src
    assert "UPDATE custom_playlists" not in src


def test_every_page_has_the_rotor_banner():
    for page in ("stats.py", "playlist_modification.py", "playlist_rules.py"):
        assert "rotor_banner(" in (ROOT / "views" / page).read_text(), page
