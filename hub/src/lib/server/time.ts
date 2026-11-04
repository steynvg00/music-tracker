export const TZ = 'Europe/Amsterdam';

/** YYYY-MM-DD of `d` in Europe/Amsterdam (the daily pick's calendar day). */
export function localDate(d: Date = new Date()): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function isIsoDate(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
