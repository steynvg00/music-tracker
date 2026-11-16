/**
 * v0.94: own tracks (unreleased / IDs), DJ / live sets, uploads through swappable S3 storage.
 * Storage is the in-process fake (e2e/mock/fake-s3.mjs, two backends on 55436/55437): never a real bucket.
 * MusicBrainz, YouTube oEmbed and Spotify are the existing mocks.
 */
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, mock, sql, sqlNum } from './fixtures';

const S3 = 'http://127.0.0.1:55436';
const S3_DEST = 'http://127.0.0.1:55437';
const origin = { Origin: process.env.E2E_BASE_URL ?? 'http://localhost:47173', 'Content-Type': 'application/json' };
const MB = 1024 * 1024;

/** A silent 8-bit mono PCM WAV of exactly `bytes` bytes (8 kHz: 8000 bytes per second). */
function wav(bytes: number): Buffer {
	const data = bytes - 44;
	const b = Buffer.alloc(bytes, 128);
	b.write('RIFF', 0);
	b.writeUInt32LE(bytes - 8, 4);
	b.write('WAVEfmt ', 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20); // PCM
	b.writeUInt16LE(1, 22); // mono
	b.writeUInt32LE(8000, 24);
	b.writeUInt32LE(8000, 28);
	b.writeUInt16LE(1, 32);
	b.writeUInt16LE(8, 34);
	b.write('data', 36);
	b.writeUInt32LE(data, 40);
	return b;
}
const fake = {
	async control(c: Record<string, unknown>, base = S3) {
		await fetch(`${base}/__fake/control`, { method: 'POST', body: JSON.stringify(c) });
	},
	async state(base = S3): Promise<{ objects: { key: string; size: number; sha256: string }[]; uploads: number; log: string[] }> {
		return (await fetch(`${base}/__fake/objects`)).json();
	}
};
function artist(n = 0): { id: string; name: string } {
	// A plain name (no "&", ",", " x ", " and ", " vs"): the embed-title parser would split it.
	const [id, name] = sql(
		`SELECT artist_id || '|' || artist_name FROM hub.mv_artist_stats WHERE artist_name !~* '(,|&|\\| | x | and | vs|feat)' AND artist_name ~ '^[A-Za-z0-9 .]+$' ORDER BY plays DESC, artist_id OFFSET ${n} LIMIT 1`
	).split('|');
	return { id: id!, name: name! };
}
function catalogTrack(): { uri: string; name: string; artist: string } {
	const [uri, name, a] = sql(
		`SELECT track_uri || '|' || track_name || '|' || artist_name FROM hub.mv_track_stats WHERE track_uri LIKE 'spotify:track:%' AND track_name ~ '^[A-Za-z0-9 ]+$' AND track_name ~ '[A-Za-z]{4,}' AND artist_name !~ '[|&]' ORDER BY plays DESC LIMIT 1`
	).split('|');
	return { uri: uri!, name: name!, artist: a!.split(', ')[0]! };
}
async function uploadViaApi(page: Page, name: string, body: Buffer, purpose: 'track' | 'set' | 'cover' = 'track'): Promise<string> {
	const t = await (await page.request.post('/api/media/uploads', { headers: origin, data: { purpose, name, size: body.length, type: 'audio/wav' } })).json();
	expect(t.mode).toBe('single');
	const put = await fetch(t.url, { method: 'PUT', body });
	expect(put.status).toBe(200);
	const done = await page.request.post(`/api/media/uploads/${t.id}/complete`, { headers: origin });
	expect(done.status()).toBe(200);
	return t.id as string;
}
async function createOwn(page: Page, body: Record<string, unknown>) {
	const a = artist();
	const res = await page.request.post('/api/own', {
		headers: origin,
		data: { status: 'unreleased', durationMs: 200_000, artists: { primary: [{ kind: 'spotify', id: a.id, name: a.name }] }, youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ', confirmDuplicate: true, ...body }
	});
	expect(res.status(), await res.text()).toBe(201);
	return res.json();
}
function reset() {
	sql(`DELETE FROM library_items WHERE item_key LIKE 'rotor:own:%' OR item_key LIKE 'rotor:set:%' OR item_key LIKE 'rotor:list:%';
	     DELETE FROM dj_set_tracks; DELETE FROM dj_set_artists; DELETE FROM own_plays; DELETE FROM rotor_list_items; DELETE FROM rotor_lists;
	     UPDATE own_tracks SET heard_set_id = NULL; DELETE FROM dj_sets; DELETE FROM own_track_artists; DELETE FROM own_tracks;
	     DELETE FROM media_objects; DELETE FROM rotor_artists`);
}
async function pickArtist(page: Page, role: string, name: string) {
	await page.locator(`#ap-${role}`).fill(name);
	await page.getByTestId(`artists-${role}`).getByRole('option').filter({ hasText: 'in your data' }).first().getByRole('button').click();
}

test.describe('v0.94 own tracks, sets, uploads', () => {
	test.beforeEach(() => reset());

	test('V094-01 required fields: nothing saves with a missing or placeholder value (form, API, database) @both', async ({ page }) => {
		await page.goto('/own/new');
		await page.getByTestId('ot-save').click();
		for (const id of ['err-title', 'err-status', 'err-duration', 'err-source']) await expect(page.getByTestId(id)).toBeVisible();
		await expect(page.getByTestId('artists-primary').locator('.err')).toBeVisible();
		await page.getByTestId('ot-title').fill('Unknown');
		await expect(page.getByTestId('err-title')).toContainText('placeholder');
		await page.getByTestId('ot-title').fill('Night Drive');
		await expect(page.getByTestId('err-title')).toHaveCount(0);
		// Creating "ID - ID" as an artist is refused too.
		await page.locator('#ap-primary').fill('ID - ID');
		await page.getByTestId('create-artist').click();
		await expect(page.getByTestId('artists-primary').locator('.err')).toContainText('placeholder');
		expect(sqlNum(`SELECT count(*) FROM own_tracks`)).toBe(0);

		// API: same rules, per field.
		const a = artist();
		const r = await page.request.post('/api/own', { headers: origin, data: { title: '?', status: 'id', durationMs: '', artists: { primary: [{ kind: 'spotify', id: a.id, name: a.name }] } } });
		expect(r.status()).toBe(400);
		const body = await r.json();
		expect(Object.keys(body.fields).sort()).toEqual(['duration', 'source', 'title']);
		const free = await page.request.post('/api/own', { headers: origin, data: { title: 'X', status: 'id', durationMs: 1000, artists: { primary: [{ kind: 'rotor', id: '2d2c6f0e-1f7a-4b39-9a35-6f1c0b1c2d3e', name: 'Nobody' }] }, youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' } });
		expect(free.status()).toBe(400); // an artist that isn't in your data (and wasn't created) can't be linked
		// Database: the CHECKs refuse placeholders even if the app were bypassed.
		expect(() => sql(`INSERT INTO own_tracks (title, status, duration_ms, youtube_id, dupe_key) VALUES ('ID - ID', 'id', 1000, 'dQw4w9WgXcQ', 'x')`)).toThrow();
		expect(() => sql(`INSERT INTO own_tracks (title, status, duration_ms, dupe_key) VALUES ('Real', 'id', 1000, 'x')`)).toThrow(); // no source
	});

	test('V094-02 duplicate check against own tracks and your catalog @laptop', async ({ page }) => {
		const a = artist();
		await createOwn(page, { title: 'Night Drive', version: 'Extended Mix' });
		await page.goto('/own/new');
		await page.getByTestId('ot-title').fill('night drive (extended mix)');
		await pickArtist(page, 'primary', a.name);
		await expect(page.getByTestId('duplicates')).toContainText('Night Drive (Extended Mix)');
		// API: 409 with the matches, then created when confirmed.
		const body = { title: 'Night Drive', version: 'Extended Mix', status: 'unreleased', durationMs: 200_000, artists: { primary: [{ kind: 'spotify', id: a.id, name: a.name }] }, youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' };
		const r = await page.request.post('/api/own', { headers: origin, data: body });
		expect(r.status()).toBe(409);
		expect((await r.json()).matches[0]).toMatchObject({ kind: 'own', strength: 'exact' });
		expect((await page.request.post('/api/own', { headers: origin, data: { ...body, confirmDuplicate: true } })).status()).toBe(201);
		// A track you already played on Spotify is found too.
		const c = catalogTrack();
		const m = await (await page.request.post('/api/own/duplicates', { headers: origin, data: { title: c.name, artists: [c.artist] } })).json();
		expect(m.matches.some((x: { kind: string; id: string }) => x.kind === 'catalog' && x.id === c.uri)).toBe(true);
	});

	test('V094-03 a 6 MB file goes straight to storage with a signed URL (never through the hub), duration read from the file @laptop', async ({ page }) => {
		const puts: string[] = [];
		const hubBodies: number[] = [];
		page.on('request', (req) => {
			const u = new URL(req.url());
			if (req.method() === 'PUT' && u.port === '55436') puts.push(u.pathname);
			if (u.port !== '55436' && u.port !== '55437') hubBodies.push(req.postDataBuffer()?.length ?? 0);
		});
		await page.goto('/own/new');
		const file = wav(6 * MB);
		await page.getByTestId('upload-track-input').setInputFiles({ name: 'big.wav', mimeType: 'audio/wav', buffer: file });
		await expect(page.getByTestId('upload-track-progress')).toBeVisible();
		await expect(page.getByTestId('upload-track-status')).toContainText('Uploaded', { timeout: 30_000 });
		await expect(page.getByTestId('ot-duration')).toHaveValue(/^13:0\d$/); // 6 MB of 8 kHz audio ≈ 13:06
		expect(puts.length).toBeGreaterThan(0); // the bytes went to storage …
		expect(Math.max(0, ...hubBodies)).toBeLessThan(64 * 1024); // … and the hub only saw small JSON (Vercel's 4.5 MB limit)
		const st = await fake.state();
		const obj = st.objects.find((o) => o.size === file.length);
		expect(obj?.key).toMatch(/^tracks\/[0-9a-f-]{36}\.wav$/);
		expect(st.log.some((l) => /^PUT tracks\/[0-9a-f-]{36}\.wav( part=\d+)?$/.test(l))).toBe(true); // signed URL accepted by the fake's SigV4 check
		expect(st.log.some((l) => l.includes('→'))).toBe(false); // no refused request
		// Save it as a track with the file as its only source.
		await page.getByTestId('ot-title').fill('Big File Track');
		await pickArtist(page, 'primary', artist().name);
		await page.getByText('Unreleased', { exact: true }).click();
		await page.getByTestId('ot-save').click();
		await expect(page.getByTestId('own-detail')).toContainText('Big File Track');
		expect(sql(`SELECT m.size_bytes || ':' || m.status FROM own_tracks t JOIN media_objects m ON m.id = t.audio_object_id`)).toBe(`${file.length}:ready`);
		expect(sqlNum(`SELECT duration_ms FROM own_tracks`)).toBeGreaterThan(780_000);
	});

	test('V094-04 an interrupted multipart upload resumes from the parts storage already has @laptop', async ({ page }) => {
		await page.goto('/own/new');
		const file = wav(12 * MB); // 3 parts of 5 MB (MEDIA_PART_MB=5)
		await fake.control({ failPart: 2 });
		await page.getByTestId('upload-track-input').setInputFiles({ name: 'resume.wav', mimeType: 'audio/wav', buffer: file });
		await expect(page.getByTestId('upload-track-status')).toContainText('Interrupted', { timeout: 30_000 });
		const id = sql(`SELECT id FROM media_objects WHERE status = 'uploading' ORDER BY created_at DESC LIMIT 1`);
		await page.waitForTimeout(500); // let any sibling part finish its report
		const before = await (await page.request.get(`/api/media/uploads/${id}`)).json();
		expect(before.partCount).toBe(3);
		expect(before.done).not.toContain(2);
		const logLen = (await fake.state()).log.length;
		await page.getByTestId('upload-track-resume').click();
		await expect(page.getByTestId('upload-track-status')).toContainText(/Resuming|Uploaded/);
		await expect(page.getByTestId('upload-track-status')).toContainText('Uploaded', { timeout: 30_000 });
		const after = (await fake.state()).log.slice(logLen).filter((l) => / part=\d+$/.test(l));
		const resent = after.map((l) => Number(/part=(\d+)$/.exec(l)![1]));
		expect(resent).toContain(2);
		for (const n of before.done) expect(resent).not.toContain(n); // finished parts are not uploaded again
		const st = await fake.state();
		expect(st.objects.find((o) => o.key.includes(id))?.size).toBe(file.length);
		expect(sql(`SELECT status FROM media_objects WHERE id = '${id}'`)).toBe('ready');
		// Cancel: a second upload, cancelled → aborted in storage and forgotten.
		await page.getByRole('button', { name: 'Use another file' }).click();
		await page.getByTestId('upload-track-input').setInputFiles({ name: 'cancel.wav', mimeType: 'audio/wav', buffer: wav(16 * MB) });
		await page.getByTestId('upload-track-cancel').click();
		await expect.poll(() => sqlNum(`SELECT count(*) FROM media_objects WHERE status = 'uploading'`)).toBe(0);
	});

	test('V094-05 playback: short-lived signed URLs that expire and are renewed; Spotify pauses first @laptop', async ({ page }) => {
		const mediaId = await uploadViaApi(page, 'play.wav', wav(160_044)); // 20 s
		const t = await createOwn(page, { title: 'Play Me', durationMs: 20_000, youtubeUrl: null, audioObjectId: mediaId });
		const p = await (await page.request.get(`/api/media/${mediaId}/play`)).json();
		expect(new Date(p.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(4_500); // MEDIA_PLAYBACK_URL_TTL_S=4
		expect((await fetch(p.url, { headers: { Range: 'bytes=0-99' } })).status).toBe(206);
		await page.waitForTimeout(5_000);
		const expired = await fetch(p.url);
		expect(expired.status).toBe(403);
		expect(await expired.text()).toContain('expired');
		// Spotify is playing on the iPhone: Rotor pauses it before its own player starts.
		const st = await mock.state();
		st.playback.is_playing = true;
		st.playback.device_id = 'dev-iphone';
		for (const d of st.devices) d.is_active = d.id === 'dev-iphone';
		await mock.set({ playback: st.playback, devices: st.devices });
		await page.addInitScript(() => localStorage.setItem('rotor.sdk', 'off'));
		await page.goto(`/own/${t.id}`);
		await expect(page.getByRole('button', { name: 'Pause', exact: true }).filter({ visible: true }).first()).toBeVisible();
		await mock.resetCalls();
		await page.getByTestId('own-play').click();
		await expect(page.getByTestId('own-player')).toHaveAttribute('data-playing', 'true');
		const calls = await mock.calls();
		expect(calls.some((c) => c.method === 'PUT' && c.path === '/v1/me/player/pause')).toBe(true);
		expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe('Play Me');
		// The URL in the <audio> has expired by now: a playback error renews it and continues.
		await page.waitForTimeout(4_500);
		await page.evaluate(() => document.querySelector('audio[data-testid="own-audio"]')!.dispatchEvent(new Event('error')));
		await expect(page.getByTestId('own-player')).toHaveAttribute('data-refreshes', /[1-9]/);
		await expect(page.getByTestId('own-player')).toHaveAttribute('data-playing', 'true');
		expect(await page.evaluate(() => (document.querySelector('audio[data-testid="own-audio"]') as HTMLAudioElement).currentTime)).toBeGreaterThan(3); // continued, not restarted
		// No Spotify playlist was touched.
		expect((await mock.writes()).filter((c) => c.path.includes('/playlists'))).toEqual([]);
	});

	test('V094-06 plays of own tracks are recorded apart from Spotify plays and stats @laptop', async ({ page }) => {
		const spotifyBefore = sqlNum(`SELECT count(*) FROM spotify_plays`);
		const overviewBefore = await (await page.request.get('/api/stats/overview')).json();
		const mediaId = await uploadViaApi(page, 'short.wav', wav(24_044)); // 2.5 s
		const t = await createOwn(page, { title: 'Short One', durationMs: 2_500, youtubeUrl: null, audioObjectId: mediaId });
		await page.goto(`/own/${t.id}`);
		await page.getByTestId('own-play').click();
		await expect.poll(() => sqlNum(`SELECT count(*) FROM own_plays WHERE own_track_id = '${t.id}'`), { timeout: 15_000 }).toBe(1);
		expect(sql(`SELECT source FROM own_plays`)).toBe('rotor');
		expect(sqlNum(`SELECT count(*) FROM spotify_plays`)).toBe(spotifyBefore);
		const overviewAfter = await (await page.request.get('/api/stats/overview')).json();
		expect(overviewAfter.totals.plays).toBe(overviewBefore.totals.plays);
		await page.goto('/stats');
		await expect(page.getByTestId('own-stats')).toBeVisible();
		await expect(page.getByTestId('own-stats-plays')).toHaveText('1');
		await expect(page.getByTestId('own-stats')).toContainText('apart from Spotify');
	});

	test('V094-07 sets: paste-a-tracklist, confirm links, tap to seek (YouTube API and Rotor audio) @laptop', async ({ page }) => {
		const a = artist();
		const c = catalogTrack();
		const own = await createOwn(page, { title: 'Secret Weapon' });
		await page.goto('/sets/new');
		await page.getByTestId('st-title').fill('Live at the Warehouse');
		await pickArtist(page, 'djs', a.name);
		await page.getByTestId('st-duration').fill('1:30:00');
		await page.getByTestId('st-yt').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
		await page.getByTestId('st-paste').fill(`00:00 ${c.artist} - ${c.name}\n[03:45] ${a.name} - Secret Weapon\n07:10 ID - ID`);
		await page.getByTestId('st-parse').click();
		const rows = page.getByTestId('st-rows').locator('li');
		await expect(rows).toHaveCount(3);
		await expect(page.getByTestId('st-link')).toHaveCount(2); // catalog + own suggestions, not applied until confirmed
		await page.getByTestId('st-link').first().click();
		await page.getByTestId('st-link').first().click();
		await expect(rows.nth(2)).toHaveAttribute('data-kind', 'id');
		await page.getByTestId('st-save').click();
		await expect(page.getByTestId('set-detail')).toContainText('Live at the Warehouse');
		expect(sql(`SELECT string_agg(kind || ':' || coalesce(start_ms::text, '-'), ',' ORDER BY position) FROM dj_set_tracks`)).toBe('catalog:0,own:225000,id:430000');
		expect(sql(`SELECT own_track_id FROM dj_set_tracks WHERE kind = 'own'`)).toBe(own.id);
		await page.getByTestId('tl-seek').nth(1).click();
		await expect.poll(() => page.evaluate(() => (window as unknown as { __ytLog: string[] }).__ytLog ?? [])).toContain('seek:225');
		// An uploaded set plays in Rotor's player; a tap sets currentTime.
		const mediaId = await uploadViaApi(page, 'set.wav', wav(480_044), 'set'); // 60 s
		const r = await page.request.post('/api/sets', {
			headers: origin,
			data: { title: 'Upload Set', artists: [{ kind: 'spotify', id: a.id, name: a.name }], durationMs: 60_000, audioObjectId: mediaId, tracklist: [{ startMs: 0, kind: 'id', title: 'ID' }, { startMs: 30_000, kind: 'own', ownTrackId: own.id, title: 'Secret Weapon' }] }
		});
		expect(r.status()).toBe(201);
		await page.goto(`/sets/${(await r.json()).id}`);
		await page.getByTestId('tl-seek').nth(1).click();
		await expect(page.getByTestId('own-player')).toBeVisible();
		await expect.poll(() => page.evaluate(() => (document.querySelector('audio[data-testid="own-audio"]') as HTMLAudioElement).currentTime)).toBeGreaterThanOrEqual(29.5);
		await expect(page.getByTestId('tracklist').locator('li.now')).toContainText('Secret Weapon');
	});

	test('V094-08 delete is guarded and removes storage + database together; Data health warns at 80 % @laptop', async ({ page }) => {
		const mediaId = await uploadViaApi(page, 'only.wav', wav(80_044));
		const t = await createOwn(page, { title: 'Only Source', durationMs: 10_000, youtubeUrl: null, audioObjectId: mediaId });
		const key = sql(`SELECT object_key FROM media_objects WHERE id = '${mediaId}'`);
		const refused = await page.request.delete(`/api/media/${mediaId}`, { headers: origin });
		expect(refused.status()).toBe(409);
		expect((await refused.json()).message).toContain('only source');
		await page.goto(`/own/${t.id}`);
		await page.getByTestId('own-delete').click();
		await page.getByTestId('own-delete-confirm').click();
		await expect(page).toHaveURL(/\/library\?source=own/);
		expect(sqlNum(`SELECT count(*) FROM own_tracks`)).toBe(0);
		expect(sqlNum(`SELECT count(*) FROM media_objects`)).toBe(0);
		expect((await fake.state()).objects.some((o) => o.key === key)).toBe(false);
		// Usage: 900 MB of 1 GB → warning in Data health and Settings.
		sql(`INSERT INTO media_objects (object_key, purpose, content_type, size_bytes, status, completed_at) VALUES ('sets/00000000-0000-4000-8000-000000000001.wav', 'set', 'audio/wav', ${900 * MB}, 'ready', now())`);
		await page.goto('/settings/health');
		await expect(page.getByTestId('health-storage').getByTestId('storage-warn')).toBeVisible();
		await page.goto('/settings');
		await expect(page.getByTestId('storage-backend')).toContainText('supabase · 127.0.0.1:55436 · bucket rotor-media');
		await expect(page.getByTestId('settings-storage')).not.toContainText('fake-secret');
		// Over the quota: a new upload is refused before anything is signed.
		const full = await page.request.post('/api/media/uploads', { headers: origin, data: { purpose: 'track', name: 'x.mp3', size: 200 * MB, type: 'audio/mpeg' } });
		expect(full.status()).toBe(400); // over the 50 MB track limit first
		const quota = await page.request.post('/api/media/uploads', { headers: origin, data: { purpose: 'set', name: 'x.mp3', size: 200 * MB, type: 'audio/mpeg' } });
		expect(quota.status()).toBe(413);
		const ogg = await page.request.post('/api/media/uploads', { headers: origin, data: { purpose: 'track', name: 'x.ogg', size: 1000, type: 'audio/ogg' } });
		expect(ogg.status()).toBe(400);
	});

	test('V094-09 own tracks on artist pages, in Search, pinned in Library, in Rotor lists; never in a Spotify playlist @both', async ({ page }) => {
		await mock.resetCalls();
		const a = artist();
		const t = await createOwn(page, { title: 'Hidden Gem', status: 'id' });
		await page.goto(`/artist/${a.id}?stats=1`);
		await expect(page.getByTestId('own-results')).toContainText('Unreleased & IDs');
		await expect(page.getByTestId('own-results')).toContainText('Hidden Gem');
		await page.goto('/search?q=hidden%20gem');
		await expect(page.getByTestId('own-results')).toContainText('Hidden Gem');
		await page.goto('/library?source=own');
		const row = page.locator(`[data-testid=own-row][data-key="rotor:own:${t.id}"]`);
		await expect(row).toBeVisible();
		await row.getByRole('button', { name: 'Pin', exact: true }).click();
		await expect(page.getByTestId('own-pinned')).toContainText('Hidden Gem');
		expect(sqlNum(`SELECT count(*) FROM library_items WHERE item_key = 'rotor:own:${t.id}' AND pin_pos IS NOT NULL`)).toBe(1);
		const l = await (await page.request.post('/api/own/lists', { headers: origin, data: { name: 'Warm-up IDs' } })).json();
		expect((await page.request.patch(`/api/own/lists/${l.id}`, { headers: origin, data: { add: [t.id] } })).status()).toBe(200);
		const spotifyTrack = await page.request.patch(`/api/own/lists/${l.id}`, { headers: origin, data: { add: ['spotify:track:0TnOYISbd1XYRBk9myaseg'] } });
		expect(spotifyTrack.status()).toBe(400);
		expect(sqlNum(`SELECT count(*) FROM rotor_list_items WHERE list_id = '${l.id}'`)).toBe(1);
		expect(await mock.writes()).toEqual([]);
	});

	test('V094-10 prefill suggests from the embed title, MusicBrainz and the Spotify catalog; you confirm each field @laptop', async ({ page }) => {
		const a = artist();
		const st = await mock.state();
		await mock.set({
			youtube: { ...(st.youtube ?? {}), oembed: { dQw4w9WgXcQ: { title: `${a.name} - Morning Light (Extended Mix) [Official Video]`, author: 'Some Channel' } } },
			musicbrainz: { ...(st.musicbrainz ?? {}), recordings: [{ id: 'mb-rec-1', title: 'Morning Light', length: 381000, 'first-release-date': '2026-05-01', 'artist-credit': [{ name: a.name, artist: { name: a.name } }], releases: [{ 'label-info': [{ label: { name: 'Test Label' } }] }] }] }
		});
		await page.goto('/own/new');
		await page.locator('#ot-yt').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
		await page.getByTestId('prefill').click();
		const embed = page.getByTestId('suggestions').locator('[data-source=embed]');
		await expect(embed).toContainText('Morning Light');
		await expect(page.getByTestId('ot-title')).toHaveValue(''); // nothing applied before you confirm
		await embed.locator('li', { hasText: 'Title:' }).getByRole('button', { name: 'Use' }).click();
		await embed.locator('li', { hasText: 'Version:' }).getByRole('button', { name: 'Use' }).click();
		await embed.locator('li', { hasText: `Artist: ${a.name}` }).getByRole('button', { name: 'Use' }).click();
		const mb = page.getByTestId('suggestions').locator('[data-source=musicbrainz]');
		await mb.locator('li', { hasText: 'Duration:' }).getByRole('button', { name: 'Use' }).click();
		await mb.locator('li', { hasText: 'Label:' }).getByRole('button', { name: 'Use' }).click();
		await expect(page.getByTestId('ot-title')).toHaveValue('Morning Light');
		await expect(page.locator('#ot-version')).toHaveValue('Extended Mix');
		await expect(page.getByTestId('ot-duration')).toHaveValue('6:21');
		await expect(page.locator('#ot-label')).toHaveValue('Test Label');
		await expect(page.getByTestId('artists-primary').locator('.chip')).toContainText(a.name);
		const calls = await mock.calls();
		expect(calls.some((c) => c.host === 'musicbrainz.org' && c.path === '/ws/2/recording')).toBe(true);
		expect(calls.some((c) => c.host === 'www.youtube.com' && c.path === '/oembed')).toBe(true);
	});

	test('V094-11 storage migration: dry run copies nothing; execute copies and verifies checksums @laptop', async ({ page }) => {
		await uploadViaApi(page, 'm1.wav', wav(50_044));
		await uploadViaApi(page, 'm2.wav', wav(90_044), 'set');
		const env = {
			PATH: process.env.PATH ?? '',
			HOME: process.env.HOME ?? '',
			MEDIA_S3_ENDPOINT: `${S3}/storage/v1/s3`,
			MEDIA_S3_REGION: 'eu-central-1',
			MEDIA_S3_BUCKET: 'rotor-media',
			MEDIA_S3_ACCESS_KEY_ID: 'fake-access',
			MEDIA_S3_SECRET_ACCESS_KEY: 'fake-secret',
			DEST_MEDIA_S3_ENDPOINT: `${S3_DEST}/s3`,
			DEST_MEDIA_S3_REGION: 'eu-central-1',
			DEST_MEDIA_S3_BUCKET: 'rotor-media-new',
			DEST_MEDIA_S3_ACCESS_KEY_ID: 'dest-access',
			DEST_MEDIA_S3_SECRET_ACCESS_KEY: 'dest-secret'
		};
		const run = (args: string[]) => execFileSync('uv', ['run', '--no-sync', 'python', 'scripts/migrate_media_storage.py', '--no-dotenv', ...args], { cwd: process.env.E2E_REPO_ROOT, env, encoding: 'utf8' });
		const src = (await fake.state()).objects;
		const dry = run([]);
		expect(dry).toContain('DRY RUN');
		expect(dry).toContain(`To copy: ${src.length} object(s)`);
		expect((await fake.state(S3_DEST)).objects).toEqual([]);
		const out = run(['--execute']);
		expect(out).toContain('All objects verified');
		const dest = (await fake.state(S3_DEST)).objects;
		for (const o of src) expect(dest.find((d) => d.key === o.key)?.sha256).toBe(o.sha256);
	});
});
