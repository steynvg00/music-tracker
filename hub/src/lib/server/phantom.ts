/**
 * Phantom plays (R8, Settings › Data health › Phantom plays): plays whose track Spotify no longer
 * describes. The population is exactly Streamlit's (`views/_stats_phantom_plays.py`):
 *
 *   track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL
 *
 * That also catches podcast episodes and audiobook chapters (they have no track fields either);
 * Streamlit counts them, so Rotor does too, and says how many of them are episodes/chapters.
 * Dates are Europe/Amsterdam, like Streamlit. Each listed play links to the identified track
 * played just before and just after it, the only clue to what it was.
 */
import type { Queryable } from '$lib/server/db';

export const PHANTOM_WHERE_SQL = 'track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL';
export const PHANTOM_PAGE = 30;
export const PHANTOM_MAX = 300;

export interface Neighbour {
	uri: string;
	name: string | null;
	artist: string | null;
	at: string;
}

export interface PhantomPlay {
	playedAt: string;
	platform: string;
	reasonEnd: string;
	msPlayed: number | null;
	/** Podcast episode / audiobook chapter title when Spotify sent one (still in Streamlit's population). */
	media: string | null;
	before: Neighbour | null;
	after: Neighbour | null;
}

export interface PhantomPayload {
	total: number;
	earliest: string | null; // YYYY-MM-DD, Amsterdam
	latest: string | null;
	platforms: string[];
	episodes: number;
	byMonth: { month: string; count: number }[]; // YYYY-MM
	byPlatform: { platform: string; count: number }[];
	byReasonEnd: { reasonEnd: string; count: number }[];
	recent: PhantomPlay[];
	limit: number;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export async function phantomSummary(sql: Queryable): Promise<{ count: number; latestAt: string | null }> {
	const [r] = await sql<{ n: number; latest: Date | null }[]>`
		SELECT count(*)::int AS n, max(played_at) AS latest FROM spotify_plays
		WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL`;
	return { count: r?.n ?? 0, latestAt: r?.latest ? iso(r.latest) : null };
}

export async function phantomPayload(sql: Queryable, limit = PHANTOM_PAGE): Promise<PhantomPayload> {
	const n = Math.max(1, Math.min(PHANTOM_MAX, Math.floor(limit) || PHANTOM_PAGE));
	const [[sum], byMonth, byPlatform, byReason, recent] = await Promise.all([
		sql<{ total: number; earliest: string | null; latest: string | null; platforms: string[] | null; episodes: number }[]>`
			SELECT count(*)::int AS total,
			       to_char(min(played_at AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM-DD') AS earliest,
			       to_char(max(played_at AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM-DD') AS latest,
			       array_agg(DISTINCT coalesce(platform, '(null)') ORDER BY coalesce(platform, '(null)')) AS platforms,
			       count(*) FILTER (WHERE episode_uri IS NOT NULL OR audiobook_chapter_uri IS NOT NULL)::int AS episodes
			FROM spotify_plays
			WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL`,
		sql<{ month: string; count: number }[]>`
			SELECT to_char(date_trunc('month', played_at AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM') AS month, count(*)::int AS count
			FROM spotify_plays
			WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL
			GROUP BY 1 ORDER BY 1`,
		sql<{ platform: string; count: number }[]>`
			SELECT coalesce(platform, '(null)') AS platform, count(*)::int AS count
			FROM spotify_plays
			WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL
			GROUP BY 1 ORDER BY 2 DESC, 1`,
		sql<{ reason_end: string; count: number }[]>`
			SELECT coalesce(reason_end, '(null)') AS reason_end, count(*)::int AS count
			FROM spotify_plays
			WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL
			GROUP BY 1 ORDER BY 2 DESC, 1`,
		sql<{
			played_at: Date;
			platform: string;
			reason_end: string;
			ms_played: number | null;
			media: string | null;
			b_uri: string | null;
			b_name: string | null;
			b_artist: string | null;
			b_at: Date | null;
			a_uri: string | null;
			a_name: string | null;
			a_artist: string | null;
			a_at: Date | null;
		}[]>`
			SELECT p.played_at, coalesce(p.platform, '(null)') AS platform, coalesce(p.reason_end, '(null)') AS reason_end,
			       p.ms_played, coalesce(p.episode_name, p.audiobook_chapter_title) AS media,
			       b.track_uri AS b_uri, b.track_name AS b_name, b.artist_name AS b_artist, b.played_at AS b_at,
			       a.track_uri AS a_uri, a.track_name AS a_name, a.artist_name AS a_artist, a.played_at AS a_at
			FROM (
				SELECT * FROM spotify_plays
				WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL
				ORDER BY played_at DESC LIMIT ${n}
			) p
			LEFT JOIN LATERAL (
				SELECT track_uri, track_name, artist_name, played_at FROM spotify_plays s
				WHERE s.played_at < p.played_at AND s.played_at > p.played_at - interval '1 day' AND s.track_uri IS NOT NULL
				ORDER BY s.played_at DESC LIMIT 1
			) b ON true
			LEFT JOIN LATERAL (
				SELECT track_uri, track_name, artist_name, played_at FROM spotify_plays s
				WHERE s.played_at > p.played_at AND s.played_at < p.played_at + interval '1 day' AND s.track_uri IS NOT NULL
				ORDER BY s.played_at ASC LIMIT 1
			) a ON true
			ORDER BY p.played_at DESC`
	]);
	const nb = (uri: string | null, name: string | null, artist: string | null, at: Date | null): Neighbour | null =>
		uri && at ? { uri, name, artist, at: iso(at) } : null;
	return {
		total: sum?.total ?? 0,
		earliest: sum?.earliest ?? null,
		latest: sum?.latest ?? null,
		platforms: sum?.total ? (sum.platforms ?? []) : [],
		episodes: sum?.episodes ?? 0,
		byMonth,
		byPlatform,
		byReasonEnd: byReason.map((r) => ({ reasonEnd: r.reason_end, count: r.count })),
		recent: recent.map((r) => ({
			playedAt: iso(r.played_at),
			platform: r.platform,
			reasonEnd: r.reason_end,
			msPlayed: r.ms_played,
			media: r.media,
			before: nb(r.b_uri, r.b_name, r.b_artist, r.b_at),
			after: nb(r.a_uri, r.a_name, r.a_artist, r.a_at)
		})),
		limit: n
	};
}
