/**
 * Custom-playlist filters, shared by the server and the custom playlist sheet. Same keys as
 * lib/temporary_playlists.preview_filters() and hub.custom_playlist_preview() (0022).
 */
import { MANAGED_SUFFIXES } from './managed';

export const SORT_ORDERS = ['plays_desc', 'plays_asc', 'first_play_asc', 'first_play_desc', 'release_asc', 'release_desc', 'random'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const SORT_LABEL: Record<SortOrder, string> = {
	plays_desc: 'Most played first',
	plays_asc: 'Least played first',
	first_play_asc: 'Discovered earliest first',
	first_play_desc: 'Discovered latest first',
	release_asc: 'Oldest releases first',
	release_desc: 'Newest releases first',
	random: 'Random'
};

export interface CustomFilters {
	artists: string[];
	release_year_min: number | null;
	release_year_max: number | null;
	discovery_year_min: number | null;
	discovery_year_max: number | null;
	min_plays: number | null;
	max_tracks: number;
	liked_only: boolean;
	sort_order: SortOrder;
}

export const DEFAULT_FILTERS: CustomFilters = {
	artists: [],
	release_year_min: null,
	release_year_max: null,
	discovery_year_min: null,
	discovery_year_max: null,
	min_plays: null,
	max_tracks: 100,
	liked_only: false,
	sort_order: 'plays_desc'
};

export const LIFETIMES = { '7d': 7, '30d': 30, keep: null } as const;
export type Lifetime = keyof typeof LIFETIMES;

export const MAX_NAME = 80;

export class BadInput extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BadInput';
	}
}

function intOrNull(v: unknown, name: string, min: number, max: number): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'string' ? Number(v) : v;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new BadInput(`${name} must be a whole number ${min}–${max}`);
	return n;
}

/** Validate + normalise untrusted filters (API input, stored filters_json). */
export function parseFilters(input: unknown): CustomFilters {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadInput('filters must be an object');
	const o = input as Record<string, unknown>;
	const artistsRaw = o.artists ?? [];
	if (!Array.isArray(artistsRaw) || artistsRaw.length > 50) throw new BadInput('artists must be a list of at most 50 names');
	const artists = [...new Set(artistsRaw.map((a) => (typeof a === 'string' ? a.trim() : '')).filter((a) => a.length > 0 && a.length <= 200))];
	const sort = (o.sort_order ?? 'plays_desc') as SortOrder;
	if (!SORT_ORDERS.includes(sort)) throw new BadInput('unknown sort order');
	const f: CustomFilters = {
		artists,
		release_year_min: intOrNull(o.release_year_min, 'Released from', 1900, 2100),
		release_year_max: intOrNull(o.release_year_max, 'Released to', 1900, 2100),
		discovery_year_min: intOrNull(o.discovery_year_min, 'Discovered from', 1990, 2100),
		discovery_year_max: intOrNull(o.discovery_year_max, 'Discovered to', 1990, 2100),
		min_plays: intOrNull(o.min_plays, 'Min plays', 1, 1_000_000),
		max_tracks: intOrNull(o.max_tracks, 'Max tracks', 1, 10_000) ?? 100,
		liked_only: o.liked_only === true,
		sort_order: sort
	};
	if (f.release_year_min && f.release_year_max && f.release_year_min > f.release_year_max) throw new BadInput('Released from is after Released to');
	if (f.discovery_year_min && f.discovery_year_max && f.discovery_year_min > f.discovery_year_max)
		throw new BadInput('Discovered from is after Discovered to');
	return f;
}

/** Port of lib/temporary_playlists.build_filters_summary (custom_playlists.filters_summary). */
export function filtersSummary(f: CustomFilters): string {
	const parts: string[] = [];
	if (f.artists.length) parts.push(`artists=${f.artists.slice(0, 3).join(', ')}${f.artists.length > 3 ? '+' : ''}`);
	if (f.release_year_min !== null || f.release_year_max !== null) parts.push(`release=${f.release_year_min ?? '*'}-${f.release_year_max ?? '*'}`);
	if (f.discovery_year_min !== null || f.discovery_year_max !== null)
		parts.push(`discovered=${f.discovery_year_min ?? '*'}-${f.discovery_year_max ?? '*'}`);
	if (f.min_plays !== null) parts.push(`plays>=${f.min_plays}`);
	if (f.liked_only) parts.push('liked only');
	parts.push(`sort=${f.sort_order}`);
	return parts.join('; ');
}

/** The user-typed part of a custom playlist name. The suffix is fixed and added by Rotor. */
export function validateCustomName(raw: unknown): string {
	const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
	if (!name) throw new BadInput('Give the playlist a name');
	if (name.length > MAX_NAME) throw new BadInput(`Names are at most ${MAX_NAME} characters`);
	if (/[\u0000-\u001f\u007f]/.test(name)) throw new BadInput('The name contains control characters');
	if (Object.values(MANAGED_SUFFIXES).some((s) => name.includes(s.trim()))) throw new BadInput('Leave the suffix out: Rotor adds “ · Custom 🎧”');
	return name;
}

export function customFullName(name: string): string {
	return `${name}${MANAGED_SUFFIXES.custom}`;
}

export function expiresFor(lifetime: Lifetime, now: Date = new Date()): Date | null {
	const days = LIFETIMES[lifetime];
	return days === null ? null : new Date(now.getTime() + days * 86_400_000);
}

export function isLifetime(v: unknown): v is Lifetime {
	return v === '7d' || v === '30d' || v === 'keep';
}

/** "deletes in 3 d" / "Kept" chip text. */
export function ttlLabel(expiresAt: string | null, now: number = Date.now()): string {
	if (!expiresAt) return 'Kept';
	const ms = Date.parse(expiresAt) - now;
	if (ms <= 0) return 'Deletes at the next sweep';
	const days = Math.ceil(ms / 86_400_000);
	return days <= 1 ? 'Deletes within a day' : `Deletes in ${days} d`;
}
