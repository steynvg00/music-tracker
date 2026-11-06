import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRow } from '$lib/shared/jobs';

vi.mock('$app/environment', () => ({ browser: true }));
const apiGet = vi.fn();
vi.mock('$lib/player/api-client', () => ({ apiGet: (...a: unknown[]) => apiGet(...a), apiPost: vi.fn(), describeFailure: String }));
vi.mock('./toasts.svelte', () => ({ toasts: { show: vi.fn(), error: vi.fn() } }));

const job = (status: JobRow['status']): JobRow => ({
	id: '00000000-0000-4000-8000-000000000001',
	kind: 'refresh_managed',
	payload: {},
	status,
	attempts: 1,
	requestedAt: new Date().toISOString(),
	startedAt: null,
	finishedAt: null,
	result: null,
	error: null,
	runUrl: null
});

class FakeDocument extends EventTarget {
	visibilityState: 'visible' | 'hidden' = 'hidden';
}

describe('JobTracker while the tab is hidden', () => {
	let doc: FakeDocument;
	beforeEach(() => {
		vi.useFakeTimers();
		doc = new FakeDocument();
		vi.stubGlobal('document', doc);
		apiGet.mockReset().mockResolvedValue(job('running'));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('makes no request while hidden and resumes once when shown', async () => {
		const { JobTracker } = await import('./jobs.svelte');
		const t = new JobTracker();
		t.track(job('queued'));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(apiGet).not.toHaveBeenCalled();
		doc.visibilityState = 'visible';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(apiGet).toHaveBeenCalledTimes(1);
		t.stop();
	});

	it('a stopped tracker stays stopped when the tab becomes visible again', async () => {
		const { JobTracker } = await import('./jobs.svelte');
		const t = new JobTracker();
		t.track(job('queued'));
		await vi.advanceTimersByTimeAsync(3_500); // first poll finds the tab hidden → waits for visibility
		t.stop(); // e.g. leaving the playlist page
		doc.visibilityState = 'visible';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(apiGet).not.toHaveBeenCalled();
	});
});
