import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/http';
import { setPinned } from '$lib/server/organiser';
import { organiserResponse } from '$lib/server/organiser-http';

/** POST /api/library/pin {targets:[key | "folder:<id>"], pinned: boolean} — no cap. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return organiserResponse(() => setPinned(db(), body.targets, body.pinned !== false));
};
