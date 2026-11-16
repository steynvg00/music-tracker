"""Minimal S3-compatible client (v0.94) for scripts/migrate_media_storage.py.

Standard library only (urllib + hashlib/hmac): AWS Signature Version 4 header signing, ListObjectsV2,
HEAD/GET/PUT object. Works with every backend Rotor's hub supports (Supabase Storage's S3 endpoint,
MinIO, Cloudflare R2, AWS S3), path-style by default.

Importing this module has no side effects.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import BinaryIO, Iterator
from xml.etree import ElementTree

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
CHUNK = 1024 * 1024


def _enc(s: str) -> str:
    return urllib.parse.quote(s, safe="-_.~")


def canonical_query(params: list[tuple[str, str]]) -> str:
    return "&".join(f"{k}={v}" for k, v in sorted((_enc(k), _enc(v)) for k, v in params))


def canonical_path(path: str) -> str:
    return "/".join(_enc(urllib.parse.unquote(seg)) for seg in path.split("/"))


def sign_headers(
    method: str,
    url: str,
    region: str,
    access_key: str,
    secret_key: str,
    payload_hash: str = EMPTY_SHA256,
    headers: dict[str, str] | None = None,
    now: datetime | None = None,
    service: str = "s3",
) -> dict[str, str]:
    """SigV4 Authorization header for one request (same algorithm as hub/src/lib/server/storage/sigv4.ts)."""
    now = now or datetime.now(timezone.utc)
    amz = now.strftime("%Y%m%dT%H%M%SZ")
    short = amz[:8]
    u = urllib.parse.urlsplit(url)
    h = {k.lower(): str(v).strip() for k, v in (headers or {}).items()}
    h["host"] = u.netloc
    h["x-amz-date"] = amz
    h["x-amz-content-sha256"] = payload_hash
    names = sorted(h)
    canon_headers = "".join(n + ":" + re.sub(r"\s+", " ", h[n]) + "\n" for n in names)
    signed = ";".join(names)
    query = canonical_query(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
    canonical = "\n".join([method.upper(), canonical_path(u.path), query, canon_headers, signed, payload_hash])
    scope = f"{short}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = f"AWS4{secret_key}".encode()
    for part in (short, region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    out = {k: v for k, v in h.items() if k != "host"}
    out["authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={sig}"
    return out


class StorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class Backend:
    endpoint: str
    region: str
    bucket: str
    access_key: str
    secret_key: str
    path_style: bool = True
    label: str = "s3"

    @classmethod
    def from_env(cls, prefix: str = "MEDIA_S3_", env: dict[str, str] | None = None) -> "Backend":
        e = env if env is not None else os.environ
        need = ["ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]
        missing = [f"{prefix}{n}" for n in need if not e.get(f"{prefix}{n}", "").strip()]
        if missing:
            raise StorageError(f"Missing {', '.join(missing)}")
        return cls(
            endpoint=e[f"{prefix}ENDPOINT"].strip().rstrip("/"),
            region=e[f"{prefix}REGION"].strip(),
            bucket=e[f"{prefix}BUCKET"].strip(),
            access_key=e[f"{prefix}ACCESS_KEY_ID"].strip(),
            secret_key=e[f"{prefix}SECRET_ACCESS_KEY"].strip(),
            path_style=e.get(f"{prefix}PATH_STYLE", "true").strip().lower() != "false",
            label=e.get(prefix.replace("S3_", "STORAGE_") + "BACKEND", "").strip() or "s3",
        )

    def describe(self) -> str:
        """Host + bucket only (never a key)."""
        return f"{self.label} · {urllib.parse.urlsplit(self.endpoint).netloc} · bucket {self.bucket}"


@dataclass(frozen=True)
class ObjectInfo:
    key: str
    size: int


class S3Client:
    def __init__(self, backend: Backend, timeout: float = 60.0):
        self.b = backend
        self.timeout = timeout

    def _url(self, key: str = "", query: list[tuple[str, str]] | None = None) -> str:
        e = urllib.parse.urlsplit(self.b.endpoint)
        base_path = e.path.rstrip("/")
        if self.b.path_style:
            path = f"{base_path}/{self.b.bucket}" + (f"/{key}" if key else "/")
            netloc = e.netloc
        else:
            path = f"{base_path}/{key}"
            netloc = f"{self.b.bucket}.{e.netloc}"
        q = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in (query or []))
        return urllib.parse.urlunsplit((e.scheme, netloc, canonical_path(path), q, ""))

    def _request(self, method: str, url: str, body: BinaryIO | bytes | None = None, payload_hash: str = EMPTY_SHA256, length: int | None = None, headers: dict[str, str] | None = None):
        h = sign_headers(method, url, self.b.region, self.b.access_key, self.b.secret_key, payload_hash, headers)
        if length is not None:
            h["content-length"] = str(length)
        req = urllib.request.Request(url, data=body, method=method, headers=h)
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            if e.code == 404 and method == "HEAD":
                return None
            detail = e.read()[:300].decode("utf-8", "replace") if method != "HEAD" else ""
            raise StorageError(f"{method} {urllib.parse.urlsplit(url).path}: storage answered {e.code} {detail}") from None
        except urllib.error.URLError as e:
            raise StorageError(f"storage unreachable: {e.reason}") from None

    def list_objects(self, prefix: str = "") -> Iterator[ObjectInfo]:
        token = ""
        while True:
            q = [("list-type", "2"), ("max-keys", "1000")]
            if prefix:
                q.append(("prefix", prefix))
            if token:
                q.append(("continuation-token", token))
            with self._request("GET", self._url("", q)) as res:
                root = ElementTree.fromstring(res.read())
            ns = re.match(r"\{.*\}", root.tag)
            p = ns.group(0) if ns else ""
            for c in root.iter(f"{p}Contents"):
                yield ObjectInfo(key=c.findtext(f"{p}Key") or "", size=int(c.findtext(f"{p}Size") or 0))
            if (root.findtext(f"{p}IsTruncated") or "false") != "true":
                return
            token = root.findtext(f"{p}NextContinuationToken") or ""
            if not token:
                return

    def head(self, key: str) -> ObjectInfo | None:
        res = self._request("HEAD", self._url(key))
        if res is None:
            return None
        with res:
            return ObjectInfo(key=key, size=int(res.headers.get("Content-Length") or 0))

    def download(self, key: str, dest: BinaryIO) -> tuple[str, int, str]:
        """Stream an object into `dest`; returns (sha256, size, content type)."""
        sha = hashlib.sha256()
        n = 0
        with self._request("GET", self._url(key)) as res:
            ctype = res.headers.get("Content-Type") or "application/octet-stream"
            while chunk := res.read(CHUNK):
                sha.update(chunk)
                dest.write(chunk)
                n += len(chunk)
        return sha.hexdigest(), n, ctype

    def sha256_of(self, key: str) -> tuple[str, int]:
        with tempfile.TemporaryFile() as t:
            digest, n, _ = self.download(key, t)
        return digest, n

    def upload(self, key: str, src: BinaryIO, size: int, sha256: str, content_type: str) -> None:
        src.seek(0)
        with self._request("PUT", self._url(key), body=src, payload_hash=sha256, length=size, headers={"content-type": content_type}) as res:
            res.read()
