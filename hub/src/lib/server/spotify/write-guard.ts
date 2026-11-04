/**
 * The read-only rule, enforced in code (04-architecture.md §3.4).
 *
 * TypeScript twin of the SAFETY CONTRACT in lib/playlists.py. Every Spotify playlist
 * write the hub makes goes through the functions returned by createWriteGuard():
 *
 *   - assertWritable() fetches the playlist LIVE from Spotify (never the mirror) and
 *     requires owner.id === OWNER_SPOTIFY_ID and a managed suffix on the verbatim name.
 *     Anything else throws ReadOnlyPlaylist before a single write request is sent.
 *   - unfollowCustom() additionally requires the ' · Custom 🎧' suffix.
 *   - changeDetails() refuses renames that would drop the managed suffix.
 *   - createManagedPlaylist() is the only write without a target playlist; the name it
 *     creates must carry a managed suffix.
 *
 * SpotifyApi.request() refuses playlist writes outright; only this module calls
 * SpotifyApi._sendPlaylistWrite(). The UI hiding edit affordances is cosmetic; this is
 * the safety net. Unit tests: write-guard.test.ts.
 */
import { managedKind, type ManagedKind } from '$lib/shared/managed';
import { SPOTIFY_ID, TRACK_URI, type SpotifyApi } from './api';

export type ReadOnlyReason = 'not_owned' | 'no_managed_suffix' | 'not_custom' | 'invalid_id' | 'name_not_managed';

export class ReadOnlyPlaylist extends Error {
	constructor(
		readonly playlistId: string,
		readonly reason: ReadOnlyReason
	) {
		super(`Playlist ${playlistId} is read + play only (${reason})`);
		this.name = 'ReadOnlyPlaylist';
	}
}

export interface WritablePlaylist {
	id: string;
	name: string;
	kind: ManagedKind;
	snapshotId: string | null;
}

interface PlaylistHead {
	id?: string;
	name?: string;
	owner?: { id?: string };
	snapshot_id?: string;
}

const BATCH = 100;

function checkUris(uris: string[]): void {
	for (const u of uris) {
		if (!TRACK_URI.test(u)) throw new Error(`Not a track/episode URI: ${u}`);
	}
}

export function createWriteGuard(api: SpotifyApi, ownerId: string) {
	if (!ownerId) throw new Error('createWriteGuard needs OWNER_SPOTIFY_ID');

	async function assertWritable(playlistId: string): Promise<WritablePlaylist> {
		if (!SPOTIFY_ID.test(playlistId)) throw new ReadOnlyPlaylist(playlistId, 'invalid_id');
		const { data } = await api.get<PlaylistHead>(`/playlists/${playlistId}`, {
			fields: 'id,name,owner(id),snapshot_id'
		});
		const name = data?.name ?? '';
		if (!data || data.owner?.id !== ownerId) throw new ReadOnlyPlaylist(playlistId, 'not_owned');
		const kind = managedKind(name);
		if (!kind) throw new ReadOnlyPlaylist(playlistId, 'no_managed_suffix');
		return { id: playlistId, name, kind, snapshotId: data.snapshot_id ?? null };
	}

	/** Replace all items (first 100 via PUT, the rest appended in batches of 100). */
	async function replaceItems(playlistId: string, uris: string[]): Promise<WritablePlaylist> {
		checkUris(uris);
		const target = await assertWritable(playlistId);
		await api._sendPlaylistWrite('PUT', `/playlists/${playlistId}/items`, { body: { uris: uris.slice(0, BATCH) } });
		for (let i = BATCH; i < uris.length; i += BATCH) {
			await api._sendPlaylistWrite('POST', `/playlists/${playlistId}/items`, { body: { uris: uris.slice(i, i + BATCH) } });
		}
		return target;
	}

	async function addItems(playlistId: string, uris: string[], position?: number): Promise<WritablePlaylist> {
		checkUris(uris);
		const target = await assertWritable(playlistId);
		for (let i = 0; i < uris.length; i += BATCH) {
			const body: { uris: string[]; position?: number } = { uris: uris.slice(i, i + BATCH) };
			if (position !== undefined) body.position = position + i;
			await api._sendPlaylistWrite('POST', `/playlists/${playlistId}/items`, { body });
		}
		return target;
	}

	async function removeItems(playlistId: string, uris: string[], snapshotId?: string): Promise<WritablePlaylist> {
		checkUris(uris);
		const target = await assertWritable(playlistId);
		for (let i = 0; i < uris.length; i += BATCH) {
			const body: { items: { uri: string }[]; snapshot_id?: string } = {
				items: uris.slice(i, i + BATCH).map((uri) => ({ uri }))
			};
			if (snapshotId) body.snapshot_id = snapshotId;
			await api._sendPlaylistWrite('DELETE', `/playlists/${playlistId}/items`, { body });
		}
		return target;
	}

	async function changeDetails(
		playlistId: string,
		details: { name?: string; description?: string; public?: boolean }
	): Promise<WritablePlaylist> {
		if (details.name !== undefined && !managedKind(details.name)) {
			throw new ReadOnlyPlaylist(playlistId, 'name_not_managed');
		}
		const target = await assertWritable(playlistId);
		await api._sendPlaylistWrite('PUT', `/playlists/${playlistId}`, { body: details });
		return target;
	}

	/** Removes a Custom 🎧 playlist from the library (R2's "Delete now"). */
	async function unfollowCustom(playlistId: string): Promise<WritablePlaylist> {
		const target = await assertWritable(playlistId);
		if (target.kind !== 'custom') throw new ReadOnlyPlaylist(playlistId, 'not_custom');
		// Feb 2026 Web API: per-type library endpoints were folded into /me/library.
		await api._sendPlaylistWrite('DELETE', '/me/library', { query: { uris: `spotify:playlist:${playlistId}` } });
		return target;
	}

	/** The only write without a target: creates a playlist whose name carries a managed suffix. */
	async function createManagedPlaylist(opts: {
		name: string;
		description?: string;
		public?: boolean;
	}): Promise<{ id: string; name: string; kind: ManagedKind }> {
		const kind = managedKind(opts.name);
		if (!kind) throw new ReadOnlyPlaylist('(new)', 'name_not_managed');
		const { data } = await api._sendPlaylistWrite<{ id: string; name: string }>('POST', '/me/playlists', {
			body: { name: opts.name, description: opts.description ?? '', public: opts.public ?? false }
		});
		if (!data?.id) throw new Error('Spotify did not return the created playlist id');
		return { id: data.id, name: data.name ?? opts.name, kind };
	}

	return { assertWritable, replaceItems, addItems, removeItems, changeDetails, unfollowCustom, createManagedPlaylist };
}

export type WriteGuard = ReturnType<typeof createWriteGuard>;
