/**
 * Prefill for own tracks and sets (v0.94): suggestions, never decisions. Sources:
 *   - the YouTube / SoundCloud embed title (oEmbed, no key) → "Artist - Title (Version)"
 *   - MusicBrainz recording search (1 request, own User-Agent, well under 1 req/s)
 *   - the Spotify catalog search (v0.90), one page of tracks
 * Suggested artist names are matched to artists in your data; unknown names come back unlinked, and the
 * form asks you to link or create them explicitly. Every field is confirmed in the form one by one.
 */
import type { Queryable } from '$lib/server/db';
import { SC_OEMBED } from '$lib/server/elsewhere';
import { parseEmbedTitle, soundcloudUrl, youtubeId, type ArtistLink } from '$lib/shared/own';
import type { CatalogSearchResults } from '$lib/shared/catalog';
import { artistsByName } from './own';

export const MB_BASE = 'https://musicbrainz.org/ws/2';
export const YT_OEMBED = 'https://www.youtube.com/oembed';
export const USER_AGENT = 'RotorMusicHub/0.94 ( https://github.com/steynvg00/music-tracker )';

export interface SuggestedArtist {
	name: string;
	link: ArtistLink | null;
}
export interface Suggestion {
	source: 'embed' | 'musicbrainz' | 'spotify';
	title: string | null;
	version: string | null;
	artists: SuggestedArtist[];
	featuring: SuggestedArtist[];
	remixer: SuggestedArtist | null;
	durationMs: number | null;
	date: string | null;
	label: string | null;
	coverUrl: string | null;
	ref: string | null;
}
export interface PrefillResult {
	embed: { title: string; author: string | null; thumbnail: string | null } | null;
	suggestions: Suggestion[];
	errors: Partial<Record<'embed' | 'musicbrainz' | 'spotify', string>>;
}

interface Deps {
	sql: Queryable;
	fetch?: typeof fetch;
	/** The v0.90 catalog search, injected (it needs the Spotify client). null = skip. */
	spotifySearch: ((q: string) => Promise<CatalogSearchResults>) | null;
	mbBase?: string;
}

async function getJson<T>(f: typeof fetch, url: string): Promise<T> {
	const res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
	if (!res.ok) throw new Error(`answered ${res.status}`);
	return (await res.json()) as T;
}

interface MbRecording {
	id: string;
	title: string;
	length?: number | null;
	disambiguation?: string;
	'first-release-date'?: string;
	'artist-credit'?: { name: string; joinphrase?: string; artist?: { name: string } }[];
	releases?: { title?: string; date?: string; 'label-info'?: { label?: { name?: string } }[] }[];
}

const fullDate = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
const luceneEscape = (s: string) => s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

