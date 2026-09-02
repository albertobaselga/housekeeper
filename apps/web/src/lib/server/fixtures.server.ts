import type { FinanceTxDto } from '@housekeeper/server';

import type { Role } from '$lib/auth/capabilities';
import type { DemoUser, HouseholdSummary } from '$lib/auth/types';
import { isFinanceAccountKind, isFinanceCategoryKind, type AnaliticaData, type AnaliticaPivotRow } from '$lib/finance/analitica-data';
import type { FinanceFilters } from '$lib/finance/filters';

import { demoOnly, fixturesAllowed } from './data-source.server';
import type {
  FinanceDashboardData,
  FinanceEventosData,
  FinanceImportarData,
  FinanceMovimientosData,
  FinanceRevisionData
} from './finance.server';

/**
 * Corpus de demostración. Todo lo que sale de aquí es INVENTADO.
 *
 * Cada constructor de maqueta va envuelto en `demoOnly()`: con `DATABASE_URL`
 * configurada no devuelve datos falsos, lanza. Es deliberado que sea un fallo
 * ruidoso y no un `if` en cada página: el modo de fallo que arreglamos era
 * precisamente el silencio (auditoría §R2), y una ruta que olvide la guarda
 * tiene que romperse en pruebas, no mentir en producción.
 *
 * Las tres funciones de identidad (`listDemoUsers`, `getDemoUser`,
 * `getHousehold`) NO llevan la guarda: son la puerta del selector sintético,
 * que se cierra por su propio camino (login/+page.server.ts) y que la batería
 * e2e ejercita con base de datos a propósito.
 */

// Los identificadores replican las fixtures sintéticas de @housekeeper/db
// (fixture-casa-roble): con DATABASE_URL configurada, la sesión demo opera
// directamente contra Postgres bajo RLS sin tabla de correspondencias.
const HOUSEHOLD: HouseholdSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Casa Roble',
  subtitle: 'Familia Roble · datos ficticios'
};

/** Cuenta sintética del selector: una sola membresía, la del hogar del roble. */
function demoUser(
  id: string,
  membershipId: string,
  name: string,
  initials: string,
  email: string,
  role: Role
): DemoUser {
  return {
    id,
    name,
    initials,
    email,
    memberships: [{ householdId: HOUSEHOLD.id, membershipId, role }],
    // En la demo por fixtures no hay contraseña que cambiar: nadie entró con
    // una provisional porque nadie entró con ninguna.
    mustChangePassword: false,
    // El resumen del hogar viaja CON la cuenta, y no es redundante con
    // `getHousehold()`: el layout del hogar busca el nombre en
    // `user.households` primero y solo cae a la maqueta cuando este despliegue
    // no tiene base de datos. La batería e2e con Postgres es justamente el caso
    // mixto —selector sintético SOBRE datos reales—, donde esa caída está
    // cerrada; sin esto, cada pantalla del hogar respondía «Hogar no
    // encontrado» con la membresía delante.
    households: [{ ...HOUSEHOLD }]
  };
}

const DEMO_USERS: DemoUser[] = [
  demoUser(
    'fixture:roble:admin',
    '11000000-0000-4000-8000-000000000001',
    'Alberto',
    'A',
    'alberto.admin@hogar.demo',
    'family_admin'
  ),
  demoUser(
    'fixture:roble:family',
    '11000000-0000-4000-8000-000000000002',
    'Marta',
    'M',
    'marta.familia@hogar.demo',
    'family_member'
  ),
  demoUser(
    'fixture:roble:employee',
    '11000000-0000-4000-8000-000000000003',
    'Ana',
    'AN',
    'ana.empleada@hogar.demo',
    'employee_live_in'
  ),
  demoUser(
    'fixture:roble:helper',
    '11000000-0000-4000-8000-000000000004',
    'Lucía',
    'L',
    'lucia.apoyo@hogar.demo',
    'helper'
  ),
  demoUser(
    'fixture:roble:viewer',
    '11000000-0000-4000-8000-000000000005',
    'Diego',
    'D',
    'diego.canguro@hogar.demo',
    'viewer'
  )
];

const CONTACTS = [
  { id: 'emergency-112', name: 'Emergencias', role: 'Urgencias generales', phone: '112', kind: 'emergency', featured: true },
  { id: 'pediatrics', name: 'Centro Pediátrico Olmo', role: 'Pediatría · demo', phone: '910 000 111', kind: 'health', featured: true },
  { id: 'neighbour', name: 'Carmen · 2.º B', role: 'Vecina de confianza', phone: '600 000 344', kind: 'home', featured: true },
  { id: 'plumber', name: 'Javier · Fontanería', role: 'Averías de agua', phone: '600 000 122', kind: 'service', featured: false },
  { id: 'boiler', name: 'Clima Norte', role: 'Caldera · asistencia demo', phone: '910 000 233', kind: 'service', featured: false },
  { id: 'school', name: 'Colegio Las Encinas', role: 'Secretaría', phone: '910 000 455', kind: 'school', featured: false }
] as const;

const WEEK_MENU = [
  { day: 'Lun', date: '3', lunch: 'Lentejas con verduras', dinner: 'Tortilla y tomate', note: 'Triturar una ración para Leo' },
  { day: 'Mar', date: '4', lunch: 'Arroz con pollo', dinner: 'Merluza al horno', note: 'Preparar pescado por separado' },
  { day: 'Mié', date: '5', lunch: 'Pasta con tomate', dinner: 'Crema de calabaza', note: 'Granola sin trazas de leche' },
  { day: 'Jue', date: '6', lunch: 'Garbanzos con espinacas', dinner: 'Pollo y verduras', note: 'Sin cambios' },
  { day: 'Vie', date: '7', lunch: 'Salmón con patata', dinner: 'Pizza casera', note: 'Base sin lácteos' },
  { day: 'Sáb', date: '8', lunch: 'Comida fuera', dinner: 'Sopa y sándwiches', note: 'Confirmar comensales' },
  { day: 'Dom', date: '9', lunch: 'Cocido familiar', dinner: 'Restos y fruta', note: 'Guardar dos raciones' }
] as const;

