import { error } from '@sveltejs/kit';
import type { DailyDeck } from '$lib/shared/daily-types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const date = params.date;
	if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) error(404, 'Not found');
	const res = await fetch(date ? `/api/daily?date=${date}` : '/api/daily');
	if (!res.ok) error(res.status, 'Could not load the daily pick');
	return { deck: (await res.json()) as DailyDeck };
};
