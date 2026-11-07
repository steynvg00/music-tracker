/**
 * Cron health from the GitHub REST API (R8, Settings › Data health). Read-only GETs with the
 * existing GITHUB_DISPATCH_TOKEN; without it (or on any API error) everything is "unknown".
 *
 *   GET /repos/{repo}                                   pushed_at, private
 *   GET /repos/{repo}/actions/workflows                 state per workflow file
 *   GET /repos/{repo}/actions/workflows/{file}/runs     latest runs (keepalive: latest success)
 *
 * Successful reads are cached in memory for 5 minutes per server instance ("Check again" skips
 * the cache), so opening Data health repeatedly costs six API calls per 5 minutes at most
 * (GitHub allows 5,000/h for a token). Failures aren't cached.
 */
import type { HubConfig } from './env';
import { autoDisableAt, daysUntil, SCHEDULED_WORKFLOWS, workflowTone, type CronHealth, type CronWorkflow } from '$lib/shared/health';

const TTL_MS = 5 * 60_000;
let cache: { key: string; at: number; value: CronHealth } | null = null;

export function clearCronCache(): void {
	cache = null;
}

interface Run {
	created_at: string;
	updated_at?: string;
	conclusion: string | null;
	status: string;
	event: string;
	html_url: string;
}

function unknown(reason: string, now: Date): CronHealth {
	return {
		known: false,
		reason,
		repoPrivate: null,
		lastPushAt: null,
		lastKeepaliveAt: null,
		autoDisableAt: null,
		daysLeft: null,
		workflows: SCHEDULED_WORKFLOWS.map((w) => ({ ...w, state: null, lastRunAt: null, lastConclusion: null, lastEvent: null, lastRunUrl: null, autoDisableAt: null, tone: 'info' })),
		checkedAt: now.toISOString()
	};
}

class GitHubError extends Error {
	constructor(readonly status: number) {
		super(`GitHub API ${status}`);
	}
}

export async function cronHealth(
	cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>,
	f: typeof fetch = fetch,
	now: Date = new Date(),
	opts: { fresh?: boolean } = {}
): Promise<CronHealth> {
	if (!cfg.githubDispatchToken) return unknown('No GitHub token in the hub env (GITHUB_DISPATCH_TOKEN), so Rotor can’t read the workflows.', now);
	const key = `${cfg.githubRepository}`;
	if (!opts.fresh && cache && cache.key === key && now.getTime() - cache.at < TTL_MS) return cache.value;

	const get = async <T>(path: string): Promise<T> => {
		const res = await f(`https://api.github.com/repos/${cfg.githubRepository}${path}`, {
			headers: {
				Authorization: `Bearer ${cfg.githubDispatchToken}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'rotor-hub'
			},
			signal: AbortSignal.timeout(6000)
		});
		if (!res.ok) throw new GitHubError(res.status);
		return (await res.json()) as T;
	};

	try {
		const [repo, wfs, ...runs] = await Promise.all([
			get<{ pushed_at: string | null; private: boolean }>(''),
			get<{ workflows: { path: string; state: string }[] }>('/actions/workflows?per_page=100'),
			...SCHEDULED_WORKFLOWS.map((w) => get<{ workflow_runs: Run[] }>(`/actions/workflows/${w.file}/runs?per_page=10&exclude_pull_requests=true`))
		]);
		const keepIdx = SCHEDULED_WORKFLOWS.findIndex((w) => w.file === 'keepalive.yml');
		const keepOk = (runs[keepIdx]?.workflow_runs ?? []).find((r) => r.conclusion === 'success');
		const lastKeepaliveAt = keepOk ? (keepOk.updated_at ?? keepOk.created_at) : null;
		const lastPushAt = repo.pushed_at;
		const disableAt = repo.private ? null : autoDisableAt(lastPushAt, lastKeepaliveAt);
		const daysLeft = daysUntil(disableAt, now);
		const state = new Map(wfs.workflows.map((w) => [w.path.replace(/^\.github\/workflows\//, ''), w.state]));
		const workflows: CronWorkflow[] = SCHEDULED_WORKFLOWS.map((w, i) => {
			const last = runs[i]?.workflow_runs?.[0] ?? null;
			const st = state.get(w.file) ?? null;
			return {
				...w,
				state: st,
				lastRunAt: last?.created_at ?? null,
				lastConclusion: last ? (last.conclusion ?? last.status) : null,
				lastEvent: last?.event ?? null,
				lastRunUrl: last?.html_url ?? null,
				autoDisableAt: st === 'active' ? disableAt : null,
				tone: workflowTone(st, last?.conclusion ?? null, st === 'active' ? daysLeft : null)
			};
		});
		const value: CronHealth = {
			known: true,
			reason: repo.private ? 'Private repository: GitHub’s 60-day auto-disable applies to public repositories only.' : null,
			repoPrivate: repo.private,
			lastPushAt,
			lastKeepaliveAt,
			autoDisableAt: disableAt,
			daysLeft,
			workflows,
			checkedAt: now.toISOString()
		};
		cache = { key, at: now.getTime(), value };
		return value;
	} catch (e) {
		const why =
			e instanceof GitHubError
				? e.status === 401 || e.status === 403
					? `GitHub refused the token (${e.status}): it needs read access to Actions for ${cfg.githubRepository}.`
					: `GitHub API answered ${e.status}.`
				: 'GitHub API unreachable.';
		return unknown(why, now);
	}
}