const RECIPES = [
  { id: 'crema-calabaza', title: 'Crema de calabaza', time: '35 min', servings: 4, tags: ['rápida', 'sin gluten'], tone: 'pumpkin', ingredients: ['800 g de calabaza', '200 g de patata', '1 puerro', 'Aceite de oliva'] },
  { id: 'lentejas', title: 'Lentejas con verduras', time: '1 h', servings: 6, tags: ['para congelar', 'sin lácteos'], tone: 'lentils', ingredients: ['500 g de lenteja pardina', '3 zanahorias', '1 puerro', '250 ml de tomate'] },
  { id: 'arroz-pollo', title: 'Arroz con pollo', time: '50 min', servings: 4, tags: ['favorita', 'comida'], tone: 'rice', ingredients: ['320 g de arroz', '600 g de pollo', '2 zanahorias', '150 g de guisantes'] },
  { id: 'merluza', title: 'Merluza al horno', time: '30 min', servings: 4, tags: ['pescado', 'cena'], tone: 'fish', ingredients: ['4 lomos de merluza', '600 g de patata', '1 limón', 'Perejil'] }
] as const;

const WIKI_PAGES = [
  {
    id: 'lavadora-programa-corto',
    title: 'Lavadora · programa corto',
    space: 'Equipamiento',
    summary: 'Programa, detergente y límites para una colada pequeña.',
    icon: 'washer',
    updated: 'Ayer',
    body: 'Usa el programa Mixto 40° para media carga. El detergente va en el compartimento II. No uses el programa rápido para toallas ni ropa de cama.'
  },
  {
    id: 'placa-induccion',
    title: 'Placa de inducción',
    space: 'Equipamiento',
    summary: 'Encendido, bloqueo infantil y limpieza segura.',
    icon: 'stove',
    updated: 'Hace 3 días',
    body: 'Mantén pulsado el círculo durante dos segundos. Para el bloqueo, pulsa la llave cuatro segundos. No uses estropajo verde.'
  },
  {
    id: 'se-ha-ido-la-luz',
    title: 'Se ha ido la luz',
    space: 'Incidencias',
    summary: 'Comprobaciones seguras y cuándo llamar al 112.',
    icon: 'bolt',
    updated: '12 jul',
    body: 'Comprueba primero si hay luz en la escalera. Si huele a quemado o ves humo, no toques el cuadro: sal y llama al 112.'
  },
  {
    id: 'rutina-sueno',
    title: 'Rutina de sueño de Leo',
    space: 'Crianza',
    summary: 'Baño, cuento y orden habitual antes de dormir.',
    icon: 'moon',
    updated: 'Hoy',
    body: 'A las 20:00: baño rápido, pijama, dientes y un cuento. Deja la puerta entreabierta y la luz del pasillo encendida.'
  }
] as const;

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function listDemoUsers(): DemoUser[] {
  return copy(DEMO_USERS);
}

export function getDemoUser(userId: string): DemoUser | null {
  return copy(DEMO_USERS.find((user) => user.id === userId) ?? null);
}

export function getHousehold(householdId: string): HouseholdSummary | null {
  return householdId === HOUSEHOLD.id ? copy(HOUSEHOLD) : null;
}

/** Hueco de menú del día tal y como viaja dentro del snapshot crítico. */
export interface SnapshotMenuSlot {
  id: string;
  /** «Comida», «Cena»… ya en lenguaje llano. */
  mealLabel: string;
  groupName: string;
  dish: string;
  confirmed: boolean;
}

/** Rutina que toca hoy (o se quedó pendiente) dentro del snapshot crítico. */
export interface SnapshotRoutine {
  id: string;
  title: string;
  details: string;
  /**
   * La ocurrencia CONCRETA que representa esta fila. Sin ella, marcarla desde
   * la página sin conexión obligaba a adivinar de qué día se hablaba, y el
   * comando `routine.complete` identifica la ocurrencia por su fecha.
   */
  dueOn: string;
  /** «Hoy» o «Tocaba el 3 ago 2026». */
  dueLabel: string;
  overdue: boolean;
  done: boolean;
}

/** Nota de la Guía guardada entera para poder leerla sin conexión. */
export interface SnapshotWikiPage {
  id: string;
  title: string;
  space: string;
  body: string;
}

/**
 * Bloque «hoy» del snapshot: misma forma con datos reales y con la fixture,
 * para que la página sin conexión tenga UN solo camino de pintado.
 */
// Alias de tipo (no interface) a propósito: el contrato declara `today` como
// Record<string, unknown> y solo los alias reciben firma de índice implícita.
export type SnapshotToday = {
  dateISO: string;
  dateLabel: string;
  menu: SnapshotMenuSlot[];
  routines: SnapshotRoutine[];
};

export interface CriticalSnapshotFixturePayload {
  emergency: Array<{ id: string; title: string; body: string }>;
  contacts: Array<{ id: string; name: string; phone: string; kind: string }>;
  dietaryFlags: Array<{ id: string; label: string; severity: 'high' | 'medium' }>;
  today: SnapshotToday;
  wikiPages: SnapshotWikiPage[];
}

/** Datos REALES del hogar que sustituyen a la fixture dentro del snapshot. */
export interface SnapshotHouseholdData {
  today: SnapshotToday;
  wikiPages: SnapshotWikiPage[];
}

const FIXTURE_TODAY: SnapshotToday = {
  dateISO: '2026-08-07',
  dateLabel: 'Viernes, 7 de agosto',
  menu: [
    { id: 'fixture-desayuno', mealLabel: 'Desayuno', groupName: 'Casa', dish: 'Tostadas, fruta y bebida de avena', confirmed: true },
    { id: 'fixture-comida', mealLabel: 'Comida', groupName: 'Casa', dish: 'Lentejas con verduras', confirmed: true },
    { id: 'fixture-cena', mealLabel: 'Cena', groupName: 'Casa', dish: 'Tortilla francesa y tomate', confirmed: false }
  ],
  routines: [
    { id: 'fixture-camas', title: 'Ventilar y hacer las camas', details: 'Dormitorios', dueOn: '2026-08-07', dueLabel: 'Hoy', overdue: false, done: true },
    { id: 'fixture-lavadora', title: 'Poner lavadora clara', details: 'Lavandería', dueOn: '2026-08-07', dueLabel: 'Hoy', overdue: false, done: false }
  ]
};

