"""v0.94: scripts/migrate_media_storage.py + lib/media_storage.py against in-process fake S3 servers.

No real storage is contacted: two local fakes (source + destination) on 127.0.0.1, each checking the
SigV4 Authorization header and that x-amz-content-sha256 matches the body.
"""

from __future__ import annotations

import hashlib
import importlib.util
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from lib.media_storage import Backend, S3Client, sign_headers

ROOT = Path(__file__).resolve().parents[1]


def load_script():
    spec = importlib.util.spec_from_file_location("migrate_media_storage", ROOT / "scripts" / "migrate_media_storage.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeS3:
    def __init__(self, bucket: str, corrupt: bool = False):
        self.bucket = bucket
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.writes: list[str] = []
        self.corrupt = corrupt
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _key(self):
                p = unquote(urlsplit(self.path).path)
                pre = f"/s3/{fake.bucket}"
                assert p.startswith(pre), p
                return p[len(pre) + 1 :]

            def _auth(self, body: bytes) -> bool:
                a = self.headers.get("Authorization", "")
                ok = a.startswith("AWS4-HMAC-SHA256 Credential=ak/") and "SignedHeaders=" in a and "Signature=" in a
                return ok and self.headers.get("x-amz-content-sha256") == hashlib.sha256(body).hexdigest()

            def _send(self, code, body=b"", ctype="application/xml", extra=None):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def do_GET(self):
                if not self._auth(b""):
                    return self._send(403, b"<Error><Code>AccessDenied</Code></Error>")
                key = self._key()
                q = parse_qs(urlsplit(self.path).query)
                if not key and q.get("list-type") == ["2"]:
                    pre = q.get("prefix", [""])[0]
                    items = "".join(f"<Contents><Key>{k}</Key><Size>{len(v[0])}</Size></Contents>" for k, v in sorted(fake.objects.items()) if k.startswith(pre))
                    return self._send(200, f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>{items}</ListBucketResult>'.encode())
                if key not in fake.objects:
                    return self._send(404, b"<Error><Code>NoSuchKey</Code></Error>")
                body, ctype = fake.objects[key]
                self._send(200, body, ctype)

            def do_HEAD(self):
                key = self._key()
                if key not in fake.objects:
                    return self._send(404)
                body, ctype = fake.objects[key]
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Type", ctype)
                self.end_headers()

            def do_PUT(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n)
                if not self._auth(body):
                    return self._send(403, b"<Error><Code>SignatureDoesNotMatch</Code></Error>")
                key = self._key()
                if fake.corrupt:
                    body = body[:-1] + bytes([body[-1] ^ 0xFF])
                fake.objects[key] = (body, self.headers.get("Content-Type", "application/octet-stream"))
                fake.writes.append(key)
                self._send(200, b"", extra={"ETag": '"x"'})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def backend(self) -> Backend:
        host, port = self.server.server_address[:2]
        return Backend(endpoint=f"http://{host}:{port}/s3", region="eu-central-1", bucket=self.bucket, access_key="ak", secret_key="sk", label="fake")

    def close(self):
        self.server.shutdown()


@pytest.fixture
def pair():
    src, dst = FakeS3("old"), FakeS3("new")
    src.objects["tracks/0b0c2c1e-6a58-4b1f-9d7e-1f2a3b4c5d6e.mp3"] = (b"A" * 300_000, "audio/mpeg")
    src.objects["sets/1b0c2c1e-6a58-4b1f-9d7e-1f2a3b4c5d6e.flac"] = (bytes(range(256)) * 4000, "audio/flac")
    src.objects["covers/2b0c2c1e-6a58-4b1f-9d7e-1f2a3b4c5d6e.jpg"] = (b"\xff\xd8jpeg", "image/jpeg")
    src.objects["other/ignored.txt"] = (b"not ours", "text/plain")
    yield src, dst
    src.close()
    dst.close()


def test_import_has_no_side_effects():
    mod = load_script()
    assert hasattr(mod, "main") and hasattr(mod, "migrate")


def test_sigv4_matches_aws_documented_example():
    h = sign_headers(
        "GET",
        "https://examplebucket.s3.amazonaws.com/test.txt",
        "us-east-1",
        "AKIAIOSFODNN7EXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        headers={"range": "bytes=0-9"},
        now=datetime(2013, 5, 24, tzinfo=timezone.utc),
    )
    assert h["authorization"].endswith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")


def test_dry_run_copies_nothing(pair):
    """V094-12: the default run only reports."""
    src, dst = pair
    out: list[str] = []
    code = load_script().migrate(S3Client(src.backend), S3Client(dst.backend), execute=False, out=out.append)
    assert code == 0
    assert dst.writes == [] and dst.objects == {}
    text = "\n".join(out)
    assert "To copy: 3 object(s)" in text and "DRY RUN" in text
    assert "other/ignored.txt" not in text


def test_execute_copies_and_verifies_checksums(pair):
    src, dst = pair
    out: list[str] = []
    code = load_script().migrate(S3Client(src.backend), S3Client(dst.backend), execute=True, out=out.append)
    assert code == 0, out
    for k in ("tracks/0b0c2c1e-6a58-4b1f-9d7e-1f2a3b4c5d6e.mp3", "sets/1b0c2c1e-6a58-4b1f-9d7e-1f2a3b4c5d6e.flac", "covers/2b0c2c1e-6a58-4b1f-9d7e-1f2a3b4c5d6e.jpg"):
        assert hashlib.sha256(dst.objects[k][0]).digest() == hashlib.sha256(src.objects[k][0]).digest()
        assert dst.objects[k][1] == src.objects[k][1]
    # Re-run: nothing new to copy, existing objects re-verified, source untouched.
    out2: list[str] = []
    assert load_script().migrate(S3Client(src.backend), S3Client(dst.backend), execute=True, out=out2.append) == 0
    assert "To copy: 0 object(s)" in "\n".join(out2)
    assert len(dst.writes) == 3 and src.writes == []


def test_corrupted_destination_fails(pair):
    src, _ = pair
    bad = FakeS3("bad", corrupt=True)
    try:
        out: list[str] = []
        code = load_script().migrate(S3Client(src.backend), S3Client(bad.backend), execute=True, out=out.append)
        assert code == 1
        assert "checksum mismatch" in "\n".join(out) and "NOT safe to switch" in "\n".join(out)
    finally:
        bad.close()


def test_main_refuses_without_destination(monkeypatch, capsys):
    mod = load_script()
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: None)
    for n in ("ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"):
        monkeypatch.setenv(f"MEDIA_S3_{n}", "x" if n != "ENDPOINT" else "http://127.0.0.1:9/s3")
        monkeypatch.delenv(f"DEST_MEDIA_S3_{n}", raising=False)
    assert mod.main([]) == 2
    assert "DEST_MEDIA_S3_ENDPOINT" in capsys.readouterr().err
