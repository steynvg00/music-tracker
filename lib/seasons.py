"""Astronomical season boundaries for Europe/Amsterdam, 2015-2040.

Pure-Python, no runtime dependencies. The SEASON_BOUNDARIES table below was
generated from pyephem (equinox/solstice instants, converted to Europe/Amsterdam
local dates) and hardcoded here — see scripts/regenerate_season_boundaries.py to
regenerate or extend the range. Verified against 4 known anchor cases in the
__main__ block; run `python lib/seasons.py` to check.

Season-year semantics: a "season year" is the year the season STARTS, except the
year fragment for winter is displayed spanning two years. So winter 2025 starts
in December 2025 and runs into March 2026, displayed as "2025/2026".
"""

from datetime import date, timedelta
from typing import Literal

SeasonName = Literal["spring", "summer", "autumn", "winter"]

MIN_YEAR = 2015
MAX_YEAR = 2040

# Maps the public SeasonName onto the astronomical event key in SEASON_BOUNDARIES.
_BOUNDARY_KEY: dict[str, str] = {
    "spring": "vernal",
    "summer": "summer",
    "autumn": "autumnal",
    "winter": "winter",
}

# The season that follows each one, and whether it rolls into the next year.
_NEXT_SEASON: dict[str, tuple[str, int]] = {
    "spring": ("summer", 0),
    "summer": ("autumn", 0),
    "autumn": ("winter", 0),
    "winter": ("spring", 1),
}

# Season boundaries in Europe/Amsterdam local dates.
# Format: {year: {"vernal": date, "summer": date, "autumnal": date, "winter": date}}
SEASON_BOUNDARIES: dict[int, dict[str, date]] = {
    2015: {"vernal": date(2015, 3, 20), "summer": date(2015, 6, 21), "autumnal": date(2015, 9, 23), "winter": date(2015, 12, 22)},
    2016: {"vernal": date(2016, 3, 20), "summer": date(2016, 6, 21), "autumnal": date(2016, 9, 22), "winter": date(2016, 12, 21)},
    2017: {"vernal": date(2017, 3, 20), "summer": date(2017, 6, 21), "autumnal": date(2017, 9, 22), "winter": date(2017, 12, 21)},
    2018: {"vernal": date(2018, 3, 20), "summer": date(2018, 6, 21), "autumnal": date(2018, 9, 23), "winter": date(2018, 12, 21)},
    2019: {"vernal": date(2019, 3, 20), "summer": date(2019, 6, 21), "autumnal": date(2019, 9, 23), "winter": date(2019, 12, 22)},
    2020: {"vernal": date(2020, 3, 20), "summer": date(2020, 6, 20), "autumnal": date(2020, 9, 22), "winter": date(2020, 12, 21)},
    2021: {"vernal": date(2021, 3, 20), "summer": date(2021, 6, 21), "autumnal": date(2021, 9, 22), "winter": date(2021, 12, 21)},
    2022: {"vernal": date(2022, 3, 20), "summer": date(2022, 6, 21), "autumnal": date(2022, 9, 23), "winter": date(2022, 12, 21)},
    2023: {"vernal": date(2023, 3, 20), "summer": date(2023, 6, 21), "autumnal": date(2023, 9, 23), "winter": date(2023, 12, 22)},
    2024: {"vernal": date(2024, 3, 20), "summer": date(2024, 6, 20), "autumnal": date(2024, 9, 22), "winter": date(2024, 12, 21)},
    2025: {"vernal": date(2025, 3, 20), "summer": date(2025, 6, 21), "autumnal": date(2025, 9, 22), "winter": date(2025, 12, 21)},
    2026: {"vernal": date(2026, 3, 20), "summer": date(2026, 6, 21), "autumnal": date(2026, 9, 23), "winter": date(2026, 12, 21)},
    2027: {"vernal": date(2027, 3, 20), "summer": date(2027, 6, 21), "autumnal": date(2027, 9, 23), "winter": date(2027, 12, 22)},
    2028: {"vernal": date(2028, 3, 20), "summer": date(2028, 6, 20), "autumnal": date(2028, 9, 22), "winter": date(2028, 12, 21)},
    2029: {"vernal": date(2029, 3, 20), "summer": date(2029, 6, 21), "autumnal": date(2029, 9, 22), "winter": date(2029, 12, 21)},
    2030: {"vernal": date(2030, 3, 20), "summer": date(2030, 6, 21), "autumnal": date(2030, 9, 23), "winter": date(2030, 12, 21)},
    2031: {"vernal": date(2031, 3, 20), "summer": date(2031, 6, 21), "autumnal": date(2031, 9, 23), "winter": date(2031, 12, 22)},
    2032: {"vernal": date(2032, 3, 20), "summer": date(2032, 6, 20), "autumnal": date(2032, 9, 22), "winter": date(2032, 12, 21)},
    2033: {"vernal": date(2033, 3, 20), "summer": date(2033, 6, 21), "autumnal": date(2033, 9, 22), "winter": date(2033, 12, 21)},
    2034: {"vernal": date(2034, 3, 20), "summer": date(2034, 6, 21), "autumnal": date(2034, 9, 23), "winter": date(2034, 12, 21)},
    2035: {"vernal": date(2035, 3, 20), "summer": date(2035, 6, 21), "autumnal": date(2035, 9, 23), "winter": date(2035, 12, 22)},
    2036: {"vernal": date(2036, 3, 20), "summer": date(2036, 6, 20), "autumnal": date(2036, 9, 22), "winter": date(2036, 12, 21)},
    2037: {"vernal": date(2037, 3, 20), "summer": date(2037, 6, 21), "autumnal": date(2037, 9, 22), "winter": date(2037, 12, 21)},
    2038: {"vernal": date(2038, 3, 20), "summer": date(2038, 6, 21), "autumnal": date(2038, 9, 23), "winter": date(2038, 12, 21)},
    2039: {"vernal": date(2039, 3, 20), "summer": date(2039, 6, 21), "autumnal": date(2039, 9, 23), "winter": date(2039, 12, 22)},
    2040: {"vernal": date(2040, 3, 20), "summer": date(2040, 6, 20), "autumnal": date(2040, 9, 22), "winter": date(2040, 12, 21)},
}

