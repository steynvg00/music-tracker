import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ownStats } from '$lib/server/own';
import { run } from '$lib/server/own-http';

/** GET /api/own/stats — Rotor plays of own tracks, apart from every Spotify stat. */
export const GET: RequestHandler = () => run(() => ownStats(db()));
