import type { Role } from '$lib/auth/capabilities';
import type { DemoUser, HouseholdSummary } from '$lib/auth/types';

import { demoOnly, fixturesAllowed } from './data-source.server';

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
    members: DEMO_USERS.map(({ id, name, initials, memberships }) => ({
      id,
      name,
      initials,
      role: memberships[0]!.role
    })),
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
