/** R9: every former mail is a Web Push — per-type switches, "Send test", device health, no mail anywhere. */
import { execFileSync } from 'node:child_process';
import { test, expect, mock, sql, sqlNum, waitForJob } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const KINDS = 14;

function runDigest(): void {
	execFileSync('uv', ['run', '--no-sync', 'python', 'hub/e2e/digest_fixture.py'], { cwd: REPO, encoding: 'utf8', env: { ...process.env } });
}

test.describe('R9 Notifications', () => {
	test.afterEach(() => {
		sql(`DELETE FROM notification_prefs`);
	});

	test('R9-1 Settings lists every type with a switch and a Send test; a switch persists @laptop', async ({ page }) => {
		await page.goto('/settings');
		const types = page.getByTestId('notification-types');
		await expect(types.locator('li')).toHaveCount(KINDS);
		await expect(types.locator('li[data-kind="weekly_digest"]')).toContainText('was a mail');
		await expect(types.locator('li[data-kind="daily_pick"]')).not.toContainText('was a mail');
		await expect(page.getByText('There is no e-mail any more')).toBeVisible();
		const sw = types.locator('li[data-kind="milestone"] input[role=switch]');
		await expect(sw).toBeChecked();
		await sw.click();
		await expect(sw).not.toBeChecked();
		await expect.poll(() => sql(`SELECT enabled::text FROM notification_prefs WHERE kind = 'milestone'`)).toBe('false');
		await page.reload();
		await expect(page.getByTestId('notification-types').locator('li[data-kind="milestone"] input[role=switch]')).not.toBeChecked();
	});

	test('R9-2 Send test runs a job that pushes that type’s sample, even when the type is off @laptop', async ({ page }) => {
		sql(`INSERT INTO notification_prefs (kind, enabled) VALUES ('ingest_alert', false)`);
		const before = (await mock.pushes()).length;
		await page.goto('/settings');
		await page.getByRole('button', { name: 'Send a test: Ingest freshness alert' }).click();
		expect(await waitForJob(`kind = 'push_test' AND payload->>'kind' = 'ingest_alert'`)).toBe('done');
		const pushes = (await mock.pushes()).slice(before);
		expect(pushes.length).toBeGreaterThan(0);
		expect(pushes.every((p) => p.data.kind === 'ingest_alert' && p.data.title === "Test · Rotor's play history is behind")).toBe(true);
		expect(pushes[0]!.data.url).toBe('/settings/health');
		await expect(page.getByText(/Sent to \d+ device/)).toBeVisible();
	});

	test('R9-3 the weekly digest is a push (to /digest); switched off it is stored but not pushed @laptop', async () => {
		let before = (await mock.pushes()).length;
		runDigest();
		let pushes = (await mock.pushes()).slice(before);
		expect(pushes.map((p) => p.data.kind)).toEqual(expect.arrayContaining(['weekly_digest']));
		const d = pushes.find((p) => p.data.kind === 'weekly_digest')!;
		expect(d.data).toMatchObject({ title: 'Weekly refresh', body: '1 playlist created, 2 updated.', url: '/digest' });
		expect(sql(`SELECT delivery_status FROM digest_runs ORDER BY id DESC LIMIT 1`)).toBe('push_sent');

		sql(`INSERT INTO notification_prefs (kind, enabled) VALUES ('weekly_digest', false)`);
		before = (await mock.pushes()).length;
		runDigest();
		pushes = (await mock.pushes()).slice(before);
		expect(pushes.filter((p) => p.data.kind === 'weekly_digest')).toEqual([]);
		expect(sql(`SELECT delivery_status FROM digest_runs ORDER BY id DESC LIMIT 1`)).toBe('push_off');
		expect(sqlNum(`SELECT count(*) FROM digest_runs`)).toBe(1); // the fixture keeps one run
	});

	test('R9-4 Data health shows each device’s last push and warns about failing or silent ones @laptop', async ({ page }) => {
		const saved = sql(`SELECT json_agg(s) FROM push_subscriptions s`);
		try {
			const ep = sql(`SELECT endpoint FROM push_subscriptions ORDER BY created_at LIMIT 1`);
			sql(`UPDATE push_subscriptions SET last_success_at = now() - interval '2 hours', failures = 0, device_label = 'Phone'`);
			await page.goto('/settings/health');
			const dev = page.getByTestId('health-push').locator('li').first();
			await expect(dev).toContainText('Phone');
			await expect(dev).toContainText('last push 2 h ago');
			await expect(dev).toHaveAttribute('data-tone', 'ok');

			sql(`UPDATE push_subscriptions SET last_success_at = now() - interval '9 days' WHERE endpoint = '${ep}'`);
			await page.reload();
			await expect(page.locator('[data-testid=health-push] li[data-warning=silent]')).toContainText('Nothing received in 7 days');

			sql(`UPDATE push_subscriptions SET failures = 3 WHERE endpoint = '${ep}'`);
			await page.reload();
			await expect(page.locator('[data-testid=health-push] li[data-warning=failing]')).toContainText('Last 3 deliveries failed');

			sql(`DELETE FROM push_subscriptions`);
			await page.reload();
			await expect(page.getByTestId('health-push-none')).toBeVisible();
		} finally {
			sql(`DELETE FROM push_subscriptions`);
			sql(`INSERT INTO push_subscriptions SELECT * FROM json_populate_recordset(NULL::push_subscriptions, '${saved.replace(/'/g, "''")}'::json)`);
		}
	});

	test('R9-5 the per-type API refuses unknown types and needs a same-origin request @laptop', async ({ request, baseURL }) => {
		const h = { Origin: baseURL ?? 'http://localhost:47173', 'Content-Type': 'application/json' };
		expect((await request.put('/api/notifications', { headers: h, data: { kind: 'smtp', enabled: false } })).status()).toBe(400);
		expect((await request.post('/api/notifications/test', { headers: h, data: { kind: 'mail' } })).status()).toBe(400);
		expect((await request.put('/api/notifications', { headers: { 'Content-Type': 'application/json' }, data: { kind: 'milestone', enabled: false } })).status()).toBe(403);
		const r = await request.get('/api/notifications');
		expect((await r.json()).prefs).toHaveLength(KINDS);
	});
});
