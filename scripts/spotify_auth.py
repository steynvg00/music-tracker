"""One-time Spotify OAuth dance — prints the refresh token for manual paste into .env."""

import os

from dotenv import load_dotenv
import spotipy.oauth2

load_dotenv()

SPOTIFY_SCOPES = (
    "playlist-modify-public "
    "playlist-modify-private "
    "playlist-read-private "
    "user-library-read "
    "user-top-read "
    "user-read-recently-played"
)

REDIRECT_URI = "http://127.0.0.1:8888/callback"


def main() -> None:
    client_id = os.environ.get("SPOTIFY_CLIENT_ID", "")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "")

    if not client_id or not client_secret:
        raise RuntimeError(
            "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env. "
            "Create an app at https://developer.spotify.com/dashboard and set the "
            f"redirect URI to {REDIRECT_URI}."
        )

    auth_manager = spotipy.oauth2.SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=REDIRECT_URI,
        scope=SPOTIFY_SCOPES,
        open_browser=True,
        cache_path=None,
    )

    token_info = auth_manager.get_access_token(as_dict=True)
    refresh_token = token_info["refresh_token"]

    print()
    print("  ✅ Authorization successful.")
    print()
    print("  Add this line to your .env file:")
    print()
    print(f"  SPOTIFY_REFRESH_TOKEN={refresh_token}")
    print()
    print("  Then re-run any Spotify-related script.")


if __name__ == "__main__":
    main()
