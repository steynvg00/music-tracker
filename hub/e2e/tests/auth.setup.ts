/** Signs the owner in once through the real OAuth routes (Spotify's authorize page is intercepted). */
import { test as setup, expect } from '@playwright/test';
import { guardExternal, signIn } from './fixtures';

setup('owner signs in', async ({ page }) => {
	await guardExternal(page, []);
	await signIn(page);
	await expect(page).toHaveURL(/\/home/);
	await page.context().storageState({ path: `${process.env.E2E_OUT ?? 'e2e/.out'}/auth.json` });
});