/**
 * El 112 no sale de la base de datos ni de ninguna maqueta: es el número
 * universal de emergencias y la aplicación lo pinta siempre, esté como esté
 * todo lo demás. Es la ÚNICA cosa que el paquete offline puede afirmar cuando
 * no ha podido leer el hogar.
 */
const EMERGENCY_112 = { id: 'emergency-112', name: 'Emergencias', phone: '112', kind: 'emergency' } as const;

/** «Hoy» sin nada que contar: la forma completa, todos los huecos vacíos. */
const EMPTY_TODAY: SnapshotToday = { dateISO: '', dateLabel: '', menu: [], routines: [] };

/**
 * Contenido del snapshot crítico (el paquete que se guarda firmado en el
 * dispositivo y sostiene el modo sin conexión).
 *
 * Tres estados, y solo tres:
 *
 * - **Real**: hay datos del hogar. Ni una nota de demostración se mezcla.
 * - **Parcial**: hay base de datos configurada pero no se pudo leer (o el
 *   hogar aún está vacío). El paquete lleva el 112 y nada más. Un snapshot
 *   pobre es recuperable; uno con teléfonos inventados, firmado con la clave
 *   real y guardado en el móvil de quien cuida la casa, no lo es.
 * - **Maqueta**: solo sin `DATABASE_URL`, es decir, en la demostración.
 */
export function getCriticalSnapshotPayload(
  realContacts?: Array<{ id: string; name: string; phone: string; kind: string }> | null,
  realHousehold?: SnapshotHouseholdData | null
): CriticalSnapshotFixturePayload {
  if (!fixturesAllowed()) {
    return {
      emergency: [],
      contacts: realContacts ? realContacts.map((contact) => ({ ...contact })) : [{ ...EMERGENCY_112 }],
      dietaryFlags: [],
      today: realHousehold
        ? { ...realHousehold.today, menu: [...realHousehold.today.menu], routines: [...realHousehold.today.routines] }
        : { ...EMPTY_TODAY },
      wikiPages: realHousehold ? realHousehold.wikiPages.map((page) => ({ ...page })) : []
    };
  }
  return {
    // Con contactos REALES del hogar las notas de demostración desaparecen:
    // el snapshot no debe mezclar datos verdaderos con inventados sin marca.
    emergency: realContacts
      ? []
      : [
          { id: 'note-allergy', title: 'Alergia alimentaria', body: 'Alergia alimentaria de demostración: revisar siempre las etiquetas.' },
          { id: 'note-water', title: 'Corte de agua', body: 'La llave de corte de agua está bajo el fregadero.' }
        ],
    contacts: realContacts
      ? realContacts.map((contact) => ({ ...contact }))
      : CONTACTS.filter((contact) => contact.featured).map((contact) => ({
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          kind: contact.kind
        })),
    // La alergia de demostración desaparece igual que las notas en cuanto hay
    // hogar real detrás: los avisos alimentarios viven en Comida, no aquí.
    dietaryFlags: realHousehold ? [] : [{ id: 'dairy-free', label: 'Leo · sin lácteos', severity: 'high' }],
    today: realHousehold
      ? realHousehold.today
      : { ...FIXTURE_TODAY, menu: FIXTURE_TODAY.menu.map((slot) => ({ ...slot })), routines: FIXTURE_TODAY.routines.map((routine) => ({ ...routine })) },
    wikiPages: realHousehold
      ? realHousehold.wikiPages.map((page) => ({ ...page }))
      : WIKI_PAGES.map((page) => ({ id: page.id, title: page.title, space: page.space, body: page.body }))
  };
}

function buildTodayFixture() {
  return copy({
    greeting: 'Buenos días',
    dateLabel: 'Viernes, 7 de agosto',
    progress: { done: 3, total: 6 },
    tasks: [
      { id: 'beds', time: '09:00', title: 'Ventilar y hacer las camas', area: 'Dormitorios', done: true },
      { id: 'laundry', time: '10:30', title: 'Poner lavadora clara', area: 'Lavandería', done: true },
      { id: 'lunch', time: '13:30', title: 'Terminar las lentejas', area: 'Cocina', done: false },
      { id: 'school', time: '16:45', title: 'Recoger a Leo', area: 'Colegio', done: false },
      { id: 'bath', time: '19:45', title: 'Preparar baño y pijama', area: 'Crianza', done: false }
    ],
    menu: [
      { time: '08:00', label: 'Desayuno', dish: 'Tostadas, fruta y bebida de avena' },
      { time: '14:00', label: 'Comida', dish: 'Lentejas con verduras' },
      { time: '20:30', label: 'Cena', dish: 'Tortilla francesa y tomate' }
    ],
    agenda: [
      { time: '16:45', title: 'Recoger a Leo', meta: 'Colegio Las Encinas' },
      { time: '18:30', title: 'Natación', meta: 'Piscina municipal' }
    ],
    note: 'La compra llega entre las 12:00 y las 13:00. Dejar espacio en la entrada.'
  });
}

function buildEmploymentFixture() {
  return copy({
    period: 'Julio 2026',
    status: 'Pendiente de confirmación',
    salaryTotal: '1.336,00 €',
    reimbursementTotal: '47,30 €',
    transferTotal: '1.383,30 €',
    lines: [
      { concept: 'Salario acordado', detail: '1 mes', amount: '1.400,00 €' },
      { concept: 'Horas extraordinarias', detail: '3 h × 12,00 €', amount: '+36,00 €' },
      { concept: 'Anticipo', detail: 'Cuota mensual', amount: '−100,00 €' },
      { concept: 'Reembolso de gastos', detail: '2 justificantes', amount: '+47,30 €' }
    ],
    balance: [
      { label: 'Días por compensar', value: '1 día', detail: 'Caduca el 23 sep' },
      { label: 'Horas registradas', value: '3 h', detail: 'Confirmadas' }
    ]
  });
}

