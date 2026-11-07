/**
 * Release radar (R7): shared types + pure helpers for the Radar screen, the Home "Coming up"
 * shelf and the artist page toggle. The data comes from the daily Python run (lib/release_radar).
 */
import { MANAGED_SUFFIXES } from './managed';

export type RadarSource = 'spotify' | 'musicbrainz' | 'scantraxx';
export type RadarStatus = 'announced' | 'out' | 'in_library';

export const RADAR_SOURCE_LABEL: Record<RadarSource, string> = {
	spotify: 'Spotify',
	musicbrainz: 'MusicBrainz',
	scantraxx: 'Scantraxx'
};
export const RADAR_RECENT_DAYS = 60;
export const RADAR_PLAYLIST_DAYS = 14;
export const RADAR_PLAYLIST_NAME = `New from your artists${MANAGED_SUFFIXES.auto_updating}`;
export const RADAR_PLAYLIST_DESCRIPTION =
	'Release radar: Spotify releases of the last 14 days from the artists you listen to. Rewritten when you press "Update playlist" on Rotor\'s Release radar; manual edits are overwritten.';
export const RADAR_MISSING = 'Release radar needs migration 0028_release_radar.sql';

export function isRadarPlaylistName(name: string | null | undefined): boolean {
	return name === RADAR_PLAYLIST_NAME;
}

export interface RadarRelease {
	id: number;
	artist: string;
	artistId: string | null;
	title: string;
	date: string | null;
	precision: 'day' | 'month' | 'year' | null;
	type: string | null;
	label: string | null;
	spotifyUrl: string | null;
	url: string | null;
	sources: RadarSource[];
	status: RadarStatus;
	followed: boolean;
}

export interface RadarSourceHealth {
	source: RadarSource;
	enabled: boolean;
	disabledReason: string | null;
	lastRunAt: string | null;
	lastSuccessAt: string | null;
	lastError: string | null;
	lastErrorAt: string | null;
	failingSince: string | null;
	consecutiveFailures: number;
	lastItems: number | null;
}

export interface RadarPayload {
	today: string;
	upcoming: RadarRelease[];
	recent: RadarRelease[];
	artists: { key: string; name: string; count: number }[];
	sources: RadarSourceHealth[];
	followedCount: number;
	lastRunAt: string | null;
	playlistTracks: number;
}

export function radarStatus(date: string | null, inLibrary: boolean, today: string): RadarStatus {
	if (inLibrary) return 'in_library';
	return date && date > today ? 'announced' : 'out';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-03-06' (day) → '6 Mar 2026'; month precision → 'March 2026'; year → '2026'. */
export function radarDate(date: string | null, precision: RadarRelease['precision']): string {
	if (!date) return 'Date to be announced';
	const [y, m, d] = date.split('-').map(Number);
	if (precision === 'year') return String(y);
	if (precision === 'month') return `${LONG_MONTHS[(m ?? 1) - 1]} ${y}`;
	return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export const STATUS_LABEL: Record<RadarStatus, string> = { announced: 'Announced', out: 'Out', in_library: 'In your library' };
