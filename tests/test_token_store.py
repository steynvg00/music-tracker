import base64
from datetime import datetime, timezone

import pytest

from lib import token_store as ts
from tests.conftest import FakeConn, load_fixture

V = load_fixture("token_vector.json")
KEY = base64.b64decode(V["key_b64"])


def test_shared_vector_decrypts():
    # Same blob the hub's crypto.ts produces (hub/src/lib/server/crypto.test.ts).
    assert ts.decrypt(bytes.fromhex(V["blob_hex"]), KEY, V["aad"].encode()) == V["plaintext"]


def test_encrypt_with_fixed_iv_matches_vector():
    blob = ts.encrypt(V["plaintext"], KEY, V["aad"].encode(), iv=bytes.fromhex(V["iv_hex"]))
    assert blob.hex() == V["blob_hex"]


def test_roundtrip_random_iv_differs_each_time():
    a = ts.encrypt("tok", KEY, b"rotor:hub:refresh_token")
    b = ts.encrypt("tok", KEY, b"rotor:hub:refresh_token")
    assert a != b
    assert ts.decrypt(a, KEY, b"rotor:hub:refresh_token") == "tok"


def test_aad_binds_row_and_field():
    blob = ts.encrypt("tok", KEY, ts.aad_for("hub", "refresh_token"))
    with pytest.raises(ts.TokenStoreError):
        ts.decrypt(blob, KEY, ts.aad_for("cron", "refresh_token"))


def test_tampered_blob_and_wrong_key_fail():
    blob = bytearray(bytes.fromhex(V["blob_hex"]))
    blob[20] ^= 0x01
    with pytest.raises(ts.TokenStoreError):
        ts.decrypt(bytes(blob), KEY, V["aad"].encode())
    with pytest.raises(ts.TokenStoreError):
        ts.decrypt(bytes.fromhex(V["blob_hex"]), bytes(32), V["aad"].encode())
    with pytest.raises(ts.TokenStoreError):
        ts.decrypt(b"\x02" + bytes(40), KEY, V["aad"].encode())


def test_parse_key_variants():
    assert ts.parse_key(None) is None
    assert ts.parse_key("  ") is None
    assert ts.parse_key(V["key_b64"]) == KEY
    urlsafe = base64.urlsafe_b64encode(bytes([250] * 32)).decode().rstrip("=")
    assert ts.parse_key(urlsafe) == bytes([250] * 32)
    with pytest.raises(ts.TokenStoreError):
        ts.parse_key(base64.b64encode(bytes(16)).decode())
    with pytest.raises(ts.TokenStoreError):
        ts.parse_key("not base64 !!")


def test_load_token_decrypts_row():
    authorized = datetime(2026, 11, 3, tzinfo=timezone.utc)
    blob = ts.encrypt("refresh-1", KEY, ts.aad_for("cron", "refresh_token"))
    conn = FakeConn(lambda sql, p: [("owner", "cron-app", blob, "a b", authorized, None)])
    tok = ts.load_token(conn, "cron", KEY)
    assert tok.refresh_token == "refresh-1"
    assert tok.spotify_client_id == "cron-app"
    assert tok.authorized_at == authorized
    assert FakeConn(lambda s, p: []).cursor() is not None
    assert ts.load_token(FakeConn(lambda s, p: []), "cron", KEY) is None


def test_record_refresh_never_moves_authorized_at():
    conn = FakeConn()
    ts.record_refresh(conn, "cron", KEY, "rotated")
    ts.record_refresh(conn, "cron", KEY, None)
    for sql, _ in conn.executed:
        assert "authorized_at" not in sql
    sql, params = conn.executed[0]
    assert "refresh_token_enc" in sql
    assert ts.decrypt(params[0], KEY, ts.aad_for("cron", "refresh_token")) == "rotated"
    assert "refresh_token_enc" not in conn.executed[1][0]
    assert conn.commits == 2
