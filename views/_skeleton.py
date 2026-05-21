"""Skeleton loading-state helpers for Stats tabs.

Call inject_skeleton_css() once at app startup (app.py), then use
skeleton_* helpers or the skeleton_placeholder context manager in views.
"""

from contextlib import contextmanager

import streamlit as st

_CSS = """
<style>
@keyframes skeleton-shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position:  200% 0; }
}
.skeleton {
    background: linear-gradient(90deg, #e8e8e8 25%, #f5f5f5 50%, #e8e8e8 75%);
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.5s linear infinite;
    border-radius: 4px;
}
.skeleton-metric      { height: 80px; }
.skeleton-chart       { height: 320px; }
.skeleton-table       { height: 400px; }
.skeleton-line        { height: 16px; width: 60%; margin: 8px 0; }
.skeleton-line-short  { height: 16px; width: 30%; }
.skeleton-line-long   { height: 16px; width: 90%; }
@media (prefers-color-scheme: dark) {
    .skeleton {
        background: linear-gradient(90deg, #2a2a2a 25%, #3a3a3a 50%, #2a2a2a 75%);
        background-size: 200% 100%;
    }
}
</style>
"""


def inject_skeleton_css() -> None:
    """Inject shimmer CSS once per page load. Call from app.py before st.navigation()."""
    st.markdown(_CSS, unsafe_allow_html=True)


def skeleton_metric() -> None:
    st.markdown('<div class="skeleton skeleton-metric"></div>', unsafe_allow_html=True)


def skeleton_chart() -> None:
    st.markdown('<div class="skeleton skeleton-chart"></div>', unsafe_allow_html=True)


def skeleton_table(rows: int = 8) -> None:
    st.markdown('<div class="skeleton skeleton-table"></div>', unsafe_allow_html=True)


def skeleton_lines(n: int = 3) -> None:
    widths = ["60%", "90%", "30%"]
    html = "".join(
        f'<div class="skeleton skeleton-line" style="width:{widths[i % 3]}"></div>'
        for i in range(n)
    )
    st.markdown(html, unsafe_allow_html=True)


def skeleton_metric_row(n: int = 3) -> None:
    """N metric-sized skeleton boxes laid out in a single row of columns."""
    cols = st.columns(n)
    for col in cols:
        with col:
            skeleton_metric()


_SHAPE_FNS = {
    "metric":     skeleton_metric,
    "chart":      skeleton_chart,
    "table":      skeleton_table,
    "lines":      skeleton_lines,
    "metric_row": skeleton_metric_row,
}


@contextmanager
def skeleton_placeholder(*shapes: str):
    """Render skeleton shapes inside an st.empty() placeholder, yield the placeholder.

    Usage:
        with skeleton_placeholder("chart") as ph:
            data = heavy_query()
        ph.empty()
        st.line_chart(data)

    Accepted shape strings: "metric", "chart", "table", "lines", "metric_row".
    """
    ph = st.empty()
    with ph.container():
        for shape in shapes:
            fn = _SHAPE_FNS.get(shape)
            if fn:
                fn()
    yield ph