function buildMenuFixture() {
  return copy({ weekLabel: '3–9 de agosto', days: WEEK_MENU });
}

function buildRecipesFixture() {
  return copy({ recipes: RECIPES });
}

function buildWikiFixture() {
  return copy({ spaces: ['Todo', 'Equipamiento', 'Incidencias', 'Crianza'], pages: WIKI_PAGES });
}

function buildSearchFixture(query: string) {
  const normalized = query.trim().toLocaleLowerCase('es');
  const corpus = [
    ...WIKI_PAGES.map((page) => ({ type: 'Guía', title: page.title, description: page.summary, href: 'wiki' })),
    ...RECIPES.map((recipe) => ({ type: 'Receta', title: recipe.title, description: recipe.tags.join(' · '), href: 'recipes' })),
    ...CONTACTS.map((contact) => ({ type: 'Contacto', title: contact.name, description: contact.role, href: 'contacts' }))
  ];
  const results = normalized
    ? corpus.filter((item) => `${item.title} ${item.description}`.toLocaleLowerCase('es').includes(normalized))
    : [];
  return copy({ query, results: results.slice(0, 12), suggested: ['lavadora', 'caldera', 'pediatra'] });
}

function buildRoutinesFixture() {
  return copy({
    progress: { done: 3, total: 7 },
    groups: [
      { title: 'Mañana', items: [{ id: 'beds', title: 'Ventilar dormitorios', done: true }, { id: 'bathrooms', title: 'Repaso de baños', done: true }, { id: 'laundry', title: 'Lavadora clara', done: true }] },
      { title: 'Tarde', items: [{ id: 'kitchen', title: 'Recoger cocina', done: false }, { id: 'uniform', title: 'Preparar uniforme', done: false }] },
      { title: 'Semanal', items: [{ id: 'sheets', title: 'Cambiar sábanas', done: false }, { id: 'plants', title: 'Regar plantas', done: false }] }
    ]
  });
}

function buildCalendarFixture() {
  return copy({
    month: 'Agosto 2026',
    events: [
      { date: 'Vie 7', time: '16:45', title: 'Recoger a Leo', tone: 'school', audience: 'Todos' },
      { date: 'Vie 7', time: '18:30', title: 'Natación', tone: 'activity', audience: 'Familia' },
      { date: 'Lun 10', time: '09:30', title: 'Revisión de caldera', tone: 'home', audience: 'Casa' },
      { date: 'Mié 12', time: '17:00', title: 'Pediatra', tone: 'health', audience: 'Familia' }
    ]
  });
}

function buildContactsFixture() {
  return copy({ contacts: CONTACTS });
}

function buildEmergencyFixture() {
  return copy({
    updatedLabel: 'Guardada hoy en este dispositivo · se abre sin conexión',
    contacts: CONTACTS.filter((contact) => contact.featured),
    instructions: [
      { title: 'Emergencia vital', body: 'Llama al 112. Indica la dirección y no cuelgues hasta que te lo pidan.' },
      { title: 'Corte de agua', body: 'La llave general está bajo el fregadero, marcada en azul.' },
      { title: 'Humo o fuego', body: 'Sal de casa, cierra la puerta si es seguro y llama al 112 desde fuera.' }
    ]
  });
}

function buildSettingsFixture() {
  return copy({
    household: HOUSEHOLD,
    // El papel de la maqueta es el que cada cuenta juega EN ESTE hogar.
    members: DEMO_USERS.map(({ id, name, initials, memberships }) => {
      // R7: sin `!`. Cada cuenta demo se construye con exactamente una
      // membresía (`demoUser` arriba); si eso dejara de ser cierto, esto lo
      // dice en vez de colar `undefined` como papel.
      const [membership] = memberships;
      if (!membership) throw new Error(`la cuenta demo ${id} no tiene membresía`);
      return { id, name, initials, role: membership.role };
    }),
    preferences: { locale: 'Español (España)', timeZone: 'Europe/Madrid', weekStarts: 'Lunes' }
  });
}

/*
 * Puertas de las maquetas. Cada una solo entrega datos si este despliegue NO
 * tiene `DATABASE_URL`; con hogar real detrás lanzan `FixturesForbiddenError`.
 * Es la traducción literal de la regla: con base configurada, las maquetas no
 * existen. La comprobación no vive en las páginas —donde se puede olvidar—
 * sino aquí, donde no hay forma de rodearla.
 */
export const getTodayFixture = demoOnly('Hoy', buildTodayFixture);
export const getEmploymentFixture = demoOnly('expediente laboral', buildEmploymentFixture);
export const getMenuFixture = demoOnly('menú semanal', buildMenuFixture);
export const getRecipesFixture = demoOnly('recetario', buildRecipesFixture);
export const getWikiFixture = demoOnly('Guía', buildWikiFixture);
export const getSearchFixture = demoOnly('búsqueda', buildSearchFixture);
export const getRoutinesFixture = demoOnly('rutinas', buildRoutinesFixture);
export const getCalendarFixture = demoOnly('calendario', buildCalendarFixture);
export const getContactsFixture = demoOnly('directorio de contactos', buildContactsFixture);
export const getEmergencyFixture = demoOnly('Emergencias', buildEmergencyFixture);
export const getSettingsFixture = demoOnly('ajustes', buildSettingsFixture);

// ── Finanzas (fase 4): corpus demo del módulo. Todo inventado. ───────────────

