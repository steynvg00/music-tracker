"""Playlist Rules page — read-only overview of what each playlist CATEGORY selects.

Inspection tool, not a control panel: no writes, no Spotify calls, no refresh buttons.
All data comes from lib.playlists.describe_playlist_categories(), which is pure data and
carries no Streamlit dependency — the rendering here is the throwaway half.
"""

import pandas as pd
import streamlit as st

from lib.db import get_connection
from lib.playlists import describe_playlist_categories

_KIND_LABEL = {
    "updating": "🔄 updating",
    "snapshot": "📸 snapshot",
}

st.header("Playlist Rules")
st.caption(
    "Per categorie: wat de selectieregel is en hoe vaak hij verschijnt. "
    "Ruim 200 beheerde playlists, maar maar een handvol regels — deze pagina groepeert op "
    "regel, niet op playlist. Alleen-lezen: hier valt niets aan te zetten of te verversen."
)

conn = get_connection()


@st.cache_data(ttl=600)
def _load_categories():
    return describe_playlist_categories(conn)


categories = _load_categories()


def _schedule_text(cat) -> str:
    """One-line schedule, framed per kind: frequency vs. next creation moment."""
    if cat.schedule_kind == "none":
        return f"⚠️ {cat.schedule_nl}"
    if cat.schedule_kind == "next_creation":
        return cat.schedule_nl
    return cat.schedule_nl


# ── Overzicht ─────────────────────────────────────────────────────────────────

total_playlists = sum(c.playlist_count for c in categories)
col_a, col_b, col_c = st.columns(3)
col_a.metric("Categorieën", len(categories))
col_b.metric("Beheerde playlists", total_playlists)
col_c.metric(
    "Zonder cron",
    sum(1 for c in categories if c.schedule_kind == "none"),
    help="Categorieën die door geen enkele cron worden aangeraakt.",
)

summary_df = pd.DataFrame([
    {
        "Categorie": c.name,
        "Soort": _KIND_LABEL.get(c.kind, c.kind),
        "Playlists": c.playlist_count,
        "Ververst / aangemaakt": _schedule_text(c),
    }
    for c in categories
])
st.dataframe(summary_df, hide_index=True, width="stretch")

st.divider()

# ── Per categorie ─────────────────────────────────────────────────────────────

for cat in categories:
    with st.container(border=True):
        head_left, head_right = st.columns([5, 2])
        with head_left:
            st.subheader(cat.name)
            if cat.name_form:
                st.caption(f"Op Spotify: `{cat.name_form}`")
        with head_right:
            st.markdown(f"**{_KIND_LABEL.get(cat.kind, cat.kind)}**")
            st.markdown(
                f"**{cat.playlist_count}** "
                f"{'playlist' if cat.playlist_count == 1 else 'playlists'}"
            )

        if cat.rule_nl:
            st.markdown(f"**Regel** — {cat.rule_nl}")

        # Snapshots are written once and never rewritten, so a refresh frequency is the
        # wrong frame for them: show when the NEXT one appears instead.
        if cat.schedule_kind == "none":
            st.warning(f"**Schema** — {cat.schedule_nl}", icon="⚠️")
        elif cat.schedule_kind == "next_creation":
            st.markdown(f"**Wordt aangemaakt** — {cat.schedule_nl}")
            if cat.next_creation_nl:
                st.markdown(f"**Eerstvolgende** — {cat.next_creation_nl}")
        else:
            st.markdown(f"**Ververst** — {cat.schedule_nl}")

        if cat.cron:
            st.caption(
                f"Cron `{cat.cron}` · job `{cat.cron_job}` · `{cat.cron_script}`"
            )

        if cat.member_variation:
            st.markdown(f"**Leden verschillen** — {cat.member_variation}")

        if cat.variants:
            variants_df = pd.DataFrame([
                {
                    "Playlist": v.label,
                    "Wat er verschilt": v.rule_param or "—",
                    "Volledige naam op Spotify": v.full_name,
                }
                for v in cat.variants
            ])
            st.dataframe(variants_df, hide_index=True, width="stretch")
        elif cat.example_names:
            st.caption("Voorbeelden: " + " · ".join(f"`{n}`" for n in cat.example_names))

        if cat.notes:
            st.info(cat.notes, icon="ℹ️")

        with st.expander("Ruwe query-source", expanded=False):
            st.caption(
                "De regel hierboven is met de hand geschreven en is dus een tweede bron van "
                "waarheid. Staat hij niet meer naast de code hieronder, dan is een van de twee "
                f"achtergebleven. Bron: `{cat.source}`."
            )
            if not cat.query_sources:
                st.caption("Geen query-source beschikbaar voor deze categorie.")
            for qs in cat.query_sources:
                st.markdown(f"`{qs.function}`")
                if qs.source:
                    st.code(qs.source, language="python")
                else:
                    st.caption(f"Source niet op te halen: {qs.error}")
