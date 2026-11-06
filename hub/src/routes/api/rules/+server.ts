import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { ruleCategories } from '$lib/server/library';
import { toResponse } from '$lib/server/http';

/** GET /api/rules — the 16 rule categories (exported from lib/playlists.py) + mirrored playlists per category. */
export const GET: RequestHandler = async () => {
	try {
		const sql = db();
		const [categories, members] = await Promise.all([
			ruleCategories(sql),
			sql<{ playlist_id: string; name: string; rule_category: string }[]>`
				SELECT playlist_id, name, rule_category FROM spotify_playlists
				WHERE removed_at IS NULL AND rule_category IS NOT NULL ORDER BY name`
		]);
		const byCat: Record<string, { id: string; name: string }[]> = {};
		for (const m of members) (byCat[m.rule_category] ??= []).push({ id: m.playlist_id, name: m.name });
		return json({ categories, playlists: byCat, exportedAt: categories[0]?.exportedAt ?? null });
	} catch (e) {
		return toResponse(e);
	}
};
