"""Cover image generation for auto-playlists."""
from io import BytesIO
import base64
from PIL import Image

# Spotify green — same brand color that signals "music-related"
AUTO_PLAYLIST_COVER_COLOR = "#1DB954"


def generate_auto_playlist_cover() -> bytes:
    """Generate a 640x640 solid-color JPEG cover for auto-playlists.

    Returns base64-encoded JPEG bytes, the format spotipy's
    playlist_upload_cover_image() expects. A simple solid-color cover keeps
    all auto-playlists visually identical — easy to spot in the library.
    Future iterations can add text or graphics.
    """
    img = Image.new("RGB", (640, 640), color=AUTO_PLAYLIST_COVER_COLOR)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue())
