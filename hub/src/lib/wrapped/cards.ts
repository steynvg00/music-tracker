/**
 * Rotor Wrapped cards (R6) as self-contained SVG strings (1080 × 1920, 9:16).
 *
 * One renderer for two uses: the story shows the SVG inline, and "Save image" draws the very same
 * SVG onto a canvas and exports a PNG on the device (svgToPng), so the saved image is exactly
 * what's on screen. No new dependencies, no network: system fonts only (an SVG drawn into a
 * canvas can't load web fonts), no images (album art may not carry text, and no Spotify logo).
 * Every string from the data is XML-escaped (track names are user-controlled text).
 */
import {
	DOW_NAMES,
	MONTH_NAMES,
	approxMark,
	favouriteMonth,
	hoursOf,
	pctChange,
	peakHour,
	type CardKind,
	type WrappedPayload
} from '$lib/shared/wrapped';
import { badgeLabel } from '$lib/shared/stats';

export const CARD_W = 1080;
export const CARD_H = 1920;
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const BG = '#0B0B0E';
const TEXT = '#F5F5F7';
const TEXT2 = '#B4B4BF';
const VIOLET = '#9D6BFF';
const CYAN = '#3DD9EB';
const AMBER = '#FFC24B';

const TONE: Record<CardKind, [string, string]> = {
	intro: ['#3B1F7A', VIOLET],
	totals: ['#123F48', CYAN],
	top_artists: ['#3B1F7A', VIOLET],
	top_tracks: ['#4A3510', AMBER],
	discoveries: ['#123F48', CYAN],
	comebacks: ['#4A3510', AMBER],
	clock: ['#2A1D55', VIOLET],
	streak: ['#123F48', CYAN],
	month: ['#3B1F7A', VIOLET],
	badges: ['#4A3510', AMBER],
	yoy: ['#123F48', CYAN],
	outro: ['#3B1F7A', VIOLET]
};

export function esc(s: string | number | null | undefined): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Truncate by code points (emoji-safe) with an ellipsis. */
export function clip(s: string | null | undefined, max: number): string {
	const chars = Array.from(s ?? '');
	return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

const n = (v: number) => v.toLocaleString('en-GB');

/** Word-wrap into at most `lines` lines of ~`max` characters; the last line is clipped. */
export function wrap(s: string | null | undefined, max: number, lines = 2): string[] {
	const words = Array.from(s ?? '').join('').split(/\s+/).filter(Boolean);
	const out: string[] = [];
	let cur = '';
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		const next = cur ? `${cur} ${w}` : w;
		if (Array.from(next).length <= max || !cur) {
			cur = next;
			continue;
		}
		out.push(cur);
		cur = w;
		if (out.length === lines - 1) {
			cur = words.slice(i).join(' ');
			break;
		}
	}
	if (cur) out.push(cur);
	return out.slice(0, lines).map((l) => clip(l, max));
}

export function fmtDay(iso: string | null | undefined, withYear = false): string {
	if (!iso) return '';
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
	return `${d} ${MONTH_NAMES[(m ?? 1) - 1]}${withYear ? ` ${y}` : ''}`;
}

function gapText(days: number | undefined): string {
	if (!days) return '';
	const years = Math.floor(days / 365);
	return years >= 2 ? `after ${years} years` : years === 1 ? 'after a year+' : `after ${Math.round(days / 30)} months`;
}

interface T {
	x?: number;
	y: number;
	size: number;
	weight?: number;
	fill?: string;
	anchor?: 'start' | 'middle' | 'end';
	opacity?: number;
}
function text(s: string, o: T): string {
	return `<text x="${o.x ?? 96}" y="${o.y}" font-size="${o.size}" font-weight="${o.weight ?? 600}" fill="${o.fill ?? TEXT}"${
		o.anchor ? ` text-anchor="${o.anchor}"` : ''
	}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ''}>${esc(s)}</text>`;
}

