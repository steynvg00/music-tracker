"""music-tracker dashboard — multipage Streamlit app."""

import os
import sys
sys.path.insert(0, ".")

import streamlit as st

# Bridge Streamlit Cloud secrets into os.environ so lib.* modules
# (which read from os.environ) work without modification across local,
# GitHub Actions, and Streamlit Cloud.
try:
    for key in ("DATABASE_URL", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN"):
        if key in st.secrets:
            os.environ[key] = st.secrets[key]
except (FileNotFoundError, AttributeError):
    # st.secrets raises FileNotFoundError locally if no secrets.toml exists.
    # That's fine — .env via dotenv (loaded by lib.db) handles local.
    pass

st.set_page_config(page_title="music-tracker", page_icon="🎵", layout="wide")

with st.sidebar:
    if st.button("Refresh data"):
        st.cache_data.clear()
        st.rerun()

stats = st.Page("views/stats.py", title="Stats")
playlists = st.Page("views/playlist_modification.py", title="Playlist Modification")

pg = st.navigation([stats, playlists])
pg.run()
