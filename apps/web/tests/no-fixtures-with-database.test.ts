import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isHttpError } from '@sveltejs/kit';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * La regla, comprobada: CON BASE DE DATOS CONFIGURADA, LAS MAQUETAS NO EXISTEN.
 *
 * Esta batería es la red de seguridad del §R2 de la auditoría. El fallo que
 * previene no es teórico: con el fallback antiguo, un corte de la base hacía
 * que la pantalla de Emergencias del hogar real enseñara «Centro Pediátrico
 * Olmo · 910 000 111» y «la llave general está bajo el fregadero» como si
 * fueran los de esta casa, sin ningún aviso.
 *
 * No necesita Postgres. El pool es falso y su `connect()` rechaza: eso es
 * exactamente una base configurada que no responde, que es el escenario
 * peligroso. Lo que se comprueba de cada `load` es doble:
 *
 * 1. Que NO devuelve nada del corpus de demostración (se busca por contenido,
 *    no por forma: cualquier fixture nueva que se cuele también cae).
 * 2. Que el fallo sale como 503 honesto, no como un hogar vacío.
 */

const { fakeEnv } = vi.hoisted(() => ({ fakeEnv: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));

/**
 * Las DOS formas de que una lectura real no dé nada, que son las dos que el
 * fallback antiguo confundía con «aquí no hay hogar, pon la maqueta»:
 *
 * - `down`:  la base no responde (pooler saturado, proyecto en pausa, red).
 * - `empty`: la base responde pero la membresía no está viva, así que RLS no
 *            deja ver nada. El cargador devuelve null legítimamente y es la
 *            página la que tiene que resistirse a rellenar el hueco.
 */
const { state } = vi.hoisted(() => ({ state: { pool: 'down' as 'down' | 'empty' } }));

const { pool } = vi.hoisted(() => {
  const refused = () => Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  return {
    pool: {
      connect: () =>
        state.pool === 'down'
          ? Promise.reject(refused())
          : Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => undefined }),
      query: () => (state.pool === 'down' ? Promise.reject(refused()) : Promise.resolve({ rows: [] }))
    }
  };
});
vi.mock('$lib/server/db.server', () => ({ getDatabasePool: () => (fakeEnv.DATABASE_URL ? pool : null) }));

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const USER = {
  id: 'fixture:roble:employee',
  membershipId: '11000000-0000-4000-8000-000000000003',
  name: 'Ana',
  initials: 'AN',
  email: 'ana@example.test',
  role: 'employee_live_in' as const,
  householdIds: [HOUSEHOLD]
};

/**
 * Textos que SOLO existen en el corpus de demostración. Si uno de ellos
 * aparece en lo que devuelve un `load` con base configurada, la aplicación
 * está inventando datos de la casa y esta batería tiene que caerse.
 */
const FIXTURE_MARKERS = [
  'Centro Pediátrico Olmo',
  '910 000 111',
  'bajo el fregadero',
  'Leo · sin lácteos',
  'Lentejas con verduras',
  'Carmen · 2.º B',
  'Colegio Las Encinas',
  'Familia Roble',
  'alberto.admin@hogar.demo'
];

function fixtureLeak(value: unknown): string | null {
  const serialized = JSON.stringify(value ?? null);
  return FIXTURE_MARKERS.find((marker) => serialized.includes(marker)) ?? null;
}

interface LoadCase {
  /** Ruta relativa del módulo, tal cual vive en el árbol. */
  module: string;
  /** Parámetros de ruta más allá de householdId. */
  params?: Record<string, string>;
  /** Cadena de consulta con la que se ejerce el `load`. */
  search?: string;
}

const CASES: LoadCase[] = [
  { module: '../src/routes/h/[householdId]/today/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/emergency/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/contacts/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/calendar/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/menu/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/recipes/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/routines/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/employment/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/employment/vacaciones/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/wiki/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/wiki/[slug]/+page.server.ts', params: { slug: 'lavadora-programa-corto' } },
  { module: '../src/routes/h/[householdId]/search/+page.server.ts', search: '?q=lavadora' },
  { module: '../src/routes/h/[householdId]/settings/+page.server.ts' },
  // Finanzas (fase 4/6): el Dashboard y Movimientos no se registraron al
  // cerrar la fase 4 (comprobado: no estaban en esta lista); esta tarea los
  // añade junto con Analítica, que sí es de esta fase.
  { module: '../src/routes/h/[householdId]/finanzas/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/finanzas/movimientos/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/finanzas/analitica/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/finanzas/eventos/+page.server.ts' },
  { module: '../src/routes/h/[householdId]/finanzas/importar/+page.server.ts' }
];

