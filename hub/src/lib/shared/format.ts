/** Display helpers shared by components. */

export function fmtTime(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtDuration(ms: number | null | undefined): string {
	if (!ms) return '';
	const minutes = Math.round(ms / 60000);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h ? `${h} h ${m} min` : `${m} min`;
}

export function fmtInt(n: number): string {
	return new Intl.NumberFormat('en-GB').format(n);
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
	if (!iso) return '—';
	return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', ...opts }).format(new Date(iso));
}

export function greeting(d: Date = new Date()): string {
	const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false }).format(d));
	return h < 6 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** https://open.spotify.com link for "Open in Spotify" (linking back, Spotify policy II.4). */
export function openInSpotify(uri: string | null | undefined): string | null {
	if (!uri) return null;
	const m = /^spotify:(track|album|artist|playlist|episode|show):([A-Za-z0-9]{22})$/.exec(uri);
	if (m) return `https://open.spotify.com/${m[1]}/${m[2]}`;
	if (/^spotify:user:[^:]+:collection$/.test(uri)) return 'https://open.spotify.com/collection/tracks';
	return null;
}

export function artistLine(artists: { name: string }[] | undefined): string {
	return (artists ?? []).map((a) => a.name).join(', ');
}

export function deviceIcon(type: string | undefined): 'phone' | 'laptop' | 'speaker' | 'tv' {
	const t = (type ?? '').toLowerCase();
	if (t === 'smartphone' || t === 'tablet') return 'phone';
	if (t === 'speaker' || t === 'avr' || t === 'stb' || t === 'audiodongle' || t === 'castaudio') return 'speaker';
	if (t === 'tv' || t === 'castvideo' || t === 'gameconsole') return 'tv';
	return 'laptop';
}

/** "▲ 12%" style delta for stat tiles. */
export function delta(current: number, previous: number): { text: string; dir: 'up' | 'down' | 'flat' } {
	if (previous <= 0) return { text: current > 0 ? 'new this week' : '—', dir: 'flat' };
	const pct = Math.round(((current - previous) / previous) * 100);
	if (pct === 0) return { text: '— same as last week', dir: 'flat' };
	return { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs last week`, dir: pct > 0 ? 'up' : 'down' };
}
