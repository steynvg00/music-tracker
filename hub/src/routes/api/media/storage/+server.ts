import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cleanupStale, listFiles, storageUsage } from '$lib/server/media';
import { run } from '$lib/server/own-http';
import { requireMedia } from '$lib/server/services';
import { storageConfig } from '$lib/server/storage/config';

/** GET /api/media/storage — Settings › Storage: backend, limits, usage, files (never a secret). */
export const GET: RequestHandler = ({ url }) =>
	run(async () => {
		const c = storageConfig();
		const sql = db();
		const [used, files] = await Promise.all([storageUsage(sql, c.limits), url.searchParams.has('files') ? listFiles(sql) : Promise.resolve(null)]);
		return {
			configured: c.configured,
			missing: c.missing,
			backend: c.backend,
			endpointHost: c.endpointHost,
			bucket: c.bucket,
			region: c.region,
			limits: c.limits,
			uploadTtlS: c.uploadTtlS,
			playbackTtlS: c.playbackTtlS,
			usage: used,
			files
		};
	});
/** POST /api/media/storage — clean up: abort stale uploads, finish half-done deletes, drop unused files. */
export const POST: RequestHandler = () => run(() => cleanupStale(requireMedia()));
