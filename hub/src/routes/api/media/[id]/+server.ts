import type { RequestHandler } from '@sveltejs/kit';
import { deleteMedia } from '$lib/server/media';
import { run } from '$lib/server/own-http';
import { requireMedia } from '$lib/server/services';

/** DELETE /api/media/{id} — guarded: storage and database together (409 if it's a track's only source). */
export const DELETE: RequestHandler = ({ params }) => run(() => deleteMedia(requireMedia(), params.id ?? ''));
