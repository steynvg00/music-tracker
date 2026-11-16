import type { RequestHandler } from '@sveltejs/kit';
import { completeUpload } from '$lib/server/media';
import { run } from '$lib/server/own-http';
import { requireMedia } from '$lib/server/services';

/** POST — every part there → complete → size verified → ready. */
export const POST: RequestHandler = ({ params }) => run(() => completeUpload(requireMedia(), params.id ?? ''));
