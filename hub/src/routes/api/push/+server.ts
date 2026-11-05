import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { subscriptionCount } from '$lib/server/push';
import { jobsAvailable } from '$lib/server/jobs';
import { toResponse } from '$lib/server/http';

/** GET /api/push — the public application server key + how many devices are subscribed. */
export const GET: RequestHandler = async () => {
	try {
		const cfg = config();
		return json({ publicKey: cfg.vapidPublicKey, devices: await subscriptionCount(db()), testAvailable: jobsAvailable(cfg) });
	} catch (e) {
		return toResponse(e);
	}
};
