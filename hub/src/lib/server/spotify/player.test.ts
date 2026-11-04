import { describe, expect, it } from 'vitest';
import { BadCommand, buildCommand, INACTIVE, normalizePlayback, pickWakeDevice } from './player';
import type { PlayerDevice } from '$lib/shared/player-types';

const TRACK = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC';
const PL = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';
const DEV = 'abcdef0123456789abcdef0123456789abcdef01';

describe('normalizePlayback', () => {
	it('204 / no device → inactive', () => {
		expect(normalizePlayback(null)).toEqual(INACTIVE);
		expect(normalizePlayback({})).toEqual(INACTIVE);
	});
	it('maps a playing track with device, context and disallows', () => {
		const s = normalizePlayback({
			device: { id: DEV, name: 'iPhone', type: 'Smartphone', is_active: true, supports_volume: false, volume_percent: 100 },
			item: {
				uri: TRACK,
				type: 'track',
				name: 'Born To Lead',
				duration_ms: 258000,
				artists: [{ name: 'Radical Redemption', uri: 'spotify:artist:x' }],
				album: { name: 'Born To Lead', images: [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }] }
			},
			context: { uri: PL, type: 'playlist' },
			is_playing: true,
			progress_ms: 1234,
			shuffle_state: true,
			repeat_state: 'context',
			actions: { disallows: { seeking: true } }
		});
		expect(s).toMatchObject({
			active: true,
			isPlaying: true,
			progressMs: 1234,
			shuffle: true,
			repeat: 'context',
			disallows: { seeking: true },
			device: { name: 'iPhone', supportsVolume: false, isActive: true },
			item: { name: 'Born To Lead', imageUrl: 'mid', imageUrlLarge: 'big', durationMs: 258000 },
			context: { uri: PL }
		});
	});
});

describe('buildCommand', () => {
	it('play a context on an explicit device', () => {
		expect(buildCommand('play', { device_id: DEV, context_uri: PL, offset: { position: 0 } })).toEqual({
			method: 'PUT',
			path: '/me/player/play',
			query: { device_id: DEV },
			body: { context_uri: PL, offset: { position: 0 } }
		});
	});
	it('resume without a body', () => {
		expect(buildCommand('play', {})).toEqual({ method: 'PUT', path: '/me/player/play', query: {}, body: undefined });
	});
	it.each([
		['seek', { position_ms: 61000 }, { method: 'PUT', path: '/me/player/seek', query: { position_ms: 61000 } }],
		['volume', { volume_percent: 40, device_id: DEV }, { method: 'PUT', path: '/me/player/volume', query: { device_id: DEV, volume_percent: 40 } }],
		['shuffle', { state: true }, { method: 'PUT', path: '/me/player/shuffle', query: { state: true } }],
		['repeat', { state: 'track' }, { method: 'PUT', path: '/me/player/repeat', query: { state: 'track' } }],
		['next', {}, { method: 'POST', path: '/me/player/next', query: {} }],
		['queue', { uri: TRACK }, { method: 'POST', path: '/me/player/queue', query: { uri: TRACK } }],
		['transfer', { device_id: DEV, play: true }, { method: 'PUT', path: '/me/player', body: { device_ids: [DEV], play: true } }]
	] as const)('%s', (cmd, input, expected) => {
		expect(buildCommand(cmd, input as Record<string, unknown>)).toEqual(expected);
	});
	it.each([
		['play', { context_uri: 'spotify:playlist:../../me' }],
		['play', { uris: ['spotify:track:short'] }],
		['play', { context_uri: PL, uris: [TRACK] }],
		['seek', { position_ms: -1 }],
		['volume', { volume_percent: 101 }],
		['shuffle', { state: 'yes' }],
		['repeat', { state: 'forever' }],
		['transfer', {}],
		['queue', { uri: PL }],
		['pause', { device_id: 'bad id with spaces' }]
	] as const)('rejects %s %o', (cmd, input) => {
		expect(() => buildCommand(cmd, input as Record<string, unknown>)).toThrow(BadCommand);
	});
	it('accepts the Liked Songs collection as a context', () => {
		expect(buildCommand('play', { context_uri: 'spotify:user:owner:collection' }).body).toEqual({ context_uri: 'spotify:user:owner:collection' });
	});
});

describe('pickWakeDevice', () => {
	const d = (id: string, type: string, extra: Partial<PlayerDevice> = {}): PlayerDevice => ({
		id,
		name: id,
		type,
		isActive: false,
		isRestricted: false,
		supportsVolume: true,
		volumePercent: 50,
		...extra
	});
	it('prefers a newly appeared phone over known devices', () => {
		expect(pickWakeDevice([d('laptop', 'Computer'), d('phone', 'Smartphone')], 'Smartphone', ['laptop'])?.id).toBe('phone');
	});
	it('never picks restricted devices', () => {
		expect(pickWakeDevice([d('tv', 'TV', { isRestricted: true })], null)).toBeNull();
	});
	it('falls back to any usable device', () => {
		expect(pickWakeDevice([d('speaker', 'Speaker')], 'Smartphone')?.id).toBe('speaker');
		expect(pickWakeDevice([], 'Smartphone')).toBeNull();
	});
});
