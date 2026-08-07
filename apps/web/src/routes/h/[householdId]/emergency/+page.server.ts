import { getEmergencyFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ emergency: getEmergencyFixture() });
