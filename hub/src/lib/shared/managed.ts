/**
 * Managed-playlist suffixes: the TypeScript twin of lib/playlists.py (UPDATING/SNAPSHOT)
 * and lib/temporary_playlists.py (CUSTOM). Only playlists the owner owns AND whose
 * verbatim name ends with one of these may be written to. Everything else is
 * read + play only. Shared by server (write-guard.ts) and UI (lock glyphs, badges).
 *
 * Tested against tests/fixtures/managed_names.json, the same cases the Python mirror uses.
 */
export const MANAGED_SUFFIXES = {
	auto_updating: ' · Auto 🤖🔄',
	auto_snapshot: ' · Auto 🤖📸',
	custom: ' · Custom 🎧'
} as const;

export type ManagedKind = keyof typeof MANAGED_SUFFIXES;

/** Exact, case-sensitive suffix match on the verbatim name. Fail-closed: lookalike
 * characters, trailing spaces, zero-width or variation selectors all mean "unmanaged". */
export function managedKind(name: string | null | undefined): ManagedKind | null {
	if (!name) return null;
	for (const [kind, suffix] of Object.entries(MANAGED_SUFFIXES) as [ManagedKind, string][]) {
		if (name.length > suffix.length && name.endsWith(suffix)) return kind;
	}
	return null;
}

/** The one playlist R1 writes to: generated daily picks are played through it. */
export const DAILY_PICK_PLAYLIST_NAME = `Daily pick${MANAGED_SUFFIXES.auto_updating}`;

export const DAILY_PICK_DESCRIPTION =
	'Rotor daily pick. Rewritten when you press Play on a generated pick in Rotor; manual edits are overwritten.';

export function kindLabel(kind: ManagedKind | null): string | null {
	switch (kind) {
		case 'auto_updating':
			return 'Auto';
		case 'auto_snapshot':
			return 'Snapshot';
		case 'custom':
			return 'Custom';
		default:
			return null;
	}
}
