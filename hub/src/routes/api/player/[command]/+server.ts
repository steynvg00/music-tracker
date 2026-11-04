import { error, type RequestHandler } from '@sveltejs/kit';
import { spotify } from '$lib/server/services';
import { readJson, toResponse } from '$lib/server/http';
import { buildCommand } from '$lib/server/spotify/player';
import { PLAYER_COMMANDS, type PlayerCommand } from '$lib/shared/player-types';

/**
 * POST /api/player/{play|pause|next|previous|seek|volume|shuffle|repeat|transfer|queue}
 * Validates, forwards exactly one Spotify call with the explicit device_id and returns
 * Spotify's status (204 on success).
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const command = params.command as PlayerCommand;
	if (!PLAYER_COMMANDS.includes(command)) error(404, 'Unknown player command');
	try {
		const call = buildCommand(command, await readJson(request));
		await spotify().request(call.method, call.path, { query: call.query, body: call.body });
		return new Response(null, { status: 204 });
	} catch (e) {
		return toResponse(e);
	}
};
