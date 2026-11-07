/**
 * "This week" (R8): the Monday digest mail as an in-app page, one week at a time.
 *
 * Stored weeks come from digest_runs (0029), written by the crons' send_digest exactly as the mail
 * renders it. Older weeks are reconstructed from playlist_rank_history: only the rank-tracked Top
 * lists (Top 30 last 30 days, Top 100 this year, Top 100 all-time), with the same arrows.
 */

export type DigestSection = 'created' | 'updated' | 'snapshot';

export interface TrackRef {
	uri: string;
	name: string | null;
	artist: string | null;
}

export interface Arrow {
	label: string; // "★ NEW" | "↑ 3" | "↓ 2" | "—"  (the mail's labels)
	dir: 'new' | 'up' | 'down' | 'same';
}

export interface RankedRef extends TrackRef {
	rank: number;
	prev: number | null;
	plays: number | null;
	arrow: Arrow;
}

export interface DigestPlaylist {
	section: DigestSection;
	name: string;
	kind: string;
	isTop: boolean;
	playlistId: string | null;
	description: string | null;
	addedCount: number;
	added: TrackRef[];
	removed: TrackRef[];
	ranked: RankedRef[];
	/** false → the mail hides the arrow column (no baseline, or nothing moved). */
	arrows: boolean;
}

export interface DigestRun {
	id: number;
	runType: 'weekly' | 'monthly' | 'sweep';
	ranAt: string;
	summary: string;
	eventCount: number;
	delivery: string | null;
	counts: { created: number; updated: number; snapshots: number; deleted: number };
	playlists: DigestPlaylist[];
	deleted: { name: string; expiresAt: string | null; trackCount: number | null }[];
}

export interface DigestWeekRef {
	week: string; // Monday, YYYY-MM-DD (Europe/Amsterdam)
	stored: boolean;
	changed: number | null;
}

export interface DigestPayload {
	week: string;
	weeks: DigestWeekRef[];
	prev: string | null; // older week
	next: string | null; // newer week
	runs: DigestRun[];
	/** Weeks without a stored digest: Top lists rebuilt from rank history (null when there's none). */
	reconstructed: DigestPlaylist[] | null;
	/** false → migration 0029 isn't applied yet; only reconstructed weeks exist. */
	storing: boolean;
	lastWeekly: { ranAt: string; changed: number } | null;
}

/** The mail's rank arrow (lib/email_notify._arrow_for). */
export function arrowFor(rank: number, prev: number | null): Arrow {
	if (prev === null) return { label: '★ NEW', dir: 'new' };
	if (rank < prev) return { label: `↑ ${prev - rank}`, dir: 'up' };
	if (rank > prev) return { label: `↓ ${rank - prev}`, dir: 'down' };
	return { label: '—', dir: 'same' };
}

/** The mail's arrow-column rule (lib/email_notify._should_show_arrows). */
export function showArrows(ranked: { rank: number; prev: number | null }[], hasBaseline: boolean): boolean {
	return hasBaseline && ranked.some((t) => t.prev !== t.rank);
}

export const SECTION_TITLE: Record<DigestSection, string> = {
	created: 'New playlists',
	updated: 'Updated playlists',
	snapshot: 'Snapshots created'
};

export const RUN_LABEL: Record<DigestRun['runType'], string> = {
	weekly: 'Weekly refresh',
	monthly: 'Monthly refresh',
	sweep: 'Custom playlists swept'
};

const DAY = 86_400_000;

/** Monday (YYYY-MM-DD) of the ISO week that contains `date` (YYYY-MM-DD). */
export function mondayOf(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
	return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

export function isWeek(s: string | null): s is string {
	return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && mondayOf(s) === s;
}

/** "Week of 3 Nov 2026" */
export function weekLabel(week: string): string {
	const d = new Date(`${week}T00:00:00Z`);
	return `Week of ${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
}
