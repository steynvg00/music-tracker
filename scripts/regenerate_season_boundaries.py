"""Regenerate the SEASON_BOUNDARIES table in lib/seasons.py.

The season boundaries are hardcoded in lib/seasons.py so the module has no runtime
dependency. This helper recomputes them from pyephem (authoritative equinox/solstice
instants) and prints a ready-to-paste Python dict literal in Europe/Amsterdam local
dates. Run it if you ever want to extend the range past 2040.

pyephem is NOT a project dependency — run this via uv's ephemeral env:

    uv run --with ephem python scripts/regenerate_season_boundaries.py
    uv run --with ephem python scripts/regenerate_season_boundaries.py --start 2015 --end 2050

Then paste the output over SEASON_BOUNDARIES and re-run `python lib/seasons.py` to
re-verify the 4 anchor cases.

NOTE: astral (the module suggested in the v0.64 spec) does not compute equinoxes/
solstices; pyephem does, so we use pyephem instead.
"""

import argparse
from datetime import timezone
from zoneinfo import ZoneInfo

_AMS = ZoneInfo("Europe/Amsterdam")


def _local_date(ephem_date):
    dt = ephem_date.datetime().replace(tzinfo=timezone.utc).astimezone(_AMS)
    return dt.date()


def main() -> None:
    import ephem  # imported here so the file at least parses without the dep

    parser = argparse.ArgumentParser(description="Regenerate SEASON_BOUNDARIES for lib/seasons.py")
    parser.add_argument("--start", type=int, default=2015)
    parser.add_argument("--end", type=int, default=2040)
    args = parser.parse_args()

    print("SEASON_BOUNDARIES: dict[int, dict[str, date]] = {")
    for year in range(args.start, args.end + 1):
        vernal = _local_date(ephem.next_equinox(f"{year}/1/1"))    # March equinox
        summer = _local_date(ephem.next_solstice(f"{year}/4/1"))   # June solstice
        autumnal = _local_date(ephem.next_equinox(f"{year}/7/1"))  # September equinox
        winter = _local_date(ephem.next_solstice(f"{year}/10/1"))  # December solstice
        print(
            f'    {year}: {{"vernal": date({year}, {vernal.month}, {vernal.day}), '
            f'"summer": date({year}, {summer.month}, {summer.day}), '
            f'"autumnal": date({year}, {autumnal.month}, {autumnal.day}), '
            f'"winter": date({year}, {winter.month}, {winter.day})}},'
        )
    print("}")


if __name__ == "__main__":
    main()
