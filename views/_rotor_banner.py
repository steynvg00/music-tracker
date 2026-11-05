"""One-line "Moved to Rotor" banner for every Streamlit page (v0.83, R3: Streamlit goes read-only).

ROTOR_URL (env / Streamlit secret) points at the hub; default is the production deploy.
"""
import os

import streamlit as st

DEFAULT_ROTOR_URL = "https://rotor-steel.vercel.app"


def rotor_url(path: str = "") -> str:
    base = (os.environ.get("ROTOR_URL") or DEFAULT_ROTOR_URL).rstrip("/")
    return f"{base}{path}"


def rotor_banner(what: str, path: str) -> None:
    """e.g. rotor_banner("Stats", "/stats") → ℹ️ Moved to Rotor: Stats live at …/stats. This page is read-only."""
    st.info(f"**Moved to Rotor:** {what} now live in [Rotor]({rotor_url(path)}). This page is read-only.", icon="➡️")
