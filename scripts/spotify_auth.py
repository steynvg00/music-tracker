"""Spotify OAuth dance — prints the refresh token for manual paste into .env and the secrets.

Spotify refresh tokens expire 6 months after the authorization that created them
(refreshing access tokens does not extend that), so this has to be re-run twice a year.
See docs/cron-setup.md.
"""

import os
from datetime import date, timedelta

from dotenv import load_dotenv
import spotipy.oauth2
from spotipy.cache_handler import MemoryCacheHandler

load_dotenv()

SPOTIFY_SCOPES = (
    "playlist-modify-public "
    "playlist-modify-private "
    "playlist-read-private "
    "user-library-read "
    "user-library-modify "  # Recently Added auto-like (lib/recently_added_manager.py)
    "user-top-read "
    "user-read-recently-played "
    "user-follow-read "
    "playlist-read-collaborative"  # playlist mirror lists collaborative playlists (v0.81)
)
# Keep in sync with CRON_SCOPES in hub/src/lib/server/spotify/oauth.ts: Rotor's
# "Connect crons" mints the same token through the hub (option A, v0.81).

REFRESH_TOKEN_LIFETIME = timedelta(days=182)  # Spotify: 6 months from authorization

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

    # In-memory cache + show_dialog: always a fresh authorization. With the default
    # file cache, spotipy would hand back the token already in .cache whenever its
    # scopes still match — the same refresh token, with its 6-month clock still running.
    auth_manager = spotipy.oauth2.SpotifyOAuth(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=REDIRECT_URI,
        scope=SPOTIFY_SCOPES,
        open_browser=True,
        show_dialog=True,
        cache_handler=MemoryCacheHandler(),
    )

    token_info = auth_manager.get_access_token(as_dict=True)
    refresh_token = token_info["refresh_token"]
    authorized_on = date.today()

    print()
    print("  ✅ Authorization successful.")
    print()
    print("  Put this value in .env and the GitHub Actions secret SPOTIFY_REFRESH_TOKEN")
    print("  (see docs/cron-setup.md):")
    print()
    print(f"  SPOTIFY_REFRESH_TOKEN={refresh_token}")
    print()
    print(f"  Authorized on {authorized_on}. This token stops working around")
    print(f"  {authorized_on + REFRESH_TOKEN_LIFETIME}; re-run this script before then.")


if __name__ == "__main__":
    main()