type LoadFn = (event: Record<string, unknown>) => unknown;

/** Cabeceras que el `load` pidió poner; Emergencias marca `no-store`. */
let headers: Record<string, string> = {};

async function runLoad({ module, params = {}, search = '' }: LoadCase): Promise<unknown> {
  const loaded = (await import(/* @vite-ignore */ module)) as { load: LoadFn };
  return loaded.load({
    locals: { user: USER, session: null, syntheticOnly: false, dataUnavailable: false },
    params: { householdId: HOUSEHOLD, ...params },
    url: new URL(`https://casa.test/h/${HOUSEHOLD}/x${search}`),
    depends: () => undefined,
    setHeaders: (added: Record<string, string>) => Object.assign(headers, added),
    request: new Request(`https://casa.test/h/${HOUSEHOLD}/x${search}`)
  });
}

// El entorno falso es un objeto VIVO y `databaseConfigured()` lo consulta en
// cada llamada, así que cambiar de escenario no exige reimportar los módulos.
// Conviene que no haga falta: la rama de Ajustes arrastra `better-auth` entera
// y son tres segundos, suficientes para volver inestable la batería en una
// máquina cargada. Por eso además se importa todo ANTES de medir nada.
beforeAll(async () => {
  for (const testCase of CASES) await import(/* @vite-ignore */ testCase.module);
}, 60_000);

beforeEach(() => {
  for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
  headers = {};
});

describe.each([
  ['la base no responde', 'down' as const],
  ['la lectura real no devuelve nada', 'empty' as const]
])('con DATABASE_URL configurada y %s, ninguna pantalla sirve la maqueta', (_label, mode) => {
  beforeEach(() => {
    fakeEnv.DATABASE_URL = 'postgresql://casa_clara_app@127.0.0.1:5432/housekeeper';
    state.pool = mode;
  });

  for (const testCase of CASES) {
    const name = testCase.module.replace('../src/routes/h/[householdId]/', '').replace('/+page.server.ts', '');

    it(`«${name}» no inventa datos de la casa`, async () => {
      let result: unknown;
      let thrown: unknown;
      try {
        result = await runLoad(testCase);
      } catch (cause) {
        thrown = cause;
      }

      if (thrown !== undefined) {
        // Un fallo tiene que salir como error HTTP honesto (503 «no podemos
        // leer», 404 «no está»), no como un 500 crudo ni —sobre todo— como una
        // casa inventada.
        expect(isHttpError(thrown), `«${name}» lanzó algo que no es un error HTTP: ${String(thrown)}`).toBe(true);
        expect([404, 503]).toContain((thrown as { status: number }).status);
        return;
      }

      const leak = fixtureLeak(result);
      expect(leak, `«${name}» devolvió datos de la maqueta: ${leak}`).toBeNull();
    });
  }
});

describe('con DATABASE_URL configurada, Emergencias', () => {
  beforeEach(() => {
    fakeEnv.DATABASE_URL = 'postgresql://casa_clara_app@127.0.0.1:5432/housekeeper';
    state.pool = 'down';
  });

  it('se sigue pintando, dice que no puede leer y no trae teléfonos', async () => {
    const data = (await runLoad({ module: '../src/routes/h/[householdId]/emergency/+page.server.ts' })) as {
      live: unknown;
      emergency: unknown;
      unreadable: boolean;
    };
    // No lanza: es la única pantalla que no puede caerse, porque alguien puede
    // estar buscando a quién llamar ahora mismo.
    expect(data.unreadable).toBe(true);
    expect(data.live).toBeNull();
    expect(data.emergency).toBeNull();
    // Y esta respuesta no puede sustituir en la caché del service worker a la
    // última que sí traía los teléfonos del hogar.
    expect(headers['cache-control']).toContain('no-store');
  });
});

describe('sin DATABASE_URL la demostración sigue entera', () => {
  it('Hoy y Emergencias sirven su maqueta cuando no hay hogar real detrás', async () => {
    const today = (await runLoad({ module: '../src/routes/h/[householdId]/today/+page.server.ts' })) as {
      today: unknown;
    };
    expect(today.today).not.toBeNull();

    const emergency = (await runLoad({ module: '../src/routes/h/[householdId]/emergency/+page.server.ts' })) as {
      emergency: { contacts: unknown[] } | null;
      unreadable: boolean;
    };
    expect(emergency.unreadable).toBe(false);
    expect(emergency.emergency?.contacts.length).toBeGreaterThan(0);
  });
});