export async function prefill(d: Deps, body: { title?: unknown; artist?: unknown; youtubeUrl?: unknown; soundcloudUrl?: unknown }): Promise<PrefillResult> {
	const f = d.fetch ?? ((...a) => fetch(...a));
	const out: PrefillResult = { embed: null, suggestions: [], errors: {} };
	const pending: (Omit<Suggestion, 'artists' | 'featuring' | 'remixer'> & { artistNames: string[]; featNames: string[]; remixerName: string | null })[] = [];

	// 1. Embed title.
	const yt = youtubeId(typeof body.youtubeUrl === 'string' ? body.youtubeUrl : null);
	const sc = soundcloudUrl(typeof body.soundcloudUrl === 'string' ? body.soundcloudUrl : null);
	if (yt || sc) {
		try {
			const o = yt
				? await getJson<{ title: string; author_name?: string; thumbnail_url?: string }>(f, `${YT_OEMBED}?${new URLSearchParams({ url: `https://www.youtube.com/watch?v=${yt}`, format: 'json' })}`)
				: await getJson<{ title: string; author_name?: string; thumbnail_url?: string }>(f, `${SC_OEMBED}?${new URLSearchParams({ url: sc!, format: 'json' })}`);
			out.embed = { title: o.title, author: o.author_name ?? null, thumbnail: o.thumbnail_url?.startsWith('https://') ? o.thumbnail_url : null };
			const p = parseEmbedTitle(o.title, o.author_name ?? null);
			pending.push({
				source: 'embed',
				title: p.title || null,
				version: p.version,
				artistNames: p.artists,
				featNames: p.featuring,
				remixerName: p.remixer,
				durationMs: null,
				date: null,
				label: null,
				coverUrl: out.embed.thumbnail,
				ref: yt ? `https://www.youtube.com/watch?v=${yt}` : sc
			});
		} catch (e) {
			out.errors.embed = `The ${yt ? 'YouTube' : 'SoundCloud'} embed couldn’t be read (${e instanceof Error ? e.message : 'error'})`;
		}
	}

	const title = (typeof body.title === 'string' && body.title.trim()) || pending[0]?.title || '';
	const artist = (typeof body.artist === 'string' && body.artist.trim()) || pending[0]?.artistNames[0] || '';
	if (title.length >= 2) {
		const q = artist ? `${artist} ${title}` : title;
		const [mb, sp] = await Promise.allSettled([
			getJson<{ recordings?: MbRecording[] }>(
				f,
				`${d.mbBase ?? MB_BASE}/recording?${new URLSearchParams({ query: `recording:"${luceneEscape(title)}"${artist ? ` AND artist:"${luceneEscape(artist)}"` : ''}`, fmt: 'json', limit: '5' })}`
			),
			d.spotifySearch ? d.spotifySearch(q) : Promise.resolve(null)
		]);
		if (mb.status === 'fulfilled') {
			for (const r of (mb.value.recordings ?? []).slice(0, 5)) {
				const credits = r['artist-credit'] ?? [];
				const rel = r.releases?.[0];
				const p = parseEmbedTitle(`x - ${r.title}`);
				pending.push({
					source: 'musicbrainz',
					title: p.title || r.title,
					version: p.version ?? (r.disambiguation ? r.disambiguation : null),
					artistNames: credits.filter((c, i) => i === 0 || !/feat/i.test(credits[i - 1]?.joinphrase ?? '')).map((c) => c.artist?.name ?? c.name),
					featNames: credits.filter((c, i) => i > 0 && /feat/i.test(credits[i - 1]?.joinphrase ?? '')).map((c) => c.artist?.name ?? c.name),
					remixerName: p.remixer,
					durationMs: r.length && r.length > 0 ? r.length : null,
					date: fullDate(r['first-release-date'] ?? rel?.date),
					label: rel?.['label-info']?.[0]?.label?.name ?? null,
					coverUrl: null,
					ref: `https://musicbrainz.org/recording/${r.id}`
				});
			}
		} else out.errors.musicbrainz = `MusicBrainz didn’t answer (${mb.reason instanceof Error ? mb.reason.message : 'error'})`;
		if (sp.status === 'fulfilled' && sp.value) {
			for (const t of (sp.value.tracks?.items ?? []).slice(0, 5)) {
				const p = parseEmbedTitle(`x - ${t.name}`);
				pending.push({
					source: 'spotify',
					title: p.title || t.name,
					version: p.version,
					artistNames: t.artists.map((a) => a.name),
					featNames: p.featuring,
					remixerName: p.remixer,
					durationMs: t.durationMs || null,
					date: null,
					label: null,
					coverUrl: null,
					ref: t.uri
				});
			}
		} else if (sp.status === 'rejected') out.errors.spotify = 'The Spotify catalog search didn’t answer';
	}

	// Link suggested names to artists in your data (exact name). Unknown names stay unlinked.
	const names = pending.flatMap((p) => [...p.artistNames, ...p.featNames, ...(p.remixerName ? [p.remixerName] : [])]);
	const known = await artistsByName(d.sql, names);
	const link = (n: string): SuggestedArtist => ({ name: n, link: known.get(n.trim().toLowerCase()) ?? null });
	out.suggestions = pending.map(({ artistNames, featNames, remixerName, ...s }) => ({
		...s,
		artists: artistNames.map(link),
		featuring: featNames.map(link),
		remixer: remixerName ? link(remixerName) : null
	}));
	return out;
}
