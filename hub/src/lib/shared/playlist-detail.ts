import type { ManagedKind } from './managed';
import type { JobRow } from './jobs';
import type { TrackRow } from './daily-types';
import type { CustomFilters } from './custom';

/** GET /api/playlists/{id} response. */
export interface PlaylistDetail {
	playlist: {
		id: string;
		uri: string;
		name: string;
		imageUrl: string | null;
		kind: ManagedKind | null;
		isOwned: boolean;
		isCollab: boolean;
		ownerName: string | null;
		trackCount: number | null;
	};
	category: {
		key: string;
		name: string;
		ruleNl: string;
		scheduleKind: string;
		scheduleNl: string;
		nextCreationNl: string;
		memberVariation: string;
		notes: string;
	} | null;
	nextRefresh: string | null;
	settings: { orderPref: string; forceRefreshRequestedAt: string | null; forceRefreshCompletedAt: string | null };
	custom: {
		playlistId: string;
		name: string;
		createdAt: string;
		expiresAt: string | null;
		trackCount: number;
		filtersSummary: string | null;
		filters: CustomFilters | null;
		excluded: string[];
	} | null;
	tracks: { readable: boolean; rows: TrackRow[] };
	job: JobRow | null;
	jobsAvailable: boolean;
}
