import os
import sys
import time

from dotenv import load_dotenv
import spotipy
import spotipy.oauth2

from lib import token_store
from lib.db import get_connection
from scripts.spotify_auth import REDIRECT_URI

load_dotenv()

# Rate-limit sleep between /me/tracks batches, matching the existing convention
# used elsewhere for Spotify batch loops.
_LIKED_BATCH_SLEEP_S = 0.5

# Max track ids per Liked Songs batch call. The classic /me/tracks endpoints
# allow 50, but this spotipy version routes to the newer me/library/contains
# and me/library endpoints, which reject >~44 uris ("Too many uris requested").
# 40 is a safe round batch below that boundary — verified against the API.
_LIKED_BATCH_SIZE = 40


def _refresh_from_hub_store(auth_manager, client_id: str) -> bool:
    """Option A (v0.81): refresh with the 'cron' token Rotor keeps in hub_oauth_tokens.

    Returns True when the access token was refreshed from the DB row. Returns False —
    and the caller falls back to SPOTIFY_REFRESH_TOKEN — when TOKEN_ENC_KEY or
    DATABASE_URL is unset, the row doesn't exist, belongs to another Spotify app, or
    the refresh fails (e.g. invalid_grant after the 6-month expiry; recorded on the row
    so Rotor's Settings › Connections shows it).
    """
    try:
        key = token_store.key_from_env()
    except token_store.TokenStoreError as e:
        print(f"[spotify] WARNING: {e}. Using SPOTIFY_REFRESH_TOKEN.", file=sys.stderr, flush=True)
        return False
    if key is None or not os.environ.get("DATABASE_URL"):
        return False

    try:
        conn = get_connection()
    except Exception as e:
        print(f"[spotify] WARNING: token store unreachable ({e}). Using SPOTIFY_REFRESH_TOKEN.",
              file=sys.stderr, flush=True)
        return False
    try:
        try:
            stored = token_store.load_token(conn, "cron", key)
        except Exception as e:  # missing table (0019 not applied), bad blob, wrong key
            conn.rollback()
            print(f"[spotify] WARNING: can't read the cron token from hub_oauth_tokens ({e}). "
                  "Using SPOTIFY_REFRESH_TOKEN.", file=sys.stderr, flush=True)
            return False
        if stored is None:
            return False
        if stored.spotify_client_id != client_id:
            print("[spotify] WARNING: hub_oauth_tokens 'cron' row was minted for another Spotify "
                  "app than SPOTIFY_CLIENT_ID. Using SPOTIFY_REFRESH_TOKEN.", file=sys.stderr, flush=True)
            return False

        print(f"[spotify] Refreshing access token (hub_oauth_tokens, authorized "
              f"{stored.authorized_at:%Y-%m-%d})...", flush=True)
        try:
            info = auth_manager.refresh_access_token(stored.refresh_token)
        except spotipy.oauth2.SpotifyOauthError as e:
            reason = getattr(e, "error", None) or str(e)
            token_store.record_error(conn, "cron", str(reason))
            print(f"[spotify] WARNING: stored cron token refused ({reason}). Reconnect the crons "
                  "in Rotor › Settings. Trying SPOTIFY_REFRESH_TOKEN.", file=sys.stderr, flush=True)
            return False

        rotated = (info or {}).get("refresh_token")
        token_store.record_refresh(
            conn, "cron", key, rotated if rotated and rotated != stored.refresh_token else None
        )
        return True
    finally:
        conn.close()


def get_spotify_client() -> spotipy.Spotify:
    client_id = os.environ.get("SPOTIFY_CLIENT_ID", "")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    refresh_token = os.environ.get("SPOTIFY_REFRESH_TOKEN", "")

    missing = [
        name
        for name, val in [
            ("SPOTIFY_CLIENT_ID", client_id),
            ("SPOTIFY_CLIENT_SECRET", client_secret),
        ]
        if not val
    ]
    if missing:
        raise RuntimeError(
            f"Missing Spotify env vars: {', '.join(missing)}. "
            "Create an app at https://developer.spotify.com/dashboard and put its ID/secret in .env."
        )

    print("[spotify] Building OAuth client...", flush=True)
    # No scope here on purpose. A refresh never sends scopes; spotipy only uses this
    # value to check the cached token, and when the token lacks a requested scope it
    # silently falls back to the interactive browser login, which crashes on a CI
    # runner. The scopes a token has are fixed when scripts/spotify_auth.py mints it.
    auth_manager = spotipy.oauth2.SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=REDIRECT_URI,
        cache_path=None,
    )
    if not _refresh_from_hub_store(auth_manager, client_id):
        if not refresh_token:
            raise RuntimeError(
                "No usable Spotify refresh token: hub_oauth_tokens has no 'cron' row (or "
                "TOKEN_ENC_KEY is unset) and SPOTIFY_REFRESH_TOKEN is empty. Connect the crons "
                "in Rotor › Settings, or run `uv run python scripts/spotify_auth.py` and paste "
                "SPOTIFY_REFRESH_TOKEN into .env."
            )
        print("[spotify] Refreshing access token (SPOTIFY_REFRESH_TOKEN)...", flush=True)
        auth_manager.refresh_access_token(refresh_token)
    print("[spotify] Access token refreshed.", flush=True)

    print("[spotify] Creating Spotify client...", flush=True)
    return spotipy.Spotify(auth_manager=auth_manager, requests_timeout=30)


def check_liked_songs_batch(sp, track_ids: list[str]) -> dict[str, bool]:
    """Check per track_id whether it is in the user's Liked Songs.

    Uses the /me/tracks/contains endpoint (max 50 ids per call).
    Returns: {track_id: True/False}

    Non-fatal on API errors — logs a warning and returns partial results.
    """
    result: dict[str, bool] = {}
    ids = [tid for tid in track_ids if tid]
    for i in range(0, len(ids), _LIKED_BATCH_SIZE):
        batch = ids[i : i + _LIKED_BATCH_SIZE]
        try:
            flags = sp.current_user_saved_tracks_contains(tracks=batch)
        except Exception as e:
            print(
                f"WARNING: check_liked_songs_batch failed for batch at offset {i}: {e}",
                file=sys.stderr,
            )
            continue
        for tid, flag in zip(batch, flags or []):
            result[tid] = bool(flag)
        if i + _LIKED_BATCH_SIZE < len(ids):
            time.sleep(_LIKED_BATCH_SLEEP_S)
    return result


def add_to_liked_songs_batch(sp, track_ids: list[str]) -> int:
    """Add tracks to the user's Liked Songs via PUT /me/tracks (max 50 per call).

    Returns: the number of tracks successfully added.

    Non-fatal on API errors — logs a warning; failed tracks retry next cron cycle.
    """
    added = 0
    ids = [tid for tid in track_ids if tid]
    for i in range(0, len(ids), _LIKED_BATCH_SIZE):
        batch = ids[i : i + _LIKED_BATCH_SIZE]
        try:
            sp.current_user_saved_tracks_add(tracks=batch)
            added += len(batch)
        except Exception as e:
            print(
                f"WARNING: add_to_liked_songs_batch failed for batch at offset {i}: {e}",
                file=sys.stderr,
            )
            continue
        if i + _LIKED_BATCH_SIZE < len(ids):
            time.sleep(_LIKED_BATCH_SLEEP_S)
    return added
