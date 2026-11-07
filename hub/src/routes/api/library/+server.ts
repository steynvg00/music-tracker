import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { organiser } from '$lib/server/organiser';
import { organiserResponse } from '$lib/server/organiser-http';

/** GET /api/library — pins, folders and custom order (Rotor only, 0034). */
export const GET: RequestHandler = async () => organiserResponse(() => organiser(db()));
