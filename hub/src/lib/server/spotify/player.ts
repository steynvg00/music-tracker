/**
 * Player proxy logic: normalise Spotify's playback state and validate commands.
 * The browser never sees a Spotify token on phones; it calls /api/player/* and the
 * server forwards with an explicit device_id (04-architecture.md §6.2).
 */
import type {
	PlayBody,
	PlayerCommand,
	PlayerDevice,
	PlayerItem,
	PlayerSnapshot,
	RepeatState
} from '$lib/shared/player-types';
import { CONTEXT_URI, PLAYABLE_URI, type HttpMethod } from './api';

interface RawImage {
	url: string;
	width?: number | null;
}
interface RawDevice {
	id: string | null;
	name: string;
	type: string;
	is_active?: boolean;
	is_restricted?: boolean;
	supports_volume?: boolean;
	volume_percent?: number | null;
}
interface RawItem {
	uri: string;
	type?: string;
	name: string;
	duration_ms: number;
	is_local?: boolean;
	artists?: { name: string; uri?: string }[];
	album?: { name?: string; images?: RawImage[] };
	show?: { name?: string; images?: RawImage[] };
	images?: RawImage[];
}
export interface RawPlayback {
	device?: RawDevice;
	item?: RawItem | null;
	context?: { uri: string; type: string } | null;
	is_playing?: boolean;
	progress_ms?: number | null;
	shuffle_state?: boolean;
	repeat_state?: string;
	actions?: { disallows?: Record<string, boolean> };
}

export const INACTIVE: PlayerSnapshot = {
	active: false,
	device: null,
	item: null,
	context: null,
	isPlaying: false,
	progressMs: 0,
	shuffle: false,
	repeat: 'off',
	disallows: {}
};

function pickImages(images: RawImage[] | undefined): { small: string | null; large: string | null } {
	if (!images?.length) return { small: null, large: null };
	const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
	const medium = sorted.find((i) => (i.width ?? 0) <= 320) ?? sorted[sorted.length - 1]!;
	return { small: medium.url, large: sorted[0]!.url };
}

export function normalizeDevice(d: RawDevice): PlayerDevice {
	return {
		id: d.id ?? null,
		name: d.name,
		type: d.type,
		isActive: !!d.is_active,
		isRestricted: !!d.is_restricted,
		supportsVolume: !!d.supports_volume,
		volumePercent: d.volume_percent ?? null
	};
}

export function normalizeItem(i: RawItem | null | undefined): PlayerItem | null {
	if (!i?.uri) return null;
	const imgs = pickImages(i.album?.images ?? i.images ?? i.show?.images);
	const episode = i.type === 'episode';
	return {
		uri: i.uri,
		type: episode ? 'episode' : 'track',
		name: i.name,
		artists: episode
			? [{ name: i.show?.name ?? '', uri: null }]
			: (i.artists ?? []).map((a) => ({ name: a.name, uri: a.uri ?? null })),
		albumName: i.album?.name ?? i.show?.name ?? null,
		imageUrl: imgs.small,
		imageUrlLarge: imgs.large,
		durationMs: i.duration_ms ?? 0,
		isLocal: !!i.is_local
	};
}

function repeatState(v: string | undefined): RepeatState {
	return v === 'track' || v === 'context' ? v : 'off';
}

/** GET /me/player body → snapshot. `null` (Spotify answered 204) → inactive. */
export function normalizePlayback(raw: RawPlayback | null): PlayerSnapshot {
	if (!raw || !raw.device) return INACTIVE;
	return {
		active: true,
		device: normalizeDevice(raw.device),
		item: normalizeItem(raw.item),
		context: raw.context?.uri ? { uri: raw.context.uri, type: raw.context.type } : null,
		isPlaying: !!raw.is_playing,
		progressMs: raw.progress_ms ?? 0,
		shuffle: !!raw.shuffle_state,
		repeat: repeatState(raw.repeat_state),
		disallows: { ...(raw.actions?.disallows ?? {}) }
	};
}

export class BadCommand extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BadCommand';
	}
}

export interface SpotifyCall {
	method: HttpMethod;
	path: string;
	query?: Record<string, string | number | boolean>;
	body?: unknown;
}

const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;

function deviceQuery(input: Record<string, unknown>): Record<string, string> {
	const id = input.device_id;
	if (id === undefined || id === null || id === '') return {};
	if (typeof id !== 'string' || !DEVICE_ID.test(id)) throw new BadCommand('device_id is invalid');
	return { device_id: id };
}

