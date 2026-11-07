/**
 * R9 notifications: the hub's type list matches lib/notify.KINDS, device warnings, switch
 * validation, and the bypass scan over every new R9 module.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeSql } from './test-helpers';
import { notificationPrefs, pushDevices, setNotificationPref } from './notifications';
import { deviceWarning, isNotificationKind, NOTIFICATION_KINDS } from '$lib/shared/notifications';
import { BadInput } from '$lib/shared/custom';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const NOW = new Date('2026-11-07T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('notification types', () => {
	it('are exactly lib/notify.KINDS, in the same order, with the same labels', () => {
		const py = readFileSync(join(REPO_ROOT, 'lib/notify.py'), 'utf8');
		const block = py.slice(py.indexOf('KINDS: dict'), py.indexOf('\n}\n', py.indexOf('KINDS: dict')));
		const kinds = [...block.matchAll(/^\s+"(\w+)": \("([^"]+)"/gm)].map((m) => [m[1], m[2]]);
		expect(kinds).toEqual(NOTIFICATION_KINDS.map((k) => [k.kind, k.label]));
	});
	it('every former mail type is marked, and nothing else is a mail', () => {
		expect(NOTIFICATION_KINDS.filter((k) => k.was === 'mail').map((k) => k.kind)).toEqual([
			'weekly_digest', 'monthly_digest', 'custom_sweep', 'snapshot', 'milestone', 'special_badge', 'badge_digest', 'artist_badge', 'ingest_alert'
		]);
		expect(isNotificationKind('weekly_digest')).toBe(true);
		expect(isNotificationKind('smtp')).toBe(false);
	});
});

describe('device warnings', () => {
	it('failing beats silent; silent = nothing received in 7 days (or never, 7 days after subscribing)', () => {
		expect(deviceWarning({ createdAt: daysAgo(30), lastSuccessAt: daysAgo(1), failures: 2 }, NOW)).toBe('failing');
		expect(deviceWarning({ createdAt: daysAgo(30), lastSuccessAt: daysAgo(8), failures: 0 }, NOW)).toBe('silent');
		expect(deviceWarning({ createdAt: daysAgo(30), lastSuccessAt: daysAgo(6), failures: 0 }, NOW)).toBeNull();
		expect(deviceWarning({ createdAt: daysAgo(3), lastSuccessAt: null, failures: 0 }, NOW)).toBeNull();
		expect(deviceWarning({ createdAt: daysAgo(9), lastSuccessAt: null, failures: 0 }, NOW)).toBe('silent');
	});
	it('labels unnamed devices', async () => {
		const { sql } = fakeSql(() => [{ device_label: null, created_at: new Date(daysAgo(1)), last_success_at: null, failures: 0 }]);
		expect((await pushDevices(sql, NOW))[0]).toMatchObject({ label: 'Device 1', warning: null });
	});
});

describe('switches', () => {
	it('no row = on; without 0030 every type reads as on', async () => {
		const a = fakeSql(() => [{ kind: 'milestone', enabled: false }]);
		const r = await notificationPrefs(a.sql);
		expect(r.stored).toBe(true);
		expect(r.prefs.find((p) => p.kind === 'milestone')!.enabled).toBe(false);
		expect(r.prefs.filter((p) => p.enabled)).toHaveLength(NOTIFICATION_KINDS.length - 1);
		const b = fakeSql(() => {
			throw Object.assign(new Error('relation "notification_prefs" does not exist'), { code: '42P01' });
		});
		const r2 = await notificationPrefs(b.sql);
		expect(r2.stored).toBe(false);
		expect(r2.prefs.every((p) => p.enabled)).toBe(true);
	});
	it('only known types and booleans are stored', async () => {
		const { sql, queries } = fakeSql(() => []);
		await expect(setNotificationPref(sql, 'smtp', false)).rejects.toBeInstanceOf(BadInput);
		await expect(setNotificationPref(sql, 'milestone', 'no')).rejects.toBeInstanceOf(BadInput);
		await setNotificationPref(sql, 'milestone', false);
		expect(queries).toHaveLength(1);
		expect(queries[0]!.values).toEqual(['milestone', false]);
	});
});

describe('bypass scan covers R9 modules', () => {
	it('no R9 module touches Spotify or a write path, and nothing mentions SMTP/Gmail', () => {
		const scanned: string[] = [];
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
					const rel = relative(SRC, p).replaceAll('\\', '/');
					scanned.push(rel);
					const text = readFileSync(p, 'utf8');
					if (rel !== 'lib/server/spotify/write-guard.ts' && rel !== 'lib/server/spotify/api.ts' && text.includes('_sendPlaylistWrite')) offenders.push(rel);
					if (!['lib/server/spotify/api.ts', 'lib/server/spotify/oauth.ts'].includes(rel) && /api\.spotify\.com/.test(text)) offenders.push(rel);
					if (/smtp|GMAIL_|EMAIL_RECIPIENT/i.test(text)) offenders.push(`${rel} (mail)`);
				}
			}
		};
		walk(SRC);
		for (const f of [
			'lib/shared/notifications.ts',
			'lib/server/notifications.ts',
			'lib/components/settings/NotificationTypes.svelte',
			'routes/api/notifications/+server.ts',
			'routes/api/notifications/test/+server.ts'
		]) {
			expect(scanned).toContain(f);
		}
		expect(offenders).toEqual([]);
	});
});