/** Rotor's mark (same paths as RotorMark.svelte), scaled. */
function mark(x: number, y: number, size: number, color: string): string {
	const k = size / 32;
	return `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round">
<circle cx="16" cy="16" r="14"/><path d="M16 16c0-6 3-9.5 7.5-9.8M16 16c5.2 3 6.5 7.4 4.3 11.3M16 16c-5.2 3-9.7 2-12-1.8"/><circle cx="16" cy="16" r="2.6" fill="${color}" stroke="none"/></g>`;
}

function list(rows: { title: string; sub: string; value: string }[], y0: number, accent: string): string {
	return rows
		.map((r, i) => {
			const y = y0 + i * 150;
			return [
				text(String(i + 2), { x: 96, y: y + 52, size: 56, weight: 800, fill: accent }),
				text(clip(r.title, 20), { x: 200, y: y + 30, size: 46, weight: 700 }),
				text(clip(r.sub, 34), { x: 200, y: y + 90, size: 36, weight: 500, fill: TEXT2 }),
				text(r.value, { x: 984, y: y + 30, size: 36, weight: 600, fill: TEXT2, anchor: 'end' })
			].join('');
		})
		.join('');
}

function frame(kind: CardKind, p: WrappedPayload, body: string): string {
	const [deep, accent] = TONE[kind];
	const footer = p.live ? `Rotor Wrapped ${p.year} · so far, through ${fmtDay(p.through)}` : `Rotor Wrapped ${p.year}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" height="${CARD_H}" font-family="${esc(FONT)}" role="img">
<defs><linearGradient id="g-${kind}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${deep}"/><stop offset="0.62" stop-color="${BG}"/></linearGradient>
<radialGradient id="glow-${kind}" cx="0.85" cy="0.08" r="0.55"><stop offset="0" stop-color="${accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#g-${kind})"/><rect width="${CARD_W}" height="${CARD_H}" fill="url(#glow-${kind})"/>
${mark(96, 140, 64, TEXT)}${text('Rotor', { x: 180, y: 188, size: 40, weight: 700 })}
${body}
${text(footer, { y: 1800, size: 32, weight: 500, fill: TEXT2 })}
</svg>`;
}

function bigNumber(v: string, y: number, accent: string, size = 220): string {
	return text(v, { y, size, weight: 800, fill: accent });
}

