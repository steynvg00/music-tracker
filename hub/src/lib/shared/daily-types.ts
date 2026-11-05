import type { ManagedKind } from './managed';
import type { JobRow } from './jobs';

export interface PlaylistCard {
	id: string | null;
	uri: string;
	name: string;
	imageUrl: string | null;
	kind: ManagedKind | null;
	isOwned: boolean;
	isCollab: boolean;
	ownerName: string | null;
	trackCount: number | null;
	subtitle: string | null;
	/** Virtual entries (Liked Songs) have no playlist id. */
	virtual?: 'liked';
}

export interface DailyCandidate {
	date: string;
	rank: number;
	kind: 'generated' | 'existing_playlist';
	recipe: string | null;
	params: Record<string, unknown>;
	title: string;
	reason: string;
	trackCount: number | null;
	durationMs: number | null;
	playlist: PlaylistCard | null;
}

export interface DailyState {
	currentRank: number;
	playedRank: number | null;
	playedAt: string | null;
	rotated: number[];
	reseedRequestedAt: string | null;
}

export interface DailyDeck {
	date: string;
	candidates: DailyCandidate[];
	state: DailyState | null;
	current: DailyCandidate | null;
	/** Context URI of the Daily pick playlist, when known (hero shows Pause while it plays). */
	dailyPlaylistUri: string | null;
	reseedAvailable: boolean;
	/** Latest "Shuffle the deck" job for this day (R2), so a reload keeps showing its state. */
	reseedJob: JobRow | null;
}

export interface TrackRow {
	uri: string;
	name: string | null;
	artist: string | null;
	durationMs: number | null;
	plays: number;
}

export interface HomeTiles {
	playsThisWeek: number;
	playsLastWeekSamePoint: number;
	perDay: number[];
	hoursThisWeek: number;
	topArtistMonth: { name: string; plays: number } | null;
	monthLabel: string;
}

export interface HomePayload {
	generatedAt: string;
	health: {
		lastPlayAt: string | null;
		ingest: 'ok' | 'warn' | 'danger';
		token: 'ok' | 'warn' | 'danger';
		tokenDaysLeft: number | null;
		cronTokenDaysLeft: number | null;
	};
	daily: DailyDeck;
	tiles: HomeTiles;
	shortcuts: PlaylistCard[];
	fresh: PlaylistCard[];
	comingBack: PlaylistCard[];
	/** R3 rollups (hub.home_payload); null until migration 0023 is applied. */
	stats: HomeStats | null;
}

export interface HomeStats {
	today: string;
	refreshedAt: string | null;
	streak: { current: number; longest: number; listenedToday: boolean };
	month: { plays: number; hours: number; newArtists: number };
	onThisDay: { year: number; plays: number; top: { track: string; artist: string; uri: string | null; plays: number } | null; uris: string[] }[];
	recentBadges: {
		entityType: 'track' | 'artist';
		entityId: string;
		badgeType: string;
		awardedAt: string;
		context: Record<string, unknown>;
		name: string | null;
		artist: string | null;
	}[];
}
