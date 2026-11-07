<script lang="ts">
	import { page } from '$app/state';
	import PillBar, { type PillMenu } from '../PillBar.svelte';
	import OptionSheet from '../OptionSheet.svelte';
	import type { IconName } from '../Icon.svelte';
	import type { PillGroup } from '$lib/shared/pills';
	import { STATS_SECTIONS } from '$lib/shared/stats';

	/**
	 * Stats' one filter bar (v0.91): the section (a ▾ pill opening a sheet), then this page's filters as
	 * pills, then its metric as the small icon button at the end. The same PillBar as the Library.
	 * Everything comes from the URL, so it renders server-side in its final shape (no layout shift).
	 */
	let {
		groups = [],
		menus = [],
		onpick,
		onclear,
		action
	}: {
		groups?: PillGroup[];
		menus?: PillMenu[];
		onpick?: (group: string, value: string | null) => void;
		onclear?: () => void;
		action?: { label: string; icon: IconName; onclick: () => void; active?: boolean };
	} = $props();
	const current = $derived(page.url.pathname.replace(/\/$/, '') || '/stats');
	const section = $derived(STATS_SECTIONS.find((s) => s.href === current) ?? STATS_SECTIONS[0]);
	let open = $state(false);
</script>

<PillBar label="Stats filters" {groups} {onpick} {onclear} {action} menus={[{ key: 'section', label: section.label, onclick: () => (open = true) }, ...menus]} testid="stats-pills" />

<OptionSheet
	{open}
	onclose={() => (open = false)}
	title="Stats"
	sections={[{ key: 'section', title: 'Stats', options: STATS_SECTIONS.map((s) => ({ value: s.href, label: s.label, href: s.href })), value: section.href, onselect: () => undefined }]}
/>
