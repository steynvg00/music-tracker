import { describe, expect, it } from 'vitest';
import { fakeFetch, fakeSql } from '$lib/server/test-helpers';
import { BadInput } from '$lib/shared/custom';
import { RELAY_MAX_WAIT_MS, logEvent, saveMixItems, scheduleRelay, sessionSummary, setProgress } from './mixes';

const T = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;
const M = '00000000-0000-4000-8000-0000000000aa';

describe('saveMixItems', () => {
	it('stores Spotify items as URI + a text snapshot from your own history (no Spotify call)', async () => {
		const { sql, queries } = fakeSql((q) => {
			if (q.text.includes('FROM hub.mv_track_stats')) return [{ track_uri: T(1), track_name: 'One', artist_name: 'A' }];
			if (q.text.includes('FROM media_items')) return [{ id: M, source: 'youtube', title: 'Vid', artist_display: 'Ch', duration_ms: 1000 }];
			if (q.text.startsWith('UPDATE mixes')) return [{ id: 'mix' }];
			return [];
		});
		await saveMixItems(sql, 'mix', [{ source: 'spotify', spotifyUri: T(1) }, { source: 'youtube', mediaItemId: M }]);
		const inserts = queries.filter((q) => q.text.startsWith('INSERT INTO mix_items'));
		expect(inserts).toHaveLength(2);
		expect(inserts[0]!.values).toEqual(['mix', 0, 'spotify', T(1), null, 'One', 'A', null]);
		expect(inserts[1]!.values.slice(0, 6)).toEqual(['mix', 1, 'youtube', null, M, 'Vid']);
	});
	it('refuses non-track URIs, unknown media items and oversize mixes', async () => {
		const { sql } = fakeSql(() => []);
		await expect(saveMixItems(sql, 'mix', [{ source: 'spotify', spotifyUri: 'spotify:playlist:x' }])).rejects.toBeInstanceOf(BadInput);
		await expect(saveMixItems(sql, 'mix', [{ source: 'youtube', mediaItemId: 'nope' }])).rejects.toBeInstanceOf(BadInput);
		await expect(saveMixItems(sql, 'mix', Array.from({ length: 201 }, () => ({ source: 'spotify', spotifyUri: T(1) })))).rejects.toBeInstanceOf(BadInput);
	});
});

describe('telemetry', () => {
	it('logs only known outcomes and sources; clamps the gap', async () => {
		const { sql, queries } = fakeSql(() => []);
		await logEvent(sql, 's', { from: 'spotify', to: 'youtube', outcome: 'ok', gapMs: 1234.4, position: 2 });
		expect(queries[0]!.values.slice(0, 6)).toEqual(['s', 'spotify', 'youtube', 2, 'ok', 1234]);
		await expect(logEvent(sql, 's', { outcome: 'great' })).rejects.toBeInstanceOf(BadInput);
		await expect(logEvent(sql, 's', { outcome: 'ok', from: 'vimeo' })).rejects.toBeInstanceOf(BadInput);
		await expect(setProgress(sql, 's', -1)).rejects.toBeInstanceOf(BadInput);
	});
	it('the summary counts ok handoffs and the median gap', async () => {
		const { sql } = fakeSql((q) => {
			if (q.text.includes('FROM playback_sessions')) return [{ id: 's', mix_id: 'm', mode: 'laptop', started_at: new Date(), ended_at: null }];
			return [
				{ at: new Date(), from_source: 'spotify', to_source: 'youtube', outcome: 'ok', gap_ms: 800, position: 2 },
				{ at: new Date(), from_source: 'youtube', to_source: 'spotify', outcome: 'ok', gap_ms: 1600, position: 3 },
				{ at: new Date(), from_source: 'spotify', to_source: null, outcome: 'spotify_autoplay', gap_ms: null, position: 3 },
				{ at: new Date(), from_source: 'spotify', to_source: 'soundcloud', outcome: 'ok', gap_ms: 2400, position: 4 }
			];
		});
		const s = await sessionSummary(sql, 's');
		expect(s).toMatchObject({ handoffs: 3, okHandoffs: 3, medianGapMs: 1600 });
	});
});

describe('scheduleRelay', () => {
	const cfg = { githubDispatchToken: 'tok', githubRepository: 'o/r' };
	it('enqueues one mix_relay job per session + position and dispatches hub-jobs.yml', async () => {
		const ff = fakeFetch(() => ({ status: 204 }));
		const { sql, queries } = fakeSql((q) => {
			if (q.text.includes('FROM playback_sessions')) return [{ mix_id: 'm', mode: 'relay' }];
			if (q.text.startsWith('INSERT INTO hub_jobs')) return [{ id: 'j1', kind: 'mix_relay', payload: {}, status: 'queued', attempts: 0, requested_at: new Date(), started_at: null, finished_at: null, result: null, error: null, run_url: null }];
			return [];
		});
		const r = await scheduleRelay(sql, cfg, 's1', { inMs: 90_000, position: 3, label: 'YouTube' }, ff.fetch);
		expect(r.created).toBe(true);
		const ins = queries.find((q) => q.text.startsWith('INSERT INTO hub_jobs'))!;
		expect(ins.values[0]).toBe('mix_relay');
		expect(JSON.parse(ins.values[1] as string)).toMatchObject({ session_id: 's1', mix_id: 'm', position: 3, label: 'YouTube', capped: false });
		expect(ins.values[2]).toBe('mix_relay:s1:3');
		expect(ff.calls[0]!.url.pathname).toBe('/repos/o/r/actions/workflows/hub-jobs.yml/dispatches');
	});
	it('caps the wait to what a hub-jobs run can hold', async () => {
		const ff = fakeFetch(() => ({ status: 204 }));
		const { sql, queries } = fakeSql((q) => {
			if (q.text.includes('FROM playback_sessions')) return [{ mix_id: 'm', mode: 'relay' }];
			if (q.text.startsWith('INSERT INTO hub_jobs')) return [{ id: 'j', requested_at: new Date() }];
			return [];
		});
		await scheduleRelay(sql, cfg, 's1', { inMs: 3_600_000, position: 1 }, ff.fetch);
		const p = JSON.parse(queries.find((q) => q.text.startsWith('INSERT INTO hub_jobs'))!.values[1] as string);
		expect(p.capped).toBe(true);
		expect(Date.parse(p.notify_at) - Date.now()).toBeLessThanOrEqual(RELAY_MAX_WAIT_MS + 1000);
	});
	it('refuses without a running session', async () => {
		const { sql } = fakeSql(() => []);
		await expect(scheduleRelay(sql, cfg, 's1', { inMs: 1, position: 1 })).rejects.toBeInstanceOf(BadInput);
	});
});
