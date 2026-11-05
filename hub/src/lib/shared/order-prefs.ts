/** Order preferences for Auto 🔄 playlists. Must match ORDER_PREF_OPTIONS in lib/playlist_settings.py (tested). */
export const ORDER_PREFS = {
	default: 'Default (factory order)',
	plays_desc: 'Most plays first',
	plays_asc: 'Least plays first',
	recency_desc: 'Most recently played first',
	recency_asc: 'Least recently played first',
	discovery_desc: 'Most recently discovered first',
	discovery_asc: 'Earliest discovered first',
	release_desc: 'Newest releases first',
	release_asc: 'Oldest releases first',
	random: 'Random shuffle'
} as const;

export type OrderPref = keyof typeof ORDER_PREFS;

export function isOrderPref(v: unknown): v is OrderPref {
	return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ORDER_PREFS, v);
}
