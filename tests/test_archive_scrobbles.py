"""v0.90: scripts/archive_scrobbles.py — file checksums, read-back verification, safety rails.

No database here (the E2E run exercises the real COPY against a throwaway Postgres, see
hub/e2e/tests/v090.spec.ts). Importing the module must have no side effects.
"""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load():
    spec = importlib.util.spec_from_file_location("archive_scrobbles", ROOT / "scripts" / "archive_scrobbles.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # must not connect, parse argv or touch files
    return mod


CSV = (
    "id,track_id,played_at,source,ms_played,reason_start,reason_end,shuffle,created_at\n"
    "1,10,2019-03-01 12:00:00+00,lastfm,,,,,2025-08-01 10:00:00.5+00\n"
    "2,11,2019-03-01 12:03:30.25+00,spotify_extended,200000,clickrow,trackdone,t,2025-08-01 10:00:00.5+00\n"
    "5,10,2020-01-01 00:00:00+00,lastfm,1000,,fwdbtn,f,2025-08-01 10:00:01+00\n"
)


def test_import_has_no_side_effects():
    m = load()
    assert callable(m.main) and m.COLUMNS[0] == "id"


def test_checksums_from_csv_match_the_sql_definitions():
    import io

    m = load()
    c = m.checksums_from_csv(io.StringIO(CSV, newline=""))
    assert c["rows"] == 3
    assert c["sum_id"] == 8 and c["min_id"] == 1 and c["max_id"] == 5
    assert c["sum_track_id"] == 31
    assert c["sum_ms_played"] == 201000 and c["n_ms_played"] == 2
    assert c["n_shuffle_true"] == 1 and c["n_shuffle_false"] == 1
    assert c["len_source"] == len("lastfm") * 2 + len("spotify_extended")
    assert c["len_reason_end"] == len("trackdone") + len("fwdbtn")
    # microseconds since the epoch, exact (fractional seconds included)
    assert c["sum_played_us"] == (1551441600 + 1551441810) * 1_000_000 + 250_000 + 1577836800 * 1_000_000


def test_read_back_hashes_the_decompressed_csv(tmp_path: Path):
    m = load()
    p = tmp_path / "x.csv.gz"
    with gzip.open(p, "wb") as f:
        f.write(CSV.encode())
    sums, sha = m.read_back(p)
    assert sums["rows"] == 3
    assert sha == hashlib.sha256(CSV.encode()).hexdigest()


def test_compare_reports_every_mismatch():
    m = load()
    assert m.compare({"rows": 3, "sum_id": 8}, {"rows": 3, "sum_id": 8}) == []
    out = m.compare({"rows": 4, "sum_id": 8}, {"rows": 3, "sum_id": 9})
    assert len(out) == 2 and "rows" in out[0]


def test_verify_detects_a_tampered_archive(tmp_path: Path, capsys):
    import io

    m = load()
    p = tmp_path / "scrobbles_20261107T000000Z.csv.gz"
    with gzip.open(p, "wb") as f:
        f.write(CSV.encode())
    sums = m.checksums_from_csv(io.StringIO(CSV, newline=""))
    manifest = {"checksums": sums, "sha256_csv": hashlib.sha256(CSV.encode()).hexdigest(), "sha256_gz": m.sha256_file(p)}
    (tmp_path / "scrobbles_20261107T000000Z.manifest.json").write_text(json.dumps(manifest))
    assert m.verify(None, p) == 0
    with gzip.open(p, "wb") as f:  # one row edited
        f.write(CSV.replace("1,10,2019", "1,12,2019").encode())
    assert m.verify(None, p) == 2
    assert "NOT VERIFIED" in capsys.readouterr().err


def test_refuses_an_output_folder_inside_the_repo(tmp_path: Path, capsys):
    m = load()
    assert m.main(["--out-dir", str(ROOT / "tmp-archive"), "--db", "postgresql://nobody@127.0.0.1:1/none"]) == 1
    assert "inside the git repository" in capsys.readouterr().err
    assert not (ROOT / "tmp-archive").exists()


def test_never_drops_anything():
    import re

    src = (ROOT / "scripts" / "archive_scrobbles.py").read_text()
    body = src.split('"""', 2)[2]  # skip the module docstring, which explains 0033
    sql_write = re.compile(r"\b(DROP\s+(TABLE|INDEX|VIEW)|DELETE\s+FROM|TRUNCATE\b|ALTER\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET)", re.I)
    assert not sql_write.search(body)
    assert "READ ONLY" in body