/** One card as an SVG string. */
export function renderCard(kind: CardKind, p: WrappedPayload): string {
	const [, accent] = TONE[kind];
	const t = p.totals;
	const approx = approxMark(p);
	switch (kind) {
		case 'intro':
			return frame(kind, p, [
				text('Rotor Wrapped', { y: 640, size: 96, weight: 800 }),
				bigNumber(String(p.year), 900, accent, 300),
				text(p.live ? `So far: 1 January – ${fmtDay(p.through)}` : 'The whole year, 1 January – 31 December', { y: 1020, size: 44, weight: 500, fill: TEXT2 }),
				text(t.plays ? 'Tap or press → to begin' : `No listening found for ${p.year}`, { y: 1140, size: 40, weight: 500, fill: TEXT2 })
			].join(''));
		case 'totals':
			return frame(kind, p, [
				text('You pressed play', { y: 520, size: 60, weight: 600, fill: TEXT2 }),
				bigNumber(n(t.plays), 760, accent),
				text('times', { y: 850, size: 60, weight: 600, fill: TEXT2 }),
				bigNumber(`${approx}${hoursOf(t.ms)}`, 1120, TEXT, 180),
				text('hours of music', { y: 1210, size: 60, weight: 600, fill: TEXT2 }),
				text(`on ${n(t.days)} days · ${n(t.tracks)} tracks · ${n(t.artists)} artists`, { y: 1340, size: 40, weight: 500, fill: TEXT2 }),
				approx ? text(`≈ ${n(t.noMsPlays)} plays had no recorded play length, so they count their full track length.`, { y: 1440, size: 28, weight: 500, fill: TEXT2 }) : ''
			].join(''));
		case 'top_artists': {
			const [a, ...rest] = p.topArtists;
			return frame(kind, p, [
				text('Your top artist', { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				...wrap(a!.artist, 16).map((l, i) => text(l, { y: 580 + i * 104, size: 96, weight: 800, fill: accent })),
				text(`${n(a!.plays)} plays · ${approx}${hoursOf(a!.ms ?? 0)} h · ${n(a!.tracks ?? 0)} tracks`, { y: 670 + (wrap(a!.artist, 16).length - 1) * 104, size: 40, weight: 500, fill: TEXT2 }),
				list(rest.slice(0, 4).map((x) => ({ title: x.artist, sub: `${n(x.tracks ?? 0)} tracks`, value: `${n(x.plays)} plays` })), 860 + (wrap(a!.artist, 16).length - 1) * 104, accent)
			].join(''));
		}
		case 'top_tracks': {
			const [a, ...rest] = p.topTracks;
			return frame(kind, p, [
				text('Your top track', { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				...wrap(a!.track, 19).map((l, i) => text(l, { y: 580 + i * 94, size: 84, weight: 800, fill: accent })),
				text(clip(a!.artist, 36), { y: 660 + (wrap(a!.track, 19).length - 1) * 94, size: 48, weight: 600 }),
				text(`${n(a!.plays)} plays · ${approx}${hoursOf(a!.ms ?? 0)} h`, { y: 740 + (wrap(a!.track, 19).length - 1) * 94, size: 40, weight: 500, fill: TEXT2 }),
				list(rest.slice(0, 4).map((x) => ({ title: x.track, sub: x.artist, value: `${n(x.plays)} plays` })), 880 + (wrap(a!.track, 19).length - 1) * 94, accent)
			].join(''));
		}
		case 'discoveries': {
			const d = p.discoveries;
			return frame(kind, p, [
				text('New to you', { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				bigNumber(n(d.artists), 680, accent),
				text(d.artists === 1 ? 'artist you played for the first time' : 'artists you played for the first time', { y: 770, size: 44, weight: 600 }),
				text(`and ${n(d.tracks)} first-ever tracks`, { y: 850, size: 44, weight: 500, fill: TEXT2 }),
				...d.topArtists.slice(0, 4).map((x, i) => [
					text(clip(x.artist, 30), { y: 1000 + i * 130, size: 46, weight: 700 }),
					text(`first heard ${fmtDay(x.firstDay)} · ${n(x.plays)} plays`, { y: 1052 + i * 130, size: 32, weight: 500, fill: TEXT2 })
				].join(''))
			].join(''));
		}
		case 'comebacks': {
			const c = p.comebacks;
			const rows = [...c.topArtists.map((x) => ({ title: x.artist, sub: gapText(x.gapDays), plays: x.plays })),
				...c.topTracks.map((x) => ({ title: x.track, sub: `${x.artist} · ${gapText(x.gapDays)}`, plays: x.plays }))].slice(0, 5);
			return frame(kind, p, [
				text('Welcome back', { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				bigNumber(n(c.artists + c.tracks), 680, accent),
				text('comebacks after 12+ months away', { y: 770, size: 44, weight: 600 }),
				text(`${n(c.artists)} artists · ${n(c.tracks)} tracks`, { y: 850, size: 40, weight: 500, fill: TEXT2 }),
				...rows.map((r, i) => [
					text(clip(r.title, 22), { y: 1000 + i * 130, size: 46, weight: 700 }),
					text(clip(r.sub, 40), { y: 1052 + i * 130, size: 32, weight: 500, fill: TEXT2 }),
					text(`${n(r.plays)} plays`, { x: 984, y: 1000 + i * 130, size: 34, weight: 500, fill: TEXT2, anchor: 'end' })
				].join(''))
			].join(''));
		}
		case 'clock': {
			const pk = peakHour(p.clock)!;
			const max = Math.max(1, ...p.clock.flat());
			const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
			const cell = 34;
			const x0 = 180;
			const y0 = 760;
			const cells = order
				.map((dow, r) =>
					(p.clock[dow] ?? [])
						.map((v, h) => `<rect x="${x0 + h * cell}" y="${y0 + r * (cell + 18)}" width="${cell - 4}" height="${cell + 10}" rx="6" fill="${accent}" opacity="${v ? (0.15 + 0.85 * (v / max)).toFixed(2) : 0.06}"/>`)
						.join('') + text(DOW_NAMES[dow]!.slice(0, 3), { x: 96, y: y0 + r * (cell + 18) + 34, size: 28, weight: 600, fill: TEXT2 })
				)
				.join('');
			const hours = [0, 6, 12, 18].map((h) => text(`${String(h).padStart(2, '0')}:00`, { x: x0 + h * cell, y: y0 + 7 * (cell + 18) + 30, size: 26, weight: 500, fill: TEXT2 })).join('');
			return frame(kind, p, [
				text('Your listening clock', { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				text(`${DOW_NAMES[pk.dow]}`, { y: 570, size: 96, weight: 800, fill: accent }),
				text(`around ${String(pk.hour).padStart(2, '0')}:00 is your hour`, { y: 650, size: 48, weight: 600 }),
				cells,
				hours
			].join(''));
		}
		case 'streak': {
			const s = p.streak;
			const b = p.biggestDay;
			return frame(kind, p, [
				s ? text('Longest streak', { y: 440, size: 56, weight: 600, fill: TEXT2 }) : '',
				s ? bigNumber(n(s.days), 680, accent) : '',
				s ? text(`days in a row · ${fmtDay(s.from)} – ${fmtDay(s.to)}`, { y: 770, size: 44, weight: 600 }) : '',
				b ? text('Biggest day', { y: 1000, size: 56, weight: 600, fill: TEXT2 }) : '',
				b ? text(fmtDay(b.day), { y: 1120, size: 96, weight: 800 }) : '',
				b ? text(`${n(b.plays)} plays · ${approx}${hoursOf(b.ms)} h`, { y: 1200, size: 44, weight: 600, fill: accent }) : '',
				b?.top ? text(`On repeat: ${clip(b.top.track, 28)} (${n(b.top.plays)}×)`, { y: 1290, size: 40, weight: 500, fill: TEXT2 }) : ''
			].join(''));
		}
		case 'month': {
			const fm = favouriteMonth(p)!;
			const max = Math.max(1, ...p.months.map((m) => m.plays));
			const bars = p.months
				.map((m, i) => {
					const h = Math.round((m.plays / max) * 560);
					const x = 96 + i * 76;
					return `<rect x="${x}" y="${1400 - h}" width="56" height="${Math.max(h, 4)}" rx="8" fill="${m.month === fm.month ? accent : TEXT2}" opacity="${m.month === fm.month ? 1 : 0.35}"/>` +
						text(MONTH_NAMES[i]!.slice(0, 1), { x: x + 28, y: 1460, size: 30, weight: 600, fill: TEXT2, anchor: 'middle' });
				})
				.join('');
			return frame(kind, p, [
				text('Your favourite month', { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				text(MONTH_NAMES[fm.month - 1]!, { y: 580, size: 120, weight: 800, fill: accent }),
				text(`${n(fm.plays)} plays · ${approx}${hoursOf(fm.ms)} h`, { y: 680, size: 44, weight: 600 }),
				bars
			].join(''));
		}
		case 'badges': {
			const types = Object.entries(p.badges.byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6);
			return frame(kind, p, [
				text('Badges earned', { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				bigNumber(n(p.badges.count), 680, accent),
				text(p.live ? 'so far this year' : `in ${p.year}`, { y: 770, size: 44, weight: 600 }),
				...types.map(([type, count], i) => [
					text('★', { y: 960 + i * 120, size: 52, weight: 700, fill: accent }),
					text(clip(badgeLabel(type), 28), { x: 180, y: 960 + i * 120, size: 46, weight: 700 }),
					text(`×${count}`, { x: 984, y: 960 + i * 120, size: 40, weight: 600, fill: TEXT2, anchor: 'end' })
				].join(''))
			].join(''));
		}
		case 'yoy': {
			const pr = p.previous;
			const rows: [string, number, number, (v: number) => string][] = [
				['Plays', t.plays, pr.plays, n],
				['Hours', t.ms, pr.ms, (v) => hoursOf(v)],
				['Artists', t.artists, pr.artists, n],
				['New artists', p.discoveries.artists, pr.newArtists, n],
				['Days listened', t.days, pr.days, n]
			];
			return frame(kind, p, [
				text(`${p.year} vs ${pr.year}`, { y: 440, size: 56, weight: 600, fill: TEXT2 }),
				text(p.live ? `same period: 1 January – ${fmtDay(p.through)}` : 'the whole year', { y: 510, size: 40, weight: 500, fill: TEXT2 }),
				...rows.map(([label, now, before, f], i) => {
					const pc = pctChange(now, before);
					const y = 680 + i * 190;
					const tone = pc === null ? TEXT2 : pc >= 0 ? accent : AMBER;
					return [
						text(label, { y, size: 44, weight: 600, fill: TEXT2 }),
						text(f(now), { y: y + 80, size: 80, weight: 800 }),
						text(`${f(before)} in ${pr.year}`, { x: 984, y: y + 30, size: 34, weight: 500, fill: TEXT2, anchor: 'end' }),
						text(pc === null ? 'new' : `${pc >= 0 ? '▲' : '▼'} ${Math.abs(pc)}%`, { x: 984, y: y + 80, size: 52, weight: 800, fill: tone, anchor: 'end' })
					].join('');
				})
			].join(''));
		}
		case 'outro':
			return frame(kind, p, [
				text(p.live ? 'To be continued' : `That was ${p.year}`, { y: 640, size: 96, weight: 800 }),
				text(t.plays ? `${n(t.plays)} plays · ${approx}${hoursOf(t.ms)} hours` : 'Nothing to show for this year', { y: 740, size: 48, weight: 600, fill: accent }),
				text(p.topTracks.length ? `Your top ${Math.min(100, p.topTracks.length)} is ready to play` : '', { y: 830, size: 44, weight: 500, fill: TEXT2 })
			].join(''));
	}
}

/** Accessible one-line description of a card (alt text, screen readers). */
export function describeCard(kind: CardKind, p: WrappedPayload): string {
	const t = p.totals;
	switch (kind) {
		case 'intro':
			return `Rotor Wrapped ${p.year}${p.live ? `, so far through ${fmtDay(p.through)}` : ''}`;
		case 'totals':
			return `${n(t.plays)} plays, ${approxMark(p)}${hoursOf(t.ms)} hours, on ${n(t.days)} days`;
		case 'top_artists':
			return `Top artist: ${p.topArtists[0]?.artist}, ${n(p.topArtists[0]?.plays ?? 0)} plays`;
		case 'top_tracks':
			return `Top track: ${p.topTracks[0]?.track} by ${p.topTracks[0]?.artist}, ${n(p.topTracks[0]?.plays ?? 0)} plays`;
		case 'discoveries':
			return `${n(p.discoveries.artists)} new artists and ${n(p.discoveries.tracks)} new tracks`;
		case 'comebacks':
			return `${n(p.comebacks.artists)} artists and ${n(p.comebacks.tracks)} tracks came back after 12+ months`;
		case 'clock': {
			const pk = peakHour(p.clock);
			return pk ? `You listened most on ${DOW_NAMES[pk.dow]} around ${pk.hour}:00` : 'Listening clock';
		}
		case 'streak':
			return `Longest streak ${p.streak?.days ?? 0} days; biggest day ${fmtDay(p.biggestDay?.day)} with ${n(p.biggestDay?.plays ?? 0)} plays`;
		case 'month': {
			const fm = favouriteMonth(p);
			return fm ? `Favourite month: ${MONTH_NAMES[fm.month - 1]}, ${n(fm.plays)} plays` : 'Months';
		}
		case 'badges':
			return `${n(p.badges.count)} badges earned`;
		case 'yoy':
			return `${p.year} compared with ${p.previous.year}: ${n(t.plays)} plays vs ${n(p.previous.plays)}`;
		case 'outro':
			return p.live ? 'To be continued' : `That was ${p.year}`;
	}
}

/** Browser only: draw an SVG string into a canvas and return a PNG blob. */
export async function svgToPng(svg: string, width = CARD_W, height = CARD_H): Promise<Blob> {
	const img = new Image();
	img.decoding = 'async';
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await img.decode();
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas is not available');
	ctx.drawImage(img, 0, 0, width, height);
	return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('PNG export failed'))), 'image/png'));
}
