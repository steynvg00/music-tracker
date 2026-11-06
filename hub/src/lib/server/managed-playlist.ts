/**
 * One named managed playlist that Rotor owns and rewrites on request (R6 "Wrapped <year> · Auto 🤖📸",
 * R7 "New from your artists · Auto 🤖🔄"). Same flow as R1's Daily pick:
 *
 *   find it in the mirror by exact name (owned, not removed) → fresh mirror sync → create it
 *   through guard.createManagedPlaylist (name must carry a managed suffix) → guard.replaceItems
 *   with requireKind, which re-reads the playlist LIVE from Spotify (owner + suffix) first.
 *
 * A playlist deleted in Spotify since the last sync answers 404: it is marked removed and
 * found/created once more. Nothing else is ever written.
 */
import type { Queryable } from '$lib/server/db';
import { managedKind, type ManagedKind } from '$lib/shared/managed';
import { BadInput } from '$lib/shared/custom';
import { SpotifyError, type SpotifyApi } from './spotify/api';
import type { WriteGuard } from './spotify/write-guard';
import { syncMirror, upsertMirrorRow } from './spotify/mirror';

export interface ManagedPlaylistDeps {
	sql: Queryable;
	api: SpotifyApi;
	guard: WriteGuard;
	ownerId: string;
}

export async function findOwnedPlaylistByName(sql: Queryable, name: string): Promise<string | null> {
	const [r] = await sql<{ playlist_id: string }[]>`
		SELECT playlist_id FROM spotify_playlists
		WHERE name = ${name} AND is_owned AND removed_at IS NULL
		ORDER BY first_seen_at LIMIT 1`;
	return r?.playlist_id ?? null;
}

export async function ensureManagedPlaylist(deps: ManagedPlaylistDeps, name: string, description: string): Promise<{ id: string; created: boolean }> {
	if (!managedKind(name)) throw new BadInput(`"${name}" has no managed suffix`);
	const known = await findOwnedPlaylistByName(deps.sql, name);
	if (known) return { id: known, created: false };
	await syncMirror(deps.sql, deps.api, deps.ownerId, true);
	const synced = await findOwnedPlaylistByName(deps.sql, name);
	if (synced) return { id: synced, created: false };
	const created = await deps.guard.createManagedPlaylist({ name, description, public: false });
	const [clock] = await deps.sql<{ now: Date }[]>`SELECT now() AS now`;
	await upsertMirrorRow(
		deps.sql,
		{
			playlist_id: created.id,
			name: created.name,
			owner_id: deps.ownerId,
			owner_name: null,
			is_owned: true,
			is_collab: false,
			is_public: false,
			managed_kind: created.kind,
			snapshot_id: null,
			track_count: 0,
			image_url: null
		},
		clock!.now
	);
	return { id: created.id, created: true };
}

/** Find-or-create + replace all items (guarded, kind-checked). Returns the playlist id. */
export async function writeManagedPlaylist(
	deps: ManagedPlaylistDeps,
	input: { name: string; description: string; uris: string[]; kind: ManagedKind }
): Promise<{ id: string; created: boolean }> {
	if (managedKind(input.name) !== input.kind) throw new BadInput(`"${input.name}" is not a ${input.kind} name`);
	let target = await ensureManagedPlaylist(deps, input.name, input.description);
	try {
		await deps.guard.replaceItems(target.id, input.uris, { requireKind: input.kind });
	} catch (e) {
		if (!(e instanceof SpotifyError && e.status === 404)) throw e;
		await deps.sql`UPDATE spotify_playlists SET removed_at = now() WHERE playlist_id = ${target.id}`;
		target = await ensureManagedPlaylist(deps, input.name, input.description);
		await deps.guard.replaceItems(target.id, input.uris, { requireKind: input.kind });
	}
	await deps.sql`UPDATE spotify_playlists SET track_count = ${input.uris.length}, last_seen_at = now() WHERE playlist_id = ${target.id}`;
	return target;
}
