import { redirect } from '@sveltejs/kit';
import { safeReturnTo } from '$lib/server/spotify/oauth';
import type { PageServerLoad } from './$types';

const MESSAGES: Record<string, string> = {
	not_owner: "That Spotify account isn't this Rotor's owner. Rotor only lets its owner in.",
	state: 'The sign-in expired or was tampered with. Try again.',
	denied: 'You cancelled the Spotify dialog.',
	exchange: "Spotify didn't accept the sign-in. Try again.",
	session: 'Sign in first.',
	spotify: 'Spotify returned an error. Try again.'
};

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeReturnTo(url.searchParams.get('next'));
	if (locals.session) redirect(303, next);
	const error = url.searchParams.get('error');
	return {
		next,
		message: error ? (MESSAGES[error] ?? 'Sign-in failed.') : url.searchParams.has('signed_out') ? 'Signed out.' : null,
		isError: !!error
	};
};
