import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { enqueueAndDispatch } from '$lib/server/jobs';
import { readJson, toResponse } from '$lib/server/http';
import { isNotificationKind } from '$lib/shared/notifications';
import { BadInput } from '$lib/shared/custom';

/** POST /api/notifications/test {kind} — a push_test job that sends that type's sample (R9), even if it's off. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const { kind } = await readJson(request);
		if (!isNotificationKind(kind)) throw new BadInput('unknown notification type');
		return json(await enqueueAndDispatch(db(), config(), 'push_test', { kind }, `push_test:${kind}`));
	} catch (e) {
		return toResponse(e);
	}
};
