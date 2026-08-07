import { getTodayFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ today: getTodayFixture() });
