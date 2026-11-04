/** Shapes the player proxy returns to the browser (see src/lib/server/spotify/player.ts). */

export type RepeatState = 'off' | 'track' | 'context';

export interface PlayerDevice {
	id: string | null;
	name: string;
	/** Spotify device type: Computer, Smartphone, Speaker, TV, AVR, … */
	type: string;
	isActive: boolean;
	isRestricted: boolean;
	supportsVolume: boolean;
	volumePercent: number | null;
}

export interface PlayerArtist {
	name: string;
	uri: string | null;
}

export interface PlayerItem {
	uri: string;
	type: 'track' | 'episode';
	name: string;
	artists: PlayerArtist[];
	albumName: string | null;
	imageUrl: string | null;
	imageUrlLarge: string | null;
	durationMs: number;
	isLocal: boolean;
}

export interface PlayerSnapshot {
	active: boolean;
	device: PlayerDevice | null;
	item: PlayerItem | null;
	context: { uri: string; type: string } | null;
	isPlaying: boolean;
	progressMs: number;
	shuffle: boolean;
	repeat: RepeatState;
	/** Spotify `actions.disallows`, e.g. { seeking: true, skipping_next: true }. */
	disallows: Record<string, boolean>;
}

export interface ContextInfo {
	uri: string;
	name: string;
	kind: 'auto_updating' | 'auto_snapshot' | 'custom' | null;
	isOwned: boolean;
	imageUrl: string | null;
}

export interface TrackStats {
	uri: string;
	plays: number;
	firstPlayedAt: string | null;
	lastPlayedAt: string | null;
	badges: number;
}

export interface PlayerStateResponse {
	snapshot: PlayerSnapshot;
	contextInfo: ContextInfo | null;
	trackStats: TrackStats | null;
	/** Server clock when Spotify answered, for interpolation. */
	fetchedAt: number;
}

export interface ApiError {
	error: string;
	reason?: string | null;
	retryAfter?: number | null;
	message?: string;
}

export const PLAYER_COMMANDS = [
	'play',
	'pause',
	'next',
	'previous',
	'seek',
	'volume',
	'shuffle',
	'repeat',
	'transfer',
	'queue'
] as const;
export type PlayerCommand = (typeof PLAYER_COMMANDS)[number];

export interface PlayBody {
	device_id?: string;
	context_uri?: string;
	uris?: string[];
	offset?: { position: number } | { uri: string };
	position_ms?: number;
}