_DUTCH_MONTH_ABBREV = [
    "jan", "feb", "mrt", "apr", "mei", "jun",
    "jul", "aug", "sep", "okt", "nov", "dec",
]


def season_start(season: SeasonName, year: int) -> date:
    """Returns the exact date the season starts (equinox/solstice).

    For 'winter' with year=2025, returns 2025-12-21 (winter 2025/2026 starts in Dec 2025).
    Raises ValueError if year is outside 2015-2040 range.
    """
    if year < MIN_YEAR or year > MAX_YEAR:
        raise ValueError(f"year {year} outside supported range {MIN_YEAR}-{MAX_YEAR}")
    if season not in _BOUNDARY_KEY:
        raise ValueError(f"unknown season {season!r}")
    return SEASON_BOUNDARIES[year][_BOUNDARY_KEY[season]]


def season_end(season: SeasonName, year: int) -> date:
    """Returns the last day OF the season (day before the next season starts).

    Spring 2025 ends on the day before Summer 2025 starts, so 2025-06-20.
    Winter 2025/2026 ends on 2026-03-19 (day before Vernal 2026).
    """
    next_season, year_delta = _NEXT_SEASON[season]
    season_start(season, year)  # validates this season's year is in range
    return season_start(next_season, year + year_delta) - timedelta(days=1)


def season_display_year(season: SeasonName, year: int) -> str:
    """Returns the year fragment for display:
    - 'spring'/'summer'/'autumn' → str(year), e.g. '2025'
    - 'winter' → f'{year}/{year+1}', e.g. '2025/2026'
    """
    if season == "winter":
        return f"{year}/{year + 1}"
    return str(year)


def format_season_dutch_short(d: date) -> str:
    """Format a date as Dutch short-form: '21 dec 2025', '20 mrt 2026'.

    Month abbrevs: jan feb mrt apr mei jun jul aug sep okt nov dec.
    """
    return f"{d.day} {_DUTCH_MONTH_ABBREV[d.month - 1]} {d.year}"


def get_season_containing(d: date) -> tuple[SeasonName, int]:
    """Returns which season the given date falls into, and the season's start year.

    Examples:
    - date(2025, 4, 15) → ('spring', 2025)
    - date(2026, 1, 10) → ('winter', 2025)  # still in winter 2025/2026
    - date(2025, 12, 25) → ('winter', 2025)

    Raises ValueError if date is outside supported range (before 2015 spring or after
    2040 winter).
    """
    y = d.year
    boundaries = SEASON_BOUNDARIES.get(y)
    if boundaries is not None:
        if d >= boundaries["winter"]:
            return ("winter", y)
        if d >= boundaries["autumnal"]:
            return ("autumn", y)
        if d >= boundaries["summer"]:
            return ("summer", y)
        if d >= boundaries["vernal"]:
            return ("spring", y)
        # Before this year's vernal equinox → tail of the previous winter.
        if (y - 1) >= MIN_YEAR:
            return ("winter", y - 1)
    raise ValueError(
        f"date {d.isoformat()} outside supported range (spring {MIN_YEAR} .. winter {MAX_YEAR})"
    )


def build_season_description(
    playlist_kind_prefix: str,  # e.g. "Top 25 tracks"
    season: SeasonName,
    year: int,
    created_on: date,
) -> str:
    """Returns the full description string in Dutch.

    Example return:
        "Top 25 tracks voor Winter 2025/2026 (21 dec 2025 – 20 mrt 2026). Gemaakt op 21 mrt 2026."

    The displayed date range runs from this season's opening equinox/solstice to the
    NEXT season's opening equinox/solstice (event-to-event), so the closing date is
    one day later than season_end() — e.g. winter shows the vernal equinox (20 mrt)
    rather than season_end's last-day-in-season (19 mrt).

    Season name in the string: 'Winter' / 'Spring' / 'Summer' / 'Autumn' (capitalized
    English — consistent with the existing playlist naming convention). The en-dash (–)
    between dates is the proper Unicode character U+2013, not a hyphen.
    """
    start = season_start(season, year)
    next_season, year_delta = _NEXT_SEASON[season]
    boundary_close = season_start(next_season, year + year_delta)
    display_year = season_display_year(season, year)
    season_label = season.capitalize()
    return (
        f"{playlist_kind_prefix} voor {season_label} {display_year} "
        f"({format_season_dutch_short(start)} – {format_season_dutch_short(boundary_close)}). "
        f"Gemaakt op {format_season_dutch_short(created_on)}."
    )


if __name__ == "__main__":
    from datetime import date
    assert season_start("winter", 2024) == date(2024, 12, 21), "Winter solstice 2024 mismatch"
    assert season_start("spring", 2025) == date(2025, 3, 20), "Vernal equinox 2025 mismatch"
    assert season_start("summer", 2025) == date(2025, 6, 21), "Summer solstice 2025 mismatch"
    assert season_start("autumn", 2025) == date(2025, 9, 22), "Autumnal equinox 2025 mismatch"
    print("All 4 astronomical anchor cases PASS.")
