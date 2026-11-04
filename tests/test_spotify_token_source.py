"""Option A: lib/spotify.py reads the cron token from hub_oauth_tokens, env var as fallback."""
import base64
from datetime import datetime, timezone

import pytest
import spotipy

import lib.spotify as spotify_mod
from lib import token_store as ts
from tests.conftest import FakeConn

KEY = bytes(range(32))
KEY_B64 = base64.b64encode(KEY).decode()


class FakeOAuth:
    instances: list["FakeOAuth"] = []
    fail_tokens: dict[str, str] = {}
    rotate_to: str | None = None

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.refreshed_with: list[str] = []
        FakeOAuth.instances.append(self)

    def refresh_access_token(self, refresh_token):
        self.refreshed_with.append(refresh_token)
        if refresh_token in FakeOAuth.fail_tokens:
            raise spotipy.oauth2.SpotifyOauthError("bad", error=FakeOAuth.fail_tokens[refresh_token])
        return {"access_token": "at", "refresh_token": FakeOAuth.rotate_to or refresh_token}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    FakeOAuth.instances.clear()
    FakeOAuth.fail_tokens = {}
    FakeOAuth.rotate_to = None
    monkeypatch.setattr(spotify_mod.spotipy.oauth2, "SpotifyOAuth", FakeOAuth)
    monkeypatch.setattr(spotify_mod.spotipy, "Spotify", lambda **kw: ("client", kw))
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "cron-app")
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "secret")
    monkeypatch.setenv("SPOTIFY_REFRESH_TOKEN", "env-token")
    monkeypatch.setenv("TOKEN_ENC_KEY", KEY_B64)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")


def _row(client_id="cron-app", token="db-token"):
    blob = ts.encrypt(token, KEY, ts.aad_for("cron", "refresh_token"))
    return ("owner", client_id, blob, "scopes", datetime(2026, 11, 3, tzinfo=timezone.utc), None)


def _install_db(monkeypatch, rows):
    conn = FakeConn(lambda sql, p: rows if "FROM hub_oauth_tokens" in sql else [])
    monkeypatch.setattr(spotify_mod, "get_connection", lambda: conn)
    return conn


def test_uses_db_token_when_present(monkeypatch):
    conn = _install_db(monkeypatch, [_row()])
    spotify_mod.get_spotify_client()
    assert FakeOAuth.instances[0].refreshed_with == ["db-token"]
    assert conn.sql_matching("SET last_refresh_at = now()")
    assert not conn.sql_matching("refresh_token_enc = %s")
    assert conn.closed


def test_stores_rotated_refresh_token(monkeypatch):
    conn = _install_db(monkeypatch, [_row()])
    FakeOAuth.rotate_to = "db-token-2"
    spotify_mod.get_spotify_client()
    (sql, params), = conn.sql_matching("refresh_token_enc = %s")
    assert ts.decrypt(params[0], KEY, ts.aad_for("cron", "refresh_token")) == "db-token-2"


def test_falls_back_to_env_when_no_row(monkeypatch):
    _install_db(monkeypatch, [])
    spotify_mod.get_spotify_client()
    assert FakeOAuth.instances[0].refreshed_with == ["env-token"]


def test_falls_back_when_key_unset(monkeypatch):
    monkeypatch.delenv("TOKEN_ENC_KEY")
    monkeypatch.setattr(spotify_mod, "get_connection", lambda: pytest.fail("must not touch the DB"))
    spotify_mod.get_spotify_client()
    assert FakeOAuth.instances[0].refreshed_with == ["env-token"]


def test_falls_back_when_row_is_for_another_app(monkeypatch):
    _install_db(monkeypatch, [_row(client_id="hub-app")])
    spotify_mod.get_spotify_client()
    assert FakeOAuth.instances[0].refreshed_with == ["env-token"]


def test_invalid_grant_records_error_and_falls_back(monkeypatch):
    conn = _install_db(monkeypatch, [_row()])
    FakeOAuth.fail_tokens = {"db-token": "invalid_grant"}
    spotify_mod.get_spotify_client()
    assert FakeOAuth.instances[0].refreshed_with == ["db-token", "env-token"]
    (sql, params), = conn.sql_matching("SET last_error = %s")
    assert params[0] == "invalid_grant"


def test_db_unreachable_falls_back(monkeypatch):
    def boom():
        raise OSError("connection refused")
    monkeypatch.setattr(spotify_mod, "get_connection", boom)
    spotify_mod.get_spotify_client()
    assert FakeOAuth.instances[0].refreshed_with == ["env-token"]


def test_missing_table_falls_back(monkeypatch):
    def responder(sql, params):
        raise RuntimeError('relation "hub_oauth_tokens" does not exist')
    conn = FakeConn(responder)
    monkeypatch.setattr(spotify_mod, "get_connection", lambda: conn)
    spotify_mod.get_spotify_client()
    assert FakeOAuth.instances[0].refreshed_with == ["env-token"]
    assert conn.rollbacks == 1


def test_no_token_anywhere_raises(monkeypatch):
    _install_db(monkeypatch, [])
    monkeypatch.delenv("SPOTIFY_REFRESH_TOKEN")
    with pytest.raises(RuntimeError, match="No usable Spotify refresh token"):
        spotify_mod.get_spotify_client()


def test_env_only_still_works_without_db_token(monkeypatch):
    # Today's setup (before Rotor is connected): exactly one refresh with the env token.
    monkeypatch.delenv("TOKEN_ENC_KEY")
    spotify_mod.get_spotify_client()
    assert len(FakeOAuth.instances) == 1
    assert FakeOAuth.instances[0].refreshed_with == ["env-token"]