describe('las maquetas no se pueden ni construir con base configurada', () => {
  it('cada constructor de maqueta lanza con DATABASE_URL y devuelve datos sin ella', async () => {
    const modulePath = '../src/lib/server/fixtures.server';

    fakeEnv.DATABASE_URL = 'postgresql://casa_clara_app@127.0.0.1:5432/housekeeper';
    const guarded = (await import(modulePath)) as Record<string, unknown>;
    const builders = Object.keys(guarded).filter((name) => /^get.+Fixture$/.test(name));
    // Si alguien añade una maqueta nueva, entra sola en esta comprobación.
    expect(builders.length).toBeGreaterThanOrEqual(11);
    for (const name of builders) {
      expect(() => (guarded[name] as (query: string) => unknown)(''), name).toThrowError(/maqueta/);
    }

    // Mismo módulo, sin reimportar: la guarda mira el entorno en cada llamada,
    // que es como se comporta en producción.
    delete fakeEnv.DATABASE_URL;
    for (const name of builders) {
      expect((guarded[name] as (query: string) => unknown)(''), name).toBeTruthy();
    }
  });

  it('el snapshot crítico sin lectura real lleva el 112 y nada más', async () => {
    fakeEnv.DATABASE_URL = 'postgresql://casa_clara_app@127.0.0.1:5432/housekeeper';
    const { getCriticalSnapshotPayload } = await import('../src/lib/server/fixtures.server');
    const payload = getCriticalSnapshotPayload(null, null);
    expect(payload.contacts).toEqual([
      { id: 'emergency-112', name: 'Emergencias', phone: '112', kind: 'emergency' }
    ]);
    expect(payload.emergency).toEqual([]);
    expect(payload.dietaryFlags).toEqual([]);
    expect(payload.wikiPages).toEqual([]);
    expect(fixtureLeak(payload)).toBeNull();
  });
});

describe('el paquete offline guardado se lee diciendo qué es y de cuándo', () => {
  it('solo el contenido real vale como datos de la casa', async () => {
    const { isSavedHouseholdData, savedAtLabel, snapshotProvenance } = await import('../src/lib/offline/saved');

    expect(snapshotProvenance({ version: 'live-abc123' })).toBe('live');
    expect(snapshotProvenance({ version: 'partial-abc123' })).toBe('partial');
    expect(snapshotProvenance({ version: 'fixture-abc123' })).toBe('fixture');
    expect(snapshotProvenance({ version: 'raro' })).toBe('unknown');

    expect(isSavedHouseholdData({ version: 'live-abc123' })).toBe(true);
    // Un paquete de demostración guardado en este mismo navegador jamás se
    // enseña como si fuera esta casa; uno parcial no trae nada que enseñar.
    expect(isSavedHouseholdData({ version: 'fixture-abc123' })).toBe(false);
    expect(isSavedHouseholdData({ version: 'partial-abc123' })).toBe(false);
    expect(isSavedHouseholdData(null)).toBe(false);

    // Y cuando se usa, se dice desde cuándo.
    expect(savedAtLabel('2026-08-09T19:14:00.000Z')).toContain('9 de agosto');
    expect(savedAtLabel('no es una fecha')).toBe('Guardados en este dispositivo');
  });
});

describe('el corpus de demostración no se cita fuera de su guarda', () => {
  it('ningún +page.server.ts del hogar llama a una maqueta sin pasar por la regla', async () => {
    const routes = fileURLToPath(new URL('../src/routes/h/[householdId]/', import.meta.url));

    async function walk(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...(await walk(full)));
        else if (entry.name.endsWith('.server.ts')) found.push(full);
      }
      return found;
    }

    const offenders: string[] = [];
    for (const file of await walk(routes)) {
      const source = await readFile(file, 'utf8');
      if (!/get[A-Za-z]+Fixture\s*\(/.test(source)) continue;
      // La cita es legítima si el fichero declara la regla: o construye la
      // maqueta dentro de `demoOrUnavailable`, o pregunta por `fixturesAllowed`.
      if (/demoOrUnavailable|fixturesAllowed/.test(source)) continue;
      offenders.push(path.relative(routes, file));
    }
    expect(offenders, 'maquetas citadas sin la guarda de data-source.server').toEqual([]);
  });
});
