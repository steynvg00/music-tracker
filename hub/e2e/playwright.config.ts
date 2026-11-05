import { defineConfig, devices } from '@playwright/test';

/**
 * Rotor E2E (run through `npm run e2e`, which starts the throwaway DB + mocked hub first).
 * Tests are tagged @mobile / @laptop / @both; one shared DB and mock, so everything is serial.
 */
const OUT = process.env.E2E_OUT ?? 'e2e/.out';
const AUTH = `${OUT}/auth.json`;

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [['list'], ['json', { outputFile: `${OUT}/results.json` }]],
	use: {
		// Hard network wall: every host except localhost resolves to NOTFOUND inside the browser, so no
		// page, redirect or sub-resource can reach the internet (Playwright routes don't see redirects).
		launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] },
		baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:47173',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	outputDir: `${OUT}/artifacts`,
	projects: [
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		{
			name: 'mobile',
			grep: /@mobile|@both/,
			dependencies: ['setup'],
			use: { ...devices['iPhone 14'], browserName: 'chromium', storageState: AUTH }
		},
		{
			name: 'laptop',
			grep: /@laptop|@both/,
			dependencies: ['setup'],
			use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, storageState: AUTH }
		}
	]
});
