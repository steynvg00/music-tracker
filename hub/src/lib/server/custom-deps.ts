import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { writeGuard } from '$lib/server/services';
import type { CustomDeps } from '$lib/server/custom';

export function customDeps(): CustomDeps {
	return { sql: db(), guard: writeGuard(), ownerId: config().ownerSpotifyId };
}
