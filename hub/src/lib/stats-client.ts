/** Page loaders for Stats, detail pages and Search (R3): one API call, status kept for error states. */
export interface Loaded<T> {
	data: T | null;
	status: number;
	message: string | null;
}

export async function loadApi<T>(f: typeof fetch, path: string): Promise<Loaded<T>> {
	try {
		const res = await f(path, { headers: { Accept: 'application/json' } });
		if (res.ok) return { data: (await res.json()) as T, status: res.status, message: null };
		const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
		return { data: null, status: res.status, message: body.message ?? body.error ?? `HTTP ${res.status}` };
	} catch {
		return { data: null, status: 0, message: 'Rotor is offline' };
	}
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2024-03' → 'Mar 24'; '2024-03-05' → '5 Mar'. */
export function shortPeriod(x: string): string {
	const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(x);
	if (!m) return x;
	const mon = MONTHS[Number(m[2]) - 1] ?? m[2];
	return m[3] ? `${Number(m[3])} ${mon}` : `${mon} ${m[1]!.slice(2)}`;
}
