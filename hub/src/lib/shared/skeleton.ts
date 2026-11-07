/** Which skeleton (R8) a client navigation shows while the target page's data loads. */
export type SkeletonKind = 'home' | 'stats' | 'library' | 'wrapped' | 'radar' | 'list';

const ROUTES: [RegExp, SkeletonKind][] = [
	[/^\/home\/?$/, 'home'],
	[/^\/stats(\/|$)/, 'stats'],
	[/^\/library\/?$/, 'library'],
	[/^\/wrapped\/\d{4}\/?$/, 'wrapped'],
	[/^\/radar\/?$/, 'radar'],
	[/^\/digest\/?$/, 'list'],
	[/^\/settings\/health(\/|$)/, 'list']
];

export function skeletonFor(pathname: string): SkeletonKind | null {
	for (const [re, kind] of ROUTES) if (re.test(pathname)) return kind;
	return null;
}

/** Only after this long: a fast navigation never flashes a skeleton. */
export const SKELETON_DELAY_MS = 120;
