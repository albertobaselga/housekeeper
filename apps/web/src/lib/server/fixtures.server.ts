import type { DemoUser, HouseholdSummary } from '$lib/auth/types';

// Los identificadores replican las fixtures sintéticas de @casa-clara/db
// (fixture-casa-roble): con DATABASE_URL configurada, la sesión demo opera
// directamente contra Postgres bajo RLS sin tabla de correspondencias.
const HOUSEHOLD: HouseholdSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Casa Clara',
  subtitle: 'Familia Roble · datos ficticios'
};

const DEMO_USERS: DemoUser[] = [
  {
    id: 'fixture:roble:admin',
    membershipId: '11000000-0000-4000-8000-000000000001',
    name: 'Alberto',
    initials: 'A',
    email: 'alberto.admin@casaclara.demo',
    role: 'family_admin',
    householdIds: [HOUSEHOLD.id]
  },
  {
    id: 'fixture:roble:family',
    membershipId: '11000000-0000-4000-8000-000000000002',
    name: 'Marta',
    initials: 'M',
    email: 'marta.familia@casaclara.demo',
    role: 'family_member',
    householdIds: [HOUSEHOLD.id]
  },
  {
    id: 'fixture:roble:employee',
    membershipId: '11000000-0000-4000-8000-000000000003',
    name: 'Ana',
    initials: 'AN',
    email: 'ana.empleada@casaclara.demo',
    role: 'employee_live_in',
    householdIds: [HOUSEHOLD.id]
  },
  {
    id: 'fixture:roble:helper',
    membershipId: '11000000-0000-4000-8000-000000000004',
    name: 'Lucía',
    initials: 'L',
    email: 'lucia.apoyo@casaclara.demo',
    role: 'helper',
    householdIds: [HOUSEHOLD.id]
  },
  {
    id: 'fixture:roble:viewer',
    membershipId: '11000000-0000-4000-8000-000000000005',
    name: 'Diego',
    initials: 'D',
    email: 'diego.canguro@casaclara.demo',
    role: 'viewer',
    householdIds: [HOUSEHOLD.id]
  }
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

/** Rutina que vence hoy (o antes) dentro del snapshot crítico. */
export interface SnapshotRoutine {
  id: string;
  title: string;
  details: string;
  /** «Hoy» o «Vencía el 3 de agosto». */
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
    { id: 'fixture-camas', title: 'Ventilar y hacer las camas', details: 'Dormitorios', dueLabel: 'Hoy', overdue: false, done: true },
    { id: 'fixture-lavadora', title: 'Poner lavadora clara', details: 'Lavandería', dueLabel: 'Hoy', overdue: false, done: false }
  ]
};

export function getCriticalSnapshotPayload(
  realContacts?: Array<{ id: string; name: string; phone: string; kind: string }> | null,
  realHousehold?: SnapshotHouseholdData | null
): CriticalSnapshotFixturePayload {
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

export function getTodayFixture() {
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

export function getEmploymentFixture() {
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

export function getMenuFixture() {
  return copy({ weekLabel: '3–9 de agosto', days: WEEK_MENU });
}

export function getRecipesFixture() {
  return copy({ recipes: RECIPES });
}

export function getWikiFixture() {
  return copy({ spaces: ['Todo', 'Equipamiento', 'Incidencias', 'Crianza'], pages: WIKI_PAGES });
}

export function getSearchFixture(query: string) {
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

export function getRoutinesFixture() {
  return copy({
    progress: { done: 3, total: 7 },
    groups: [
      { title: 'Mañana', items: [{ id: 'beds', title: 'Ventilar dormitorios', done: true }, { id: 'bathrooms', title: 'Repaso de baños', done: true }, { id: 'laundry', title: 'Lavadora clara', done: true }] },
      { title: 'Tarde', items: [{ id: 'kitchen', title: 'Recoger cocina', done: false }, { id: 'uniform', title: 'Preparar uniforme', done: false }] },
      { title: 'Semanal', items: [{ id: 'sheets', title: 'Cambiar sábanas', done: false }, { id: 'plants', title: 'Regar plantas', done: false }] }
    ]
  });
}

export function getCalendarFixture() {
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

export function getContactsFixture() {
  return copy({ contacts: CONTACTS });
}

export function getEmergencyFixture() {
  return copy({
    updatedLabel: 'Snapshot actualizado hoy · disponible sin conexión',
    contacts: CONTACTS.filter((contact) => contact.featured),
    instructions: [
      { title: 'Emergencia vital', body: 'Llama al 112. Indica la dirección y no cuelgues hasta que te lo pidan.' },
      { title: 'Corte de agua', body: 'La llave general está bajo el fregadero, marcada en azul.' },
      { title: 'Humo o fuego', body: 'Sal de casa, cierra la puerta si es seguro y llama al 112 desde fuera.' }
    ]
  });
}

export function getSettingsFixture() {
  return copy({
    household: HOUSEHOLD,
    members: DEMO_USERS.map(({ id, name, initials, role }) => ({ id, name, initials, role })),
    preferences: { locale: 'Español (España)', timeZone: 'Europe/Madrid', weekStarts: 'Lunes' }
  });
}