function intIn(v: unknown, name: string, min: number, max: number): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BadCommand(`${name} must be an integer ${min}..${max}`);
	return v;
}

export function validatePlayBody(input: Record<string, unknown>): PlayBody {
	const body: PlayBody = {};
	if (input.context_uri !== undefined) {
		if (typeof input.context_uri !== 'string' || !CONTEXT_URI.test(input.context_uri)) throw new BadCommand('context_uri is invalid');
		body.context_uri = input.context_uri;
	}
	if (input.uris !== undefined) {
		if (!Array.isArray(input.uris) || input.uris.length === 0 || input.uris.length > 100) throw new BadCommand('uris must be 1..100 URIs');
		for (const u of input.uris) if (typeof u !== 'string' || !PLAYABLE_URI.test(u)) throw new BadCommand('uris contains an invalid URI');
		body.uris = input.uris as string[];
	}
	if (body.context_uri && body.uris) throw new BadCommand('use context_uri or uris, not both');
	if (input.offset !== undefined) {
		const o = input.offset as Record<string, unknown>;
		if (o && typeof o.position === 'number') body.offset = { position: intIn(o.position, 'offset.position', 0, 10_000) };
		else if (o && typeof o.uri === 'string' && PLAYABLE_URI.test(o.uri)) body.offset = { uri: o.uri };
		else throw new BadCommand('offset is invalid');
	}
	if (input.position_ms !== undefined) body.position_ms = intIn(input.position_ms, 'position_ms', 0, 24 * 3600 * 1000);
	return body;
}

/** Map a proxy command + JSON body to exactly one Spotify call. */
export function buildCommand(command: PlayerCommand, input: Record<string, unknown>): SpotifyCall {
	const q = deviceQuery(input);
	switch (command) {
		case 'play': {
			const { context_uri, uris, offset, position_ms } = validatePlayBody(input);
			const body: Record<string, unknown> = {};
			if (context_uri) body.context_uri = context_uri;
			if (uris) body.uris = uris;
			if (offset) body.offset = offset;
			if (position_ms !== undefined) body.position_ms = position_ms;
			return { method: 'PUT', path: '/me/player/play', query: q, body: Object.keys(body).length ? body : undefined };
		}
		case 'pause':
			return { method: 'PUT', path: '/me/player/pause', query: q };
		case 'next':
			return { method: 'POST', path: '/me/player/next', query: q };
		case 'previous':
			return { method: 'POST', path: '/me/player/previous', query: q };
		case 'seek':
			return { method: 'PUT', path: '/me/player/seek', query: { ...q, position_ms: intIn(input.position_ms, 'position_ms', 0, 24 * 3600 * 1000) } };
		case 'volume':
			return { method: 'PUT', path: '/me/player/volume', query: { ...q, volume_percent: intIn(input.volume_percent, 'volume_percent', 0, 100) } };
		case 'shuffle':
			if (typeof input.state !== 'boolean') throw new BadCommand('state must be a boolean');
			return { method: 'PUT', path: '/me/player/shuffle', query: { ...q, state: input.state } };
		case 'repeat':
			if (input.state !== 'off' && input.state !== 'track' && input.state !== 'context') throw new BadCommand('state must be off|track|context');
			return { method: 'PUT', path: '/me/player/repeat', query: { ...q, state: input.state } };
		case 'transfer': {
			if (!q.device_id) throw new BadCommand('transfer needs device_id');
			return { method: 'PUT', path: '/me/player', body: { device_ids: [q.device_id], play: input.play === true } };
		}
		case 'queue': {
			if (typeof input.uri !== 'string' || !PLAYABLE_URI.test(input.uri)) throw new BadCommand('uri is invalid');
			return { method: 'POST', path: '/me/player/queue', query: { ...q, uri: input.uri } };
		}
	}
}

/** Pick a wake target: prefer the requested type (a phone after "Open Spotify"), never restricted devices. */
export function pickWakeDevice(devices: PlayerDevice[], prefer: string | null, knownIds: string[] = []): PlayerDevice | null {
	const usable = devices.filter((d) => d.id && !d.isRestricted);
	if (!usable.length) return null;
	const fresh = usable.filter((d) => !knownIds.includes(d.id!));
	const pool = fresh.length ? fresh : usable;
	return (
		(prefer && pool.find((d) => d.type.toLowerCase() === prefer.toLowerCase())) ||
		pool.find((d) => d.isActive) ||
		pool[0] ||
		null
	);
}
