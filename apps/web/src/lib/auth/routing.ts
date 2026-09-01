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
  'personal',
  'finanzas',
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
  // Personal es el expediente de quien trabaja y trabajó en la casa, con
  // nombres, fechas y sueldos: la misma llave que Ajustes, que solo tiene la
  // familia administradora.
  personal: 'access.manage',
  // Finanzas es de la administración Y de cuenta activada: la capacidad la
  // tiene el rol, pero el layout la retira sin concesión viva (spec §4). La
  // segunda llave nunca vive aquí: este mapa no consulta la base.
  finanzas: 'finance.access',
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
 * · `employment/vacaciones` — el historial de días disfrutados. Misma llave que
 *   `condiciones` y por el mismo motivo: `agreement.read` la tienen quien
 *   administra, la familia y la propia empleada, que son exactamente los tres
 *   que la política `vacation_periods_read` deja leer. Al apoyo y al visor no
 *   les llega ni la ruta ni una fila. A la familia no administradora le llegan
 *   los periodos pero no los términos, y la pantalla lo dice en vez de fingir
 *   un derecho de cero días.
 */
export const NESTED_ROUTE_CAPABILITY: Readonly<Record<string, Capability>> = {
  'employment/acuerdo': 'agreement.write',
  'employment/condiciones': 'agreement.read',
  'employment/vacaciones': 'agreement.read',
  // Finanzas: cada hija declarada una a una (fail-closed), todas con la misma
  // llave del módulo — el doble cerrojo real lo aplican layout y RLS.
  'finanzas/analitica': 'finance.access',
  'finanzas/movimientos': 'finance.access',
  'finanzas/revision': 'finance.access',
  'finanzas/eventos': 'finance.access',
  'finanzas/importar': 'finance.access',
  'finanzas/ajustes': 'finance.access'
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

/**
 * El hogar que se está mirando es SIEMPRE el de la URL, nunca el primero de la
 * persona. Quien pertenece a dos casas cambia de casa cambiando de dirección, y
 * el nombre que anuncian la cabecera y la pestaña tiene que seguirla.
 */
export function pickHousehold<Household extends { id: string }>(
  households: readonly Household[] | undefined,
  householdId: string
): Household | null {
  return households?.find((candidate) => candidate.id === householdId) ?? null;
}
