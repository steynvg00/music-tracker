<script lang="ts">
	import type { TrackStats } from '$lib/shared/player-types';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	/** "Your history with this track": Rotor's signature element (03-ux-ia.md §2.1). */
	let { stats, surface = 'dark' }: { stats: TrackStats | null; surface?: 'dark' | 'panel' } = $props();
</script>

{#if stats}
	<div class="hist {surface}">
		<div class="over">Your history with this track</div>
		<div class="nums">
			<div><b class="tab-num">{fmtInt(stats.plays)}</b><span>plays</span></div>
			<div><b>{stats.firstPlayedAt ? fmtDate(stats.firstPlayedAt, { month: 'short', year: 'numeric' }) : 'New'}</b><span>first play</span></div>
			<div><b class="tab-num">{stats.badges}</b><span>badges</span></div>
		</div>
	</div>
{/if}

<style>
	.hist {
		margin-top: 22px;
		padding: 14px;
		border-radius: 12px;
		background: rgba(0, 0, 0, 0.28);
		text-align: left;
		width: 100%;
	}
	.hist.panel {
		background: var(--surface-2);
	}
	.nums {
		display: flex;
		gap: 20px;
		margin-top: 8px;
	}
	.nums b {
		display: block;
		font-size: 22px;
		line-height: 26px;
		font-weight: 800;
	}
	.nums span {
		font-size: 12px;
		color: var(--text-2);
	}
</style>