// F6-I2 (R7): los movimientos de la maqueta referenciaban la cuenta por un
// índice del array con aserción de no-nulo, que R7 prohíbe. Los ids son
// constantes como las de categoría (CAT_SUPERMERCADO más abajo): se nombran
// una vez y el array las usa, así que no hay índice que estrechar ni aserción
// que sostener.
const CUENTA_COMUN = 'fa000000-0000-4000-8000-000000000001';
const CUENTA_NOMINA = 'fa000000-0000-4000-8000-000000000002';

const FINANCE_ACCOUNTS = [
  { id: CUENTA_COMUN, name: 'Cuenta común', bank: 'caixabank', kind: 'comun', ownerLabel: 'familia', archived: false },
  { id: CUENTA_NOMINA, name: 'Cuenta nómina', bank: 'openbank', kind: 'personal', ownerLabel: 'padre', archived: false },
  { id: 'fa000000-0000-4000-8000-000000000003', name: 'Plan índice', bank: 'deutsche_bank', kind: 'inversion', ownerLabel: 'familia', archived: false }
];

const FINANCE_CATEGORIES = [
  { id: 'fb000000-0000-4000-8000-000000000001', name: 'Casa', parentId: null, kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000002', name: 'Supermercado', parentId: 'fb000000-0000-4000-8000-000000000001', kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000003', name: 'Suministros', parentId: 'fb000000-0000-4000-8000-000000000001', kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000004', name: 'Ingresos', parentId: null, kind: 'ingreso' },
  { id: 'fb000000-0000-4000-8000-000000000005', name: 'Nómina', parentId: 'fb000000-0000-4000-8000-000000000004', kind: 'ingreso' },
  { id: 'fb000000-0000-4000-8000-000000000006', name: 'Transferencias', parentId: null, kind: 'transferencia' }
];

/** Serie mensual coherente: ahorro = ingresos + gastos en cada cubo. */
const FINANCE_SERIES = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map(
  (bucket, index) => {
    const income = 420000n + BigInt(index) * 1000n;
    const expense = -(300000n + BigInt(index % 3) * 12000n);
    return { bucket, incomeCents: income.toString(), expenseCents: expense.toString(), savingsCents: (income + expense).toString() };
  }
);

const FINANCE_SUMMARY_PREV = {
  incomeCents: '402000', expenseCents: '-355000', recurringExpenseCents: '-260000',
  extraordinaryExpenseCents: '-80000', unclassifiedExpenseCents: '-15000',
  savingsCents: '47000', netSavingsRate: 11.7, grossSavingsRate: 35.3,
  investedCents: '40000', investmentRate: 10, freeCashFlowCents: '7000', opsCashFlowCents: '47000',
  receivedContributionsCents: '0', outgoingTransfersCents: '0', pendingCount: 0, prev: null
};

export const getFinanceDashboardFixture = demoOnly(
  'finance-dashboard',
  (filters: FinanceFilters): FinanceDashboardData => ({
    householdId: HOUSEHOLD.id,
    filters,
    summary: {
      incomeCents: '425000', expenseCents: '-318550', recurringExpenseCents: '-214000',
      extraordinaryExpenseCents: '-84550', unclassifiedExpenseCents: '-20000',
      savingsCents: '106450', netSavingsRate: 25, grossSavingsRate: 49.6,
      investedCents: '60000', investmentRate: 14.1, freeCashFlowCents: '46450', opsCashFlowCents: '106450',
      receivedContributionsCents: '0', outgoingTransfersCents: '0', pendingCount: 3,
      prev: FINANCE_SUMMARY_PREV
    },
    series: FINANCE_SERIES,
    breakdown: [
      { categoryId: 'fb000000-0000-4000-8000-000000000002', name: 'Supermercado', parentId: 'fb000000-0000-4000-8000-000000000001', totalCents: '-182000', count: 14 },
      { categoryId: 'fb000000-0000-4000-8000-000000000003', name: 'Suministros', parentId: 'fb000000-0000-4000-8000-000000000001', totalCents: '-96550', count: 6 },
      { categoryId: null, name: 'Sin categorizar', parentId: null, totalCents: '-40000', count: 3 },
      { categoryId: 'fb000000-0000-4000-8000-000000000005', name: 'Nómina', parentId: 'fb000000-0000-4000-8000-000000000004', totalCents: '425000', count: 2 }
    ],
    providers: [
      { provider: 'SUPERMERCADOS ENCINA', providerDisplay: 'Encina', totalCents: '-98000', count: 9 },
      { provider: 'LUZ DEL VALLE SA', providerDisplay: 'Luz del Valle', totalCents: '-56550', count: 4 },
      { provider: 'AGUAS DE LA VEGA', providerDisplay: 'Aguas de la Vega', totalCents: '-24000', count: 2 }
    ],
    accounts: FINANCE_ACCOUNTS,
    categories: FINANCE_CATEGORIES
  })
);

// Tipado explícito: sin él, TS infiere cada `raw` por separado (llaves
// distintas según la fila) y la unión resultante deja de encajar en
// `Record<string, string>` — cada firma de índice ve las llaves ausentes de
// las demás filas como opcionales, no como ausentes.
const FINANCE_TXS: FinanceTxDto[] = [
  {
    id: 'fc000000-0000-4000-8000-000000000001', accountId: CUENTA_COMUN, accountName: 'Cuenta común',
    opDate: '2026-08-28', valueDate: '2026-08-28', concept: 'COMPRA SUPERMERCADOS ENCINA MADRID',
    provider: 'SUPERMERCADOS ENCINA', providerNorm: 'supermercados encina', providerDisplay: 'Encina',
    amountCents: '-8734', balanceCents: '215600', codeCommon: '12', codeOwn: '300',
    categoryId: 'fb000000-0000-4000-8000-000000000002', categoryName: 'Supermercado',
    status: 'confirmada', transferGroupId: null, recurrence: 'recurrente' as const, recurrenceManual: false,
    bankCategory: 'Alimentación', eventIds: [],
    raw: { 'Fecha operación': '28/08/2026', 'Concepto': 'COMPRA SUPERMERCADOS ENCINA MADRID', 'Importe': '-87,34', 'Saldo': '2.156,00' },
    dedupHash: 'demo-fixture-tx-0001', batchId: 'fb100000-0000-4000-8000-000000000001'
  },
  {
    id: 'fc000000-0000-4000-8000-000000000002', accountId: CUENTA_NOMINA, accountName: 'Cuenta nómina',
    opDate: '2026-08-25', valueDate: '2026-08-25', concept: 'NOMINA AGOSTO TALLERES ROBLE SL',
    provider: 'TALLERES ROBLE SL', providerNorm: 'talleres roble sl', providerDisplay: 'Talleres Roble',
    amountCents: '212500', balanceCents: '389000', codeCommon: '01', codeOwn: '100',
    categoryId: 'fb000000-0000-4000-8000-000000000005', categoryName: 'Nómina',
    status: 'confirmada', transferGroupId: null, recurrence: 'recurrente' as const, recurrenceManual: false,
    bankCategory: null, eventIds: [],
    raw: { 'Fecha operación': '25/08/2026', 'Concepto': 'NOMINA AGOSTO TALLERES ROBLE SL', 'Importe': '2.125,00' },
    dedupHash: 'demo-fixture-tx-0002', batchId: 'fb100000-0000-4000-8000-000000000001'
  },
  {
    id: 'fc000000-0000-4000-8000-000000000003', accountId: CUENTA_NOMINA, accountName: 'Cuenta nómina',
    opDate: '2026-08-20', valueDate: null, concept: 'TRASPASO A CUENTA COMUN',
    provider: null, providerNorm: null, providerDisplay: null,
    amountCents: '-50000', balanceCents: null, codeCommon: null, codeOwn: null,
    categoryId: 'fb000000-0000-4000-8000-000000000006', categoryName: 'Transferencias',
    status: 'confirmada', transferGroupId: 'fd000000-0000-4000-8000-000000000001', recurrence: null, recurrenceManual: false,
    bankCategory: null, eventIds: [], raw: null,
    dedupHash: 'demo-fixture-tx-0003', batchId: null
  },
  {
    id: 'fc000000-0000-4000-8000-000000000004', accountId: CUENTA_COMUN, accountName: 'Cuenta común',
    opDate: '2026-08-20', valueDate: '2026-08-20', concept: 'TRANSFERENCIA DE CUENTA NOMINA',
    provider: null, providerNorm: null, providerDisplay: null,
    amountCents: '50000', balanceCents: '224334', codeCommon: '04', codeOwn: null,
    categoryId: 'fb000000-0000-4000-8000-000000000006', categoryName: 'Transferencias',
    status: 'confirmada', transferGroupId: 'fd000000-0000-4000-8000-000000000001', recurrence: null, recurrenceManual: false,
    bankCategory: null, eventIds: [],
    raw: { 'Fecha operación': '20/08/2026', 'Concepto': 'TRANSFERENCIA DE CUENTA NOMINA', 'Importe': '500,00' },
    dedupHash: 'demo-fixture-tx-0004', batchId: null
  },
  {
    id: 'fc000000-0000-4000-8000-000000000005', accountId: CUENTA_COMUN, accountName: 'Cuenta común',
    opDate: '2026-08-12', valueDate: '2026-08-12', concept: 'RECIBO LUZ DEL VALLE SA',
    provider: 'LUZ DEL VALLE SA', providerNorm: 'luz del valle sa', providerDisplay: 'Luz del Valle',
    amountCents: '-14210', balanceCents: '174334', codeCommon: '03', codeOwn: '210',
    categoryId: 'fb000000-0000-4000-8000-000000000003', categoryName: 'Suministros',
    status: 'sugerida_regla', transferGroupId: null, recurrence: 'recurrente' as const, recurrenceManual: false,
    bankCategory: 'Hogar', eventIds: [],
    raw: { 'Fecha operación': '12/08/2026', 'Concepto': 'RECIBO LUZ DEL VALLE SA', 'Importe': '-142,10' },
    dedupHash: 'demo-fixture-tx-0005', batchId: 'fb100000-0000-4000-8000-000000000001'
  }
];

export const getFinanceMovimientosFixture = demoOnly(
  'finance-movimientos',
  (filters: FinanceFilters): FinanceMovimientosData => ({
    householdId: HOUSEHOLD.id,
    filters,
    page: {
      total: FINANCE_TXS.length,
      sumCents: FINANCE_TXS.reduce((acc, tx) => acc + BigInt(tx.amountCents), 0n).toString(),
      limit: 100,
      offset: 0,
      rows: FINANCE_TXS
    },
    accounts: FINANCE_ACCOUNTS,
    categories: FINANCE_CATEGORIES,
    events: [{ id: 'fe000000-0000-4000-8000-000000000001', name: 'Semana Santa 2026' }]
  })
);

// ── Maqueta de Analítica (fase 6) ────────────────────────────────────────────
// Reutiliza las cuentas y categorías del corpus de finanzas de la fase 4
// (FINANCE_ACCOUNTS/FINANCE_CATEGORIES arriba): una sola lista de cuentas y
// una sola lista base de categorías demo en el fichero. `kind` en esas
// constantes es `string` (inferido); la guarda de analitica-data.ts estrecha
// el tipo y hace explícito que aquí no hay ningún valor inesperado.
export type AnaliticaFixture = Omit<AnaliticaData, 'filters'>;

const ANALITICA_ACCOUNTS = FINANCE_ACCOUNTS.map((acc) => {
  if (!isFinanceAccountKind(acc.kind)) throw new Error(`kind de cuenta demo desconocido: ${acc.kind}`);
  return { id: acc.id, name: acc.name, kind: acc.kind };
});

// Categorías extra propias de Analítica (destino del dnd / partidas de la
// maqueta): la fase 4 no las necesitaba. Se CONCATENAN solo para
// ANALITICA_CATEGORIES, sin mutar FINANCE_CATEGORIES: Dashboard/Movimientos
// (finance-fixtures.test.ts) y el e2e de fase 4 siguen viendo exactamente el
// corpus de categorías que ya tenían.
const ANALITICA_EXTRA_CATEGORIES = [
  { id: 'fb000000-0000-4000-8000-000000000007', name: 'Restaurantes', parentId: null, kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000008', name: 'Ocio', parentId: null, kind: 'gasto' },
  { id: 'fb000000-0000-4000-8000-000000000009', name: 'Viajes', parentId: null, kind: 'gasto' }
] as const;

const ANALITICA_CATEGORIES = [...FINANCE_CATEGORIES, ...ANALITICA_EXTRA_CATEGORIES].map((cat) => {
  if (!isFinanceCategoryKind(cat.kind)) throw new Error(`kind de categoría demo desconocido: ${cat.kind}`);
  return { id: cat.id, parentId: cat.parentId, name: cat.name, kind: cat.kind };
});

const CAT_SUPERMERCADO = 'fb000000-0000-4000-8000-000000000002';
const CAT_NOMINA = 'fb000000-0000-4000-8000-000000000005';
const CAT_OCIO = 'fb000000-0000-4000-8000-000000000008';
const CAT_VIAJES = 'fb000000-0000-4000-8000-000000000009';

const analiticaMov = (id: string, date: string, cents: bigint) => ({ id, date, cents });

function analiticaPivotRows(): AnaliticaPivotRow[] {
  const mov = analiticaMov;
  // F6-I2 (R7): anotar el tipo en vez de asertarlo. Sin la anotación TS
  // infería `nat: null` (literal) y las filas que lo pisan con 'recurrente' no
  // encajaban; con `Pick<…>` el contexto ya es el union del contrato y no hace
  // falta ningún `as` sobre el dato.
  const base: Pick<AnaliticaPivotRow, 'sub' | 'event' | 'eventId' | 'nat'> = {
    sub: null, event: null, eventId: null, nat: null
  };
  return [
    // Gasto recurrente: Mercadona bajo Supermercado, tres meses.
    ...(['2026-01', '2026-02', '2026-03'] as const).map(
      (month, i): AnaliticaPivotRow => ({
        ...base,
        kind: 'gasto',
        cat: 'Supermercado',
        catId: CAT_SUPERMERCADO,
        nat: 'recurrente',
        prov: 'Mercadona',
        concept: 'COMPRA TARJ. MERCADONA',
        month,
        totalCents: -12000n,
        count: 1,
        movs: [mov(`fd000000-0000-4000-8000-00000000010${i + 1}`, `${month}-05`, -12000n)]
      })
    ),
    // Gasto extraordinario puntual: Cine Ideal bajo Ocio.
    {
      ...base,
      kind: 'gasto',
      cat: 'Ocio',
      catId: CAT_OCIO,
      nat: 'extraordinario',
      prov: 'Cine Ideal',
      concept: 'ENTRADAS CINE',
      month: '2026-02',
      totalCents: -4500n,
      count: 1,
      movs: [mov('fd000000-0000-4000-8000-000000000104', '2026-02-14', -4500n)]
    },
    // Ingreso recurrente: nómina ACME.
    ...(['2026-01', '2026-02', '2026-03'] as const).map(
      (month, i): AnaliticaPivotRow => ({
        ...base,
        kind: 'ingreso',
        cat: 'Nómina',
        catId: CAT_NOMINA,
        nat: 'recurrente',
        prov: 'ACME SL',
        concept: 'NOMINA ACME',
        month,
        totalCents: 300000n,
        count: 1,
        movs: [mov(`fd000000-0000-4000-8000-00000000010${i + 5}`, `${month}-28`, 300000n)]
      })
    ),
    // Evento: Vueling bajo Viajes, etiquetado «Semana Santa 2026».
    {
      ...base,
      kind: 'gasto',
      cat: 'Viajes',
      catId: CAT_VIAJES,
      nat: 'extraordinario',
      prov: 'Vueling',
      concept: 'BILLETES VLC',
      event: 'Semana Santa 2026',
      eventId: 'fc000000-0000-4000-8000-000000000011',
      month: '2026-03',
      totalCents: -22000n,
      count: 1,
      movs: [mov('fd000000-0000-4000-8000-000000000108', '2026-03-20', -22000n)]
    },
    // Internas: dos patas del mismo traspaso, suman 0.
    {
      ...base,
      kind: 'transferencia',
      cat: 'Traspaso hogar',
      catId: null,
      prov: 'Cuenta Común',
      concept: 'TRASPASO MENSUAL',
      month: '2026-01',
      totalCents: -50000n,
      count: 1,
      movs: [mov('fd000000-0000-4000-8000-000000000109', '2026-01-02', -50000n)]
    },
    {
      ...base,
      kind: 'transferencia',
      cat: 'Traspaso hogar',
      catId: null,
      prov: 'Cuenta Nómina',
      concept: 'TRASPASO MENSUAL',
      month: '2026-01',
      totalCents: 50000n,
      count: 1,
      movs: [mov('fd000000-0000-4000-8000-000000000110', '2026-01-02', 50000n)]
    },
    // Inversión: aportación al Plan índice.
    {
      ...base,
      kind: 'inversion',
      cat: 'Plan índice',
      catId: null,
      prov: 'Plan índice',
      concept: 'Aportación fondo',
      month: '2026-02',
      totalCents: 20000n,
      count: 1,
      movs: [mov('fd000000-0000-4000-8000-000000000111', '2026-02-10', 20000n)]
    }
  ];
}

/**
 * Maqueta de Analítica: solo existe sin base de datos (demoOnly la protege).
 *
 * F6-M4: toma los filtros como `getFinanceDashboardFixture(filters)`. Los DATOS
 * siguen siendo la maqueta fija de tres meses; los filtros solo fijan el rango
 * ANUNCIADO (`from`/`to`), que es de donde salen el rótulo de medias mensuales
 * y el número de meses completos. Sin ellos la cabecera decía un rango y el
 * rótulo de debajo otro.
 */
export const getFinanceAnaliticaFixture = demoOnly('finanzas-analitica', (filters: FinanceFilters): AnaliticaFixture => {
  const pivotRows = analiticaPivotRows();
  return {
    from: filters.from,
    to: filters.to,
    months: ['2026-01', '2026-02', '2026-03'],
    summary: {
      incomeCents: 900000n,
      expenseCents: -62500n,
      recurringExpenseCents: -36000n,
      extraordinaryExpenseCents: -26500n,
      unclassifiedExpenseCents: 0n,
      savingsCents: 837500n,
      netSavingsRate: 93,
      grossSavingsRate: 96,
      investedCents: 20000n,
      investmentRate: 2,
      freeCashFlowCents: 817500n,
      opsCashFlowCents: 837500n,
      receivedContributionsCents: 0n,
      outgoingTransfersCents: 0n,
      pendingCount: 2
    },
    analyticsRows: [
      {
        kind: 'ingreso',
        monthly: {
          '2026-01': { totalCents: 300000n, recCents: 300000n, extCents: 0n },
          '2026-02': { totalCents: 300000n, recCents: 300000n, extCents: 0n },
          '2026-03': { totalCents: 300000n, recCents: 300000n, extCents: 0n }
        }
      },
      {
        kind: 'gasto',
        monthly: {
          '2026-01': { totalCents: -12000n, recCents: -12000n, extCents: 0n },
          '2026-02': { totalCents: -16500n, recCents: -12000n, extCents: -4500n },
          '2026-03': { totalCents: -34000n, recCents: -12000n, extCents: -22000n }
        }
      },
      { kind: 'inversion', monthly: { '2026-02': { totalCents: 20000n, recCents: 0n, extCents: 0n } } }
    ],
    pivotRows,
    eventsSummary: [
      {
        id: 'fc000000-0000-4000-8000-000000000011',
        name: 'Semana Santa 2026',
        txCount: 1,
        netCents: -22000n,
        incomeCents: 0n,
        expenseCents: -22000n
      },
      {
        id: 'fc000000-0000-4000-8000-000000000012',
        name: 'Cumple Leo',
        txCount: 0,
        netCents: 0n,
        incomeCents: 0n,
        expenseCents: 0n
      }
    ],
    categories: ANALITICA_CATEGORIES,
    accounts: ANALITICA_ACCOUNTS,
    invAccounts: ANALITICA_ACCOUNTS.filter((acc) => acc.kind === 'inversion').map((acc) => ({
      id: acc.id,
      name: acc.name
    }))
  };
});
export const getFinanceRevisionFixture = demoOnly(
  'finanzas/revision',
  (range: { from: string; to: string }): FinanceRevisionData => ({
    from: range.from,
    to: range.to,
    rows: [
      {
        id: 'fc100000-0000-4000-8000-000000000001',
        opDate: range.from,
        accountName: 'Cuenta común (demo)',
        concept: 'COMPRA SUPERMERCADO DEMO',
        provider: 'SUPERMERCADO DEMO',
        providerDisplay: null,
        amountCents: '-2350',
        status: 'pendiente',
        categoryId: null,
        recurrence: null,
        transferGroupId: null
      },
      // [FASE 5, T10 · corrección Important 3] `sugerida_regla` con categoría
      // ya asignada: sin esta fila la demo nunca enseñaba el botón «Confirmar
      // N sugerencias» ni la etiqueta STATUS_LABEL de una sugerencia.
      {
        id: 'fc100000-0000-4000-8000-000000000002',
        opDate: range.to,
        accountName: 'Cuenta común (demo)',
        concept: 'RECIBO LUZ DEMO',
        provider: 'LUZ DEMO',
        providerDisplay: null,
        amountCents: '-6100',
        status: 'sugerida_regla',
        categoryId: 'fc200000-0000-4000-8000-000000000001',
        recurrence: 'recurrente',
        transferGroupId: null
      }
    ],
    categories: [
      { id: 'fc200000-0000-4000-8000-000000000001', name: 'Casa', parentId: null, kind: 'gasto' }
    ]
  })
);

const DEMO_EVENT_ID = 'fc300000-0000-4000-8000-000000000001';

export const getFinanceEventosFixture = demoOnly(
  'finanzas/eventos',
  // [FASE 5, T11 · revisión ronda 1, Minor 7] La maqueta fijaba `openId: null`
  // y `detail: null` pasase lo que pasase: en demo el botón «▾» no hacía
  // nada, y parecía roto. Ahora respeta el `open` recibido (igual que el
  // cargador real) y ofrece un desglose falso cuando coincide con el único
  // evento demo.
  (range: { from: string; to: string }, openId: string | null = null): FinanceEventosData => ({
    from: range.from,
    to: range.to,
    openId,
    detail:
      openId === DEMO_EVENT_ID
        ? [
            { categoryId: 'fc400000-0000-4000-8000-000000000001', name: 'Alojamiento (demo)', count: 2, totalCents: '-30000' },
            { categoryId: null, name: 'Sin categorizar', count: 1, totalCents: '-12000' }
          ]
        : null,
    summary: [
      {
        id: DEMO_EVENT_ID,
        name: 'Semana Santa (demo)',
        txCount: 3,
        expenseCents: '-42000',
        incomeCents: '0',
        netCents: '-42000',
        totalCount: 3
      }
    ]
  })
);

export const getFinanceImportarFixture = demoOnly(
  'finanzas/importar',
  // [Ajuste sobre el brief] El id de ejemplo del brief (`fc400000…0001`) ya
  // identifica una categoría dentro de esta misma maqueta (el desglose del
  // evento demo, arriba): son formas distintas y ningún código las compara,
  // pero reutilizar el mismo id para dos entidades del mismo corpus es
  // confuso de leer y de depurar, así que este lote usa un id propio.
  (): FinanceImportarData => ({
    batches: [
      {
        id: 'fc500000-0000-4000-8000-000000000001',
        filename: 'movimientos-demo.xls',
        bank: 'openbank',
        importedAt: '2026-08-01T10:00:00',
        newCount: 12,
        dupCount: 0
      }
    ]
  })
);
