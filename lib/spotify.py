import os

from dotenv import load_dotenv
import spotipy
import spotipy.oauth2

from scripts.spotify_auth import REDIRECT_URI, SPOTIFY_SCOPES

load_dotenv()


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
