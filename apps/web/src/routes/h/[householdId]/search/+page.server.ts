import { getSearchFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({
  search: getSearchFixture(url.searchParams.get('q') ?? '')
});
