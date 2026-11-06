/**
 * Rotor Wrapped (R6): the payload hub.wrapped_payload() returns (migration 0027) and the pure
 * helpers the story, the Stats year picker and Home share. No server or DOM code here.
 */
import { MANAGED_SUFFIXES } from './managed';

export const WRAPPED_MIN_YEAR = 2017;
export const WRAPPED_VERSION = 1;
export const WRAPPED_MISSING = 'Rotor Wrapped needs migration 0027_wrapped.sql';

export interface WTrack {
	rank?: number;
	track: string;
	artist: string;
	uri: string | null;
	plays: number;
	ms?: number;
	firstDay?: string;
	lastBefore?: string;
	backOn?: string;
	gapDays?: number;
}
export interface WArtist {
	rank?: number;
	artist: string;
	plays: number;
	ms?: number;
	tracks?: number;
	firstDay?: string;
	lastBefore?: string;
	backOn?: string;
	gapDays?: number;
}

export interface WrappedPayload {
	version: number;
	year: number;
	through: string;
	live: boolean;
	generatedAt: string;
	totals: { plays: number; ms: number; days: number; firstDay: string | null; lastDay: string | null; tracks: number; artists: number; noMsPlays: number };
	topTracks: WTrack[];
	topArtists: WArtist[];
	discoveries: { artists: number; tracks: number; topArtists: WArtist[]; topTracks: WTrack[] };
	comebacks: { artists: number; tracks: number; topArtists: WArtist[]; topTracks: WTrack[] };
	streak: { days: number; from: string; to: string } | null;
	biggestDay: { day: string; plays: number; ms: number; top: WTrack | null } | null;
	/** 7 rows (0 = Sunday … 6 = Saturday) × 24 hours of plays. */
	clock: number[][];
	months: { month: number; plays: number; ms: number }[];
	badges: { count: number; byType: Record<string, number>; items: { entityType: string; entityId: string; badgeType: string; awardedAt: string; name: string | null; artist: string | null }[] };
	previous: { year: number; plays: number; ms: number; days: number; artists: number; tracks: number; newArtists: number; through: string };
}

export type WrappedStatus = 'so_far' | 'frozen' | 'buildable';

export interface WrappedYear {
	year: number;
	status: WrappedStatus;
	generatedAt: string | null;
}

export interface WrappedResponse {
	mode: 'so_far' | 'frozen';
	payload: WrappedPayload;
	playlistName: string;
}

export function wrappedPlaylistName(year: number): string {
	return `Wrapped ${year}${MANAGED_SUFFIXES.auto_snapshot}`;
}

/** True for a Wrapped playlist name ("Wrapped 2025 · Auto 🤖📸"): rebuilt from Rotor Wrapped, not by the snapshot job. */
export function isWrappedPlaylistName(name: string | null | undefined): boolean {
	return !!name && /^Wrapped (\d{4}) · Auto 🤖📸$/u.test(name);
}

export function isWrappedYear(v: unknown, todayIso: string): v is number {
	const y = typeof v === 'string' ? Number(v) : v;
	return typeof y === 'number' && Number.isInteger(y) && y >= WRAPPED_MIN_YEAR && y <= Number(todayIso.slice(0, 4));
}

/** Years the picker offers: this year first (so far), then every past year down to 2017. */
export function wrappedYears(todayIso: string): number[] {
	const y = Number(todayIso.slice(0, 4));
	return Array.from({ length: y - WRAPPED_MIN_YEAR + 1 }, (_, i) => y - i);
}

/**
 * Home card window, 1 December → 31 January (Europe/Amsterdam date):
 * December → this year "so far"; January → last year's frozen story. Otherwise null.
 */
export function homeWrappedCard(todayIso: string): { year: number; mode: 'so_far' | 'frozen' } | null {
	const y = Number(todayIso.slice(0, 4));
	const m = Number(todayIso.slice(5, 7));
	if (m === 12) return { year: y, mode: 'so_far' };
	if (m === 1) return { year: y - 1, mode: 'frozen' };
	return null;
}

/** Hours with one decimal under 100, whole hours above. */
export function hoursOf(ms: number): string {
	const h = ms / 3_600_000;
	return h < 100 ? (Math.round(h * 10) / 10).toLocaleString('en-GB') : Math.round(h).toLocaleString('en-GB');
}

/** "≈" when part of the year's hours are track lengths (API plays without ms_played, migration 0026). */
export function approxMark(p: WrappedPayload): string {
	return p.totals.noMsPlays > 0 ? '≈ ' : '';
}

export const DOW_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function peakHour(clock: number[][]): { dow: number; hour: number; plays: number } | null {
	let best: { dow: number; hour: number; plays: number } | null = null;
	for (let dow = 0; dow < clock.length; dow++) {
		const row = clock[dow] ?? [];
		for (let hour = 0; hour < row.length; hour++) {
			const plays = row[hour] ?? 0;
			if (plays > 0 && (best === null || plays > best.plays)) best = { dow, hour, plays };
		}
	}
	return best;
}

export function favouriteMonth(p: WrappedPayload): { month: number; plays: number; ms: number } | null {
	const m = [...p.months].sort((a, b) => b.plays - a.plays || b.ms - a.ms || a.month - b.month)[0];
	return m && m.plays > 0 ? m : null;
}

export function pctChange(now: number, before: number): number | null {
	if (!before) return null;
	return Math.round(((now - before) / before) * 100);
}

export type CardKind =
	| 'intro'
	| 'totals'
	| 'top_artists'
	| 'top_tracks'
	| 'discoveries'
	| 'comebacks'
	| 'clock'
	| 'streak'
	| 'month'
	| 'badges'
	| 'yoy'
	| 'outro';

/**
 * The story's cards, in order, skipping every card without data (an empty year has only the
 * intro and the outro). The hardstyle-subgenre card isn't here: there is no genre/tag source in
 * the database (see the R6 PR).
 */
export function wrappedCards(p: WrappedPayload): CardKind[] {
	const t = p.totals;
	const cards: CardKind[] = ['intro'];
	if (t.plays > 0) cards.push('totals');
	if (p.topArtists.length) cards.push('top_artists');
	if (p.topTracks.length) cards.push('top_tracks');
	if (p.discoveries.artists > 0 || p.discoveries.tracks > 0) cards.push('discoveries');
	if (p.comebacks.artists > 0 || p.comebacks.tracks > 0) cards.push('comebacks');
	if (peakHour(p.clock)) cards.push('clock');
	if (p.streak || p.biggestDay) cards.push('streak');
	if (favouriteMonth(p)) cards.push('month');
	if (p.badges.count > 0) cards.push('badges');
	if (t.plays > 0 && p.previous.plays > 0) cards.push('yoy');
	cards.push('outro');
	return cards;
}

export function topUris(p: WrappedPayload, n = 100): string[] {
	const out: string[] = [];
	for (const t of p.topTracks) {
		if (t.uri && /^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri) && !out.includes(t.uri)) out.push(t.uri);
		if (out.length >= n) break;
	}
	return out;
}
