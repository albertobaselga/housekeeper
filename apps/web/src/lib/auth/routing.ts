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
  'account',
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
  // Tu propia contraseña es tuya sea cual sea tu papel en la casa: la puerta de
  // «Tu acceso» pide la misma capacidad mínima que Hoy, no `access.manage`.
  // Ajustes sigue siendo de la familia; ahí se reponen las contraseñas ajenas.
  account: 'emergency.read',
  settings: 'access.manage'
};

/**
 * Rutas hijas con su propia regla de autorización, declaradas aquí junto a la
 * ruta que las estrena. Sin esta tabla `guardForPath` falla cerrado para
 * cualquier ruta anidada, que es el comportamiento correcto: una ruta nueva no
 * hereda el permiso de su padre por el hecho de colgar de él.
 *
 * · `employment/acuerdo` — pactar condiciones es escribir el contrato, y eso es
 *   solo de quien administra (`agreement.write`). El segmento de la ruta sigue
 *   llamándose `acuerdo`: el renombrado es de cara a la persona, no de
 *   arquitectura, y cambiar la URL rompería los enlaces ya repartidos.
 * · `employment/condiciones` — leer lo pactado. `agreement.read` lo tienen
 *   también la familia no administradora; para ella la RLS no devuelve ninguna
 *   versión y la página enseña su estado vacío, que es la verdad.
 */
export const NESTED_ROUTE_CAPABILITY: Readonly<Record<string, Capability>> = {
  'employment/acuerdo': 'agreement.write',
  'employment/condiciones': 'agreement.read'
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

  // Wiki owns una jerarquía abierta (una nota por slug). El resto de rutas
  // hijas se declaran una a una en NESTED_ROUTE_CAPABILITY, junto con su regla:
  // lo que no está declarado falla cerrado.
  if (parts.length > 3 && moduleName !== 'wiki') {
    const nested = parts.length === 4 ? NESTED_ROUTE_CAPABILITY[`${moduleName}/${parts[3]}`] : undefined;
    if (!nested) {
      return { householdId, module: moduleName, capability: null, known: false };
    }
    return { householdId, module: moduleName, capability: nested, known: true };
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
