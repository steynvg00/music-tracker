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
    BadgeAwardCollector,
    award_special_badge_to_collector,
    send_badge_digest_mail,
    detect_streak_badges,
    detect_daily_intensity_badges,
    detect_release_timing_badges,
    detect_comeback_badges,
    detect_late_bloomer_badges,   # v0.74: A1 — decoupled from the plays_50 gate
    detect_on_repeat_badges,      # v0.74: A4
)
from lib.artist_badges import (   # v0.74: Part B — artist badges piggyback the same cron
    award_artist_badge_to_collector,
    detect_artist_play_milestones,
    detect_artist_distinct_tracks_milestones,
    detect_artist_streaks,
    detect_rediscovery_badges,
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

                # v0.73: Recently Added Tracks maintenance — piggybacks on the
                # 30-min cron after play-milestone detection and before special
                # badge detection. Non-fatal: a failure here must never fail the
                # ingest cron. Sends no mail (matches v0.72 quiet-cron convention).
                try:
                    from lib.spotify import get_spotify_client
                    from lib.recently_added_manager import manage_recently_added_tracks
                    sp = get_spotify_client()
                    summary = manage_recently_added_tracks(sp, conn)
                    if summary.get("playlist_found"):
                        print(
                            f"[recently-added] Managed {summary['total_tracks_in_playlist']} tracks: "
                            f"purged {summary['purged_count']}, auto-liked {summary['liked_added_count']}.",
                            flush=True,
                        )
                except Exception as e:
                    print(f"WARNING: recently added tracks management failed: {e}", file=sys.stderr)

                # v0.67.2: ingest-driven special badges — streaks / daily intensity /
                # release timing / comeback. Batch-scoped for the same blast-radius safety
                # as the play-milestone detection above. Instead of one mail per crossing
                # (5-10/day flood), badges are awarded silently and coalesced into a single
                # end-of-run digest. Silent badges (played_on_day_one) are still inserted but
                # excluded from the digest by the collector.
                collector = BadgeAwardCollector()
                for detector_fn in (
                    detect_streak_badges,
                    detect_daily_intensity_badges,
                    detect_release_timing_badges,
                    detect_comeback_badges,
                    detect_late_bloomer_badges,   # v0.74: A1 standalone (was plays_50-gated)
                    detect_on_repeat_badges,       # v0.74: A4
                ):
                    for track_uri, badge_type, context in detector_fn(conn, batch_track_uris):
                        award_special_badge_to_collector(conn, collector, track_uri, badge_type, context)

                # v0.74: artist badges — resolve the batch's credited artist_ids from
                # track_metadata, then run the artist detectors (each evaluates over the
                # artist's FULL history, scoped to just these artists for blast-radius
                # safety). Coalesced into the same digest via the shared collector.
                batch_artist_ids: set[str] = set()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT DISTINCT unnest(artist_ids) FROM track_metadata "
                        "WHERE track_uri = ANY(%s) AND artist_ids IS NOT NULL",
                        (batch_track_uris,),
                    )
                    batch_artist_ids = {row[0] for row in cur.fetchall() if row[0]}

                if batch_artist_ids:
                    artist_ids_list = list(batch_artist_ids)
                    for artist_detector in (
                        detect_artist_play_milestones,
                        detect_artist_distinct_tracks_milestones,
                        detect_artist_streaks,
                        detect_rediscovery_badges,
                    ):
                        for artist_id, badge_type, context in artist_detector(conn, artist_ids_list):
                            award_artist_badge_to_collector(conn, collector, artist_id, badge_type, context)

                if collector.has_awards():
                    n_awards = len(collector.awards) + len(collector.artist_awards)
                    if send_badge_digest_mail(conn, collector):
                        print(f"Sent badge digest with {n_awards} awards.", flush=True)
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
