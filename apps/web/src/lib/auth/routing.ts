import type { Capability } from './capabilities';

export const HOUSEHOLD_MODULES = [
  'today',
  'employment',
  'menu',
  'recipes',
  'wiki',
  'search',
  'routines',
  'calendar',
  'contacts',
  'emergency',
  'settings'
] as const;

export type HouseholdModule = (typeof HOUSEHOLD_MODULES)[number];

export const MODULE_CAPABILITY: Readonly<Record<HouseholdModule, Capability>> = {
  // All five roles have emergency.read. It is the minimum household bootstrap
  // capability and therefore also gates the lightweight Today route.
  today: 'emergency.read',
  employment: 'settlement.read',
  menu: 'menu.read',
  recipes: 'content.read',
  wiki: 'content.read',
  search: 'search.use',
  routines: 'routine.read',
  calendar: 'calendar.read',
  contacts: 'contact.read',
  emergency: 'emergency.read',
  settings: 'access.manage'
};

export interface HouseholdRouteGuard {
  householdId: string;
  module: HouseholdModule | null;
  capability: Capability | null;
  known: boolean;
}

export function isHouseholdModule(value: string): value is HouseholdModule {
  return (HOUSEHOLD_MODULES as readonly string[]).includes(value);
}

/**
 * Resolves authorization from the URL. Unknown child routes deliberately
 * return `known: false`, so callers fail closed rather than inheriting access.
 */
export function guardForPath(pathname: string): HouseholdRouteGuard | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'h' || !parts[1]) return null;

  let householdId: string;
  try {
    householdId = decodeURIComponent(parts[1]);
  } catch {
    return { householdId: '', module: null, capability: null, known: false };
  }

  if (parts.length === 2) {
    return { householdId, module: null, capability: null, known: true };
  }

  const moduleName = parts[2];
  if (!isHouseholdModule(moduleName)) {
    return { householdId, module: null, capability: null, known: false };
  }

  // Only wiki owns nested routes in the current contract. Everything else is
  // exact until a route and its authorization rule are added together.
  const supportsNestedPath = moduleName === 'wiki';
  if (parts.length > 3 && !supportsNestedPath) {
    return { householdId, module: moduleName, capability: null, known: false };
  }

  return {
    householdId,
    module: moduleName,
    capability: MODULE_CAPABILITY[moduleName],
    known: true
  };
}

export function householdPath(householdId: string, moduleName: HouseholdModule): string {
  return `/h/${encodeURIComponent(householdId)}/${moduleName}`;
}
