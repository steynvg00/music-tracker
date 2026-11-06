import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { enqueueAndDispatch } from '$lib/server/jobs';
import { toResponse } from '$lib/server/http';

/** POST /api/push/test — a push_test job: GitHub Actions sends "Notifications work" to every device. */
export const POST: RequestHandler = async () => {
	try {
		return json(await enqueueAndDispatch(db(), config(), 'push_test', {}, 'push_test'));
	} catch (e) {
		return toResponse(e);
	}
};
