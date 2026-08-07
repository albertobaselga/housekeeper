import { getMenuFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ menu: getMenuFixture() });
