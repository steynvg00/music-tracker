/**
 * One filter bar (v0.91), shared by Library and Stats: Spotify-style pills in one horizontally
 * scrollable row. Pure rules, used by lib/components/PillBar.svelte and the tests.
 *
 *   - A group is single-select. Picking a pill selects it; picking it again clears that group.
 *   - A "collapse" group hides its other options while one is selected (Library kinds, sources),
 *     like Spotify's library: [×] [Managed 🔄] … and the × clears every group at once.
 *   - Selected pills come first, then the options of groups that still offer a choice.
 *   - "Menu" pills (▾) open a sheet: for choices with many options (Stats section, year, metric).
 */
export interface PillOption {
	value: string;
	label: string;
}
export interface PillGroup {
	key: string;
	/** For screen readers: "Kind", "Period", … */
	label: string;
	options: PillOption[];
	/** null = nothing selected (the default view). */
	value: string | null;
	collapse?: boolean;
	/** Hidden entirely (e.g. Library kinds while YouTube is the source). */
	hidden?: boolean;
	/** Stats-style: always one selected, never cleared by × or by picking it again. */
	required?: boolean;
}
export interface PillView {
	group: string;
	value: string;
	label: string;
	active: boolean;
}

export function activeGroups(groups: PillGroup[]): PillGroup[] {
	return groups.filter((g) => !g.hidden && g.value !== null && !g.required);
}

/** × shows when any clearable group has a selection. */
export function hasClearable(groups: PillGroup[]): boolean {
	return activeGroups(groups).length > 0;
}

export function visiblePills(groups: PillGroup[]): PillView[] {
	const shown = groups.filter((g) => !g.hidden);
	const active: PillView[] = [];
	const rest: PillView[] = [];
	for (const g of shown) {
		for (const o of g.options) {
			const on = g.value === o.value;
			if (on && !g.required) active.push({ group: g.key, value: o.value, label: o.label, active: true });
			else if (on) rest.push({ group: g.key, value: o.value, label: o.label, active: true });
			else if (!(g.collapse && g.value !== null)) rest.push({ group: g.key, value: o.value, label: o.label, active: false });
		}
	}
	return [...active, ...rest];
}

/** What picking a pill does to its group's value. */
export function pick(group: PillGroup, value: string): string | null {
	if (group.required) return value;
	return group.value === value ? null : value;
}
