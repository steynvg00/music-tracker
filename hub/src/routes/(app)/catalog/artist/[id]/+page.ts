import type { PageLoad } from './$types';

/** The page fetches its own data (with skeletons): a big uncached artist can take a few seconds. */
export const load: PageLoad = ({ params }) => ({ id: params.id });
