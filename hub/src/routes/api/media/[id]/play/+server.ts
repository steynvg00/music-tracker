import type { RequestHandler } from '@sveltejs/kit';
import { playbackUrl } from '$lib/server/media';
import { run } from '$lib/server/own-http';
import { requireMedia } from '$lib/server/services';

/** GET — a short-lived signed URL for Rotor's own audio player. */
export const GET: RequestHandler = ({ params }) => run(() => playbackUrl(requireMedia(), params.id ?? ''));
