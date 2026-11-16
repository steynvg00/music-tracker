import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteList, getList, updateList } from '$lib/server/own';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';

export const GET: RequestHandler = ({ params }) => run(() => getList(db(), params.id ?? ''));
/** PATCH {name?, add?: [ownId], remove?: [ownId], order?: [ownId]} */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	return run(() => updateList(db(), params.id ?? '', body));
};
export const DELETE: RequestHandler = ({ params }) => run(() => deleteList(db(), params.id ?? ''));
