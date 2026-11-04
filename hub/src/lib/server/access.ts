/** Paths reachable without a session. Everything else needs the owner's session. */
const PUBLIC_PATHS = [
	/^\/login\/?$/,
	/^\/auth\/(login|callback)\/?$/,
	/^\/offline\/?$/,
	/^\/service-worker\.js$/,
	/^\/manifest\.webmanifest$/,
	/^\/icons\/[\w.-]+$/,
	/^\/favicon\.(png|svg|ico)$/,
	/^\/robots\.txt$/
];

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.some((re) => re.test(pathname));
}

/** Methods that need the same-origin check. */
export function isMutating(method: string): boolean {
	return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** Same-origin check for mutating requests: the Origin header must equal our origin. */
export function originAllowed(method: string, origin: string | null, ownOrigin: string): boolean {
	return !isMutating(method) || origin === ownOrigin;
}
