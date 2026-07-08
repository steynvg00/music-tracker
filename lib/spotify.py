import os
import sys
import time

from dotenv import load_dotenv
import spotipy
import spotipy.oauth2

from scripts.spotify_auth import REDIRECT_URI, SPOTIFY_SCOPES

load_dotenv()

# Rate-limit sleep between /me/tracks batches, matching the existing convention
# used elsewhere for Spotify batch loops.
_LIKED_BATCH_SLEEP_S = 0.5

# Max track ids per Liked Songs batch call. The classic /me/tracks endpoints
# allow 50, but this spotipy version routes to the newer me/library/contains
# and me/library endpoints, which reject >~44 uris ("Too many uris requested").
# 40 is a safe round batch below that boundary — verified against the API.
_LIKED_BATCH_SIZE = 40


def get_spotify_client() -> spotipy.Spotify:
    client_id = os.environ.get("SPOTIFY_CLIENT_ID", "")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    refresh_token = os.environ.get("SPOTIFY_REFRESH_TOKEN", "")

    missing = [
        name
        for name, val in [
            ("SPOTIFY_CLIENT_ID", client_id),
            ("SPOTIFY_CLIENT_SECRET", client_secret),
            ("SPOTIFY_REFRESH_TOKEN", refresh_token),
        ]
        if not val
    ]
    if missing:
        raise RuntimeError(
            f"Missing Spotify env vars: {', '.join(missing)}. "
            "Run `uv run python scripts/spotify_auth.py` to mint a refresh token, "
            "then paste SPOTIFY_REFRESH_TOKEN into .env."
        )

    print("[spotify] Building OAuth client...", flush=True)
    auth_manager = spotipy.oauth2.SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=REDIRECT_URI,
        scope=SPOTIFY_SCOPES,
        cache_path=None,
    )
    print("[spotify] Refreshing access token...", flush=True)
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
