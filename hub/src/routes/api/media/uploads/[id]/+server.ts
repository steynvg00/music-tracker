import type { RequestHandler } from '@sveltejs/kit';
import { cancelUpload, uploadStatus } from '$lib/server/media';
import { run } from '$lib/server/own-http';
import { requireMedia } from '$lib/server/services';

/** GET — where the upload stands (which parts storage has: resume). */
export const GET: RequestHandler = ({ params }) => run(() => uploadStatus(requireMedia(), params.id ?? ''));
/** DELETE — cancel: abort in storage and forget it. */
export const DELETE: RequestHandler = ({ params }) => run(() => cancelUpload(requireMedia(), params.id ?? ''));
