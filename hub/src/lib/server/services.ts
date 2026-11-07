/** Lazily wired singletons for one lambda instance. */
import { config } from '$lib/server/env';
import { db } from '$lib/server/db';
import { parseKey } from '$lib/server/crypto';
import { SpotifyApi } from '$lib/server/spotify/api';
import { createTokenProvider, type TokenProvider } from '$lib/server/spotify/token';
import { createWriteGuard, type WriteGuard } from '$lib/server/spotify/write-guard';
import { credentialsFor } from '$lib/server/spotify/oauth';

let tokens: TokenProvider | null = null;
let api: SpotifyApi | null = null;
let guard: WriteGuard | null = null;
let key: Buffer | null = null;

export function tokenKey(): Buffer {
	return (key ??= parseKey(config().tokenEncKey));
}

export function tokenProvider(): TokenProvider {
	return (tokens ??= createTokenProvider({
		sql: db(),
		key: tokenKey(),
		credentials: (client) => credentialsFor(client, config())
	}));
}

/** Spotify API as the hub client. */
export function spotify(): SpotifyApi {
	return (api ??= new SpotifyApi({
		getToken: () => tokenProvider().getAccessToken('hub'),
		invalidateToken: () => tokenProvider().invalidate('hub')
	}));
}

export function writeGuard(): WriteGuard {
	return (guard ??= createWriteGuard(spotify(), config().ownerSpotifyId));
}

let catalogClient: import('$lib/server/catalog/spotify').CatalogClient | null = null;

/** v0.90 catalog reads (Artist pages beta, catalog search): the hub client, rate-limit aware. */
export async function catalog(): Promise<import('$lib/server/catalog/spotify').CatalogClient> {
	if (catalogClient) return catalogClient;
	const { CatalogClient } = await import('$lib/server/catalog/spotify');
	return (catalogClient = new CatalogClient(spotify()));
}
