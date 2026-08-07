import { getSettingsFixture } from '$lib/server/fixtures.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ settings: getSettingsFixture() });
