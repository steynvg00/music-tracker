"""Ingest the last 50 Spotify recently-played tracks into spotify_plays."""

import sys
import time

sys.path.insert(0, ".")

from dotenv import load_dotenv
load_dotenv()

from lib.db import get_connection
from lib.spotify_recent import ingest_recent
from lib.badges import (
    process_batch_milestones,
    award_special_badge,
    detect_streak_badges,
    detect_daily_intensity_badges,
    detect_release_timing_badges,
    detect_comeback_badges,
)


def main() -> None:
    print("=== Spotify recently-played ingest ===", flush=True)

    start = time.monotonic()

    try:
        conn = get_connection()
        result = ingest_recent(conn)

        # Badge milestone detection piggy-backs on this ingest. Non-fatal: the
        # plays are already committed above, so a badge/mail failure must never
        # fail the ingest cron.
        try:
            batch_track_uris = list(set(result.get("track_uris", [])))
            if batch_track_uris:
                n_sent = process_batch_milestones(conn, batch_track_uris)
                if n_sent > 0:
                    print(f"Sent {n_sent} milestone mail(s).", flush=True)

                # v0.67: ingest-driven special badges — streaks / daily intensity /
                # release timing / comeback. Batch-scoped for the same blast-radius
                # safety as the play-milestone detection above.
                n_special = 0
                for detector_fn in (
                    detect_streak_badges,
                    detect_daily_intensity_badges,
                    detect_release_timing_badges,
                    detect_comeback_badges,
                ):
                    for track_uri, badge_type, context in detector_fn(conn, batch_track_uris):
                        if award_special_badge(conn, track_uri, badge_type, context, send_mail=True):
                            n_special += 1
                if n_special > 0:
                    print(f"Sent {n_special} special badge mail(s).", flush=True)
        except Exception as e:
            print(
                f"WARNING: Badge milestone detection/notification failed: {e}",
                file=sys.stderr,
            )

        conn.close()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    duration = time.monotonic() - start
    print(
        f"Attempted: {result['attempted']} | "
        f"Inserted: {result['inserted']} | "
        f"Skipped: {result['skipped']} | "
        f"Duration: {duration:.0f}s"
    )


if __name__ == "__main__":
    main()
