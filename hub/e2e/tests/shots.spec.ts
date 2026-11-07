/**
 * v0.91: screenshots of Library and Stats (mobile + laptop) for the PR's before/after. Saved to
 * e2e/.out/shots/<E2E_SHOT_LABEL>-<page>-<project>.png. Runs on any release (no new test ids), so the
 * same file on main gives the "before" set. Asserts only that the page rendered.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';

const OUT = join(process.env.E2E_OUT ?? 'e2e/.out', 'shots');
const LABEL = process.env.E2E_SHOT_LABEL ?? 'after';

test.describe('SHOT screenshots', () => {
	test('SHOT Library and Stats › Top @both', async ({ page }, info) => {
		mkdirSync(OUT, { recursive: true });
		await page.goto('/library');
		await expect(page.locator('.list a, .list button, [data-testid=entry]').first()).toBeVisible();
		await page.waitForLoadState('networkidle');
		await page.screenshot({ path: join(OUT, `${LABEL}-library-${info.project.name}.png`) });
		await page.goto('/stats/top');
		await expect(page.getByRole('heading', { name: /Top 50 tracks/ })).toBeVisible();
		await page.waitForLoadState('networkidle');
		await page.screenshot({ path: join(OUT, `${LABEL}-stats-${info.project.name}.png`) });
	});
});
