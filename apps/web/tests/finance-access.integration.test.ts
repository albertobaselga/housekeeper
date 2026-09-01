import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { financeAccessGranted, loadFinanceGrantOverview } from '../src/lib/server/finance-access.server';
import { loadFinanceStatus } from '../src/lib/server/finance-status.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Comportamiento CON base configurada (producción): fixturesAllowed() = false.
// El objeto es VIVO porque `databaseConfigured()` lo consulta en cada llamada:
// la última prueba de abajo quita la DATABASE_URL para afirmar la rama de
// maqueta y la repone, sin reimportar nada.
const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: { DATABASE_URL: 'postgres://prueba/afirmada' } as Record<string, string | undefined>
}));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));

// La base y el rol de login son recursos del CLÚSTER, no del proceso: con
// nombres fijos, dos ejecuciones simultáneas (dos carriles de CI, o alguien
// en local mientras corre CI) se borraban la base la una a la otra a mitad.
// El pid las separa y el `afterAll` las retira en vez de acumularlas.
const RUN = process.pid;
const APP_LOGIN = `it_casa_clara_finance_login_${RUN}`;
// Base propia (patrón de la suite de contactos): las suites vecinas recrean
// el esquema en paralelo y ninguna puede compartir instancia.
const FINANCE_DB = `casaclara_finance_it_${RUN}`;

const OLIVO_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const ROBLE_ADMIN = '11000000-0000-4000-8000-000000000001';
const OLIVO_ADMIN = '21000000-0000-4000-8000-000000000001';
// Segunda administración del roble: NO está en las fixtures compartidas (que
// las usa media suite) sino que la crea aquí la única prueba que la necesita,
// en la base propia de este fichero. Sin dos administraciones no hay forma de
// afirmar que `isSelf` distingue a quien mira de quien no.
const ROBLE_ADMIN_2 = '11000000-0000-4000-8000-000000000007';
const SECOND_ADMIN_USER = { id: 'fixture:roble:admin2' };
const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const OLIVO_ADMIN_USER = { id: 'fixture:olivo:admin' };

function financeUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${FINANCE_DB}`;
  return url.toString();
}

/**
 * Lo que pasa cuando NO se puede preguntar. Vive fuera del `runIf` a propósito:
 * el bloque de abajo entero se salta en el carril sin base, y la degradación es
 * justo lo que no puede quedarse sin defensa. Invertir el `catch` —que ante una
 * avería se conceda en vez de retirarse— abriría Finanzas de par en par a
 * cualquier administración el día que la base tosiera, y hasta ahora eso pasaba
 * en verde.
 *
 * Ninguna de las tres necesita Postgres: una no tiene pool, otra apunta a un
 * puerto muerto y la tercera usa un pool de mentira que no devuelve membresía.
 */
describe('sin poder preguntar por la concesión, Finanzas se retira', () => {
  /**
   * Llama al ayudante y recoge, además de la respuesta, lo que escribió en el
   * registro: la diferencia entre «no te toca» (silencio: es una respuesta
   * legítima) y «no hemos podido leer» (una línea con su código) es parte del
   * comportamiento, no un detalle de implementación.
   */
  async function ask(pool: pg.Pool | null): Promise<{ granted: boolean; logs: string[] }> {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const granted = await financeAccessGranted(ADMIN_USER, FIXTURE_HOUSEHOLD, pool);
      const logs = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes('"scope":"web:finance-access"'));
      return { granted, logs };
    } finally {
      stderr.mockRestore();
    }
  }

  it('sin pool y con base configurada: false, y no es avería que registrar', async () => {
    const { granted, logs } = await ask(null);
    expect(granted).toBe(false);
    expect(logs).toEqual([]);
  });

  it('con la base caída: false, y queda registrado con su código', async () => {
    // Puerto 1: reservado y sin nadie escuchando, así que la conexión se
    // rechaza en el acto. Nunca el 5439 (la base de trabajo) ni el 54329.
    const dead = new pg.Pool({
      connectionString: 'postgresql://nadie:nada@127.0.0.1:1/casaclara_no_existe',
      connectionTimeoutMillis: 2_000
    });
    try {
      const { granted, logs } = await ask(dead);
      expect(granted).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('finance access check unavailable');
    } finally {
      await dead.end();
    }
  });

  it('sin membresía viva: false en silencio, que no es lo mismo que una avería', async () => {
    // Pool de mentira que responde sin filas: es lo que ve
    // `withAuthorizedTransaction` cuando la membresía no existe, está revocada
    // o ha caducado, y lo que lanza su AuthorizationError.
    const rowless = {
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined })
    } as unknown as pg.Pool;
    const { granted, logs } = await ask(rowless);
    expect(granted).toBe(false);
    expect(logs).toEqual([]);
  });

  it('sin base de datos (demo por fixtures) el módulo sí se enseña', async () => {
    // La otra mitad de la decisión, congelada aquí para que no se caiga sola:
    // sin DATABASE_URL no hay hogar real, ni concesiones, ni movimientos —y no
    // hay nadie dentro salvo en el paquete sintético—, así que la maqueta
    // enseña Finanzas como enseña el resto. Las suites e2e y a11y cuentan con
    // esto (plan de la fase, aviso a la Task 10).
    delete fakeEnv.DATABASE_URL;
    try {
      const { granted } = await ask(null);
      expect(granted).toBe(true);
    } finally {
      fakeEnv.DATABASE_URL = 'postgres://prueba/afirmada';
    }
  });
});

describe.runIf(Boolean(adminUrl))('doble cerrojo de Finanzas leído por el layout', () => {
  let appPool: pg.Pool;

  /**
   * Preparar el escenario de una prueba con el propietario de las migraciones,
   * fuera de la RLS. Es la misma vía por la que entran las fixtures del
   * `beforeAll`, y solo toca la base propia de este fichero: nunca es el camino
   * que se está probando, que siempre pasa por `appPool` (el login de la
   * aplicación, sin BYPASSRLS).
   */
  async function asOwner(work: (client: pg.Client) => Promise<void>): Promise<void> {
    const owner = new pg.Client({ connectionString: financeUrlFor(adminUrl as string) });
    await owner.connect();
    try {
      await work(owner);
    } finally {
      await owner.end();
    }
  }

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${FINANCE_DB} with (force)`);
      await cluster.query(`create database ${FINANCE_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: financeUrlFor(adminUrl as string) });
    await admin.connect();
    try {
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(financeUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    // Se retiran los dos recursos del clúster que creó el beforeAll. Sin esto
    // quedaría una base y un rol por ejecución, que es justo lo que ya duele
    // en este clúster compartido.
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${FINANCE_DB} with (force)`);
      await cluster.query(`drop role if exists ${APP_LOGIN}`);
    } finally {
      await cluster.end();
    }
    // El mismo presupuesto que el `beforeAll`, y por la misma razón. `drop
    // database … with (force)` espera a que el clúster le deje: con la suite
    // entera en paralelo hay una decena de ficheros creando y borrando su
    // propia base a la vez, y esa espera no es gradual sino un bloqueo hasta
    // que la de al lado termina. Medido en tres pasadas de la suite completa
    // sobre este clúster: 193 ms, 19,2 s y 32,6 s — conectar y soltar el rol
    // fueron siempre ~4 ms, así que el único que espera es el `drop database`.
    // Con 30 s, la suite entera se caía en verde por el teardown en dos de cada
    // tres pasadas: 729 pruebas pasadas y el fichero en rojo.
  }, 120_000);

  it('true SOLO para la administración con concesión viva; false para el resto', async () => {
    expect(await financeAccessGranted(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(true);
    expect(await financeAccessGranted(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    expect(await financeAccessGranted(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    // Admin de un hogar CON datos de finanzas pero SIN concesión: false.
    expect(await financeAccessGranted(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, appPool)).toBe(false);
  });

  it('falla cerrado: sin membresía en el hogar la respuesta es false', async () => {
    expect(await financeAccessGranted({ id: 'fixture:olivo:admin' }, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    expect(await financeAccessGranted({ id: 'nadie:desconocido' }, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
  });

  it('loadFinanceStatus cuenta bajo RLS lo que ve ESTA membresía', async () => {
    // Admin con concesión: los datos sintéticos del roble (002_finance.sql).
    expect(await loadFinanceStatus(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool)).toEqual({
      accountCount: 2,
      transactionCount: 2
    });
    // Admin del olivo sin concesión: el cerrojo devuelve ceros, no un error.
    expect(await loadFinanceStatus(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, appPool)).toEqual({
      accountCount: 0,
      transactionCount: 0
    });
    // Sin membresía en el hogar: null (la página lo traduce a 403/404).
    expect(await loadFinanceStatus({ id: 'nadie:desconocido' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });

  it('loadFinanceGrantOverview lista los admins con su estado; null para el resto', async () => {
    const overview = await loadFinanceGrantOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    // El roble tiene seis membresías vivas y UNA sola de administración: la
    // tarjeta no ofrece Finanzas a quien la base no dejaría recibirla.
    expect(overview?.admins).toEqual([
      {
        membershipId: ROBLE_ADMIN,
        name: 'Fixture Admin Roble',
        granted: true,
        isSelf: true
      }
    ]);
    expect(await loadFinanceGrantOverview(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
    expect(await loadFinanceGrantOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });

  it('`granted` sale de la concesión REAL, no de tener papel de administración', async () => {
    // La misma consulta en el hogar del olivo, cuya administración no tiene
    // concesión: si `granted` se degradara a «es admin» —o a una constante—,
    // la tarjeta diría «Activado» a quien el layout deja fuera del módulo.
    const overview = await loadFinanceGrantOverview(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, appPool);
    expect(overview?.admins).toEqual([
      {
        membershipId: OLIVO_ADMIN,
        name: 'Fixture Admin Olivo',
        granted: false,
        isSelf: true
      }
    ]);
  });

  it('con dos administraciones, cada una se reconoce a sí misma y ve el estado de la otra', async () => {
    await asOwner(async (client) => {
      await client.query(
        `insert into app.user_profiles (user_id, display_name)
         values ('fixture:roble:admin2', 'Fixture Segunda Admin Roble')`
      );
      await client.query(
        `insert into app.household_memberships (id, household_id, user_id, role)
         values ($1, $2, 'fixture:roble:admin2', 'family_admin')`,
        [ROBLE_ADMIN_2, FIXTURE_HOUSEHOLD]
      );
    });

    // Quien mira es la administración CON concesión: se ve a sí misma activada
    // y a la recién llegada apagada, en el orden estable del alta.
    expect((await loadFinanceGrantOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool))?.admins).toEqual([
      { membershipId: ROBLE_ADMIN, name: 'Fixture Admin Roble', granted: true, isSelf: true },
      { membershipId: ROBLE_ADMIN_2, name: 'Fixture Segunda Admin Roble', granted: false, isSelf: false }
    ]);

    // Y la misma lista mirada por la otra: `isSelf` cambia de fila, `granted`
    // no. Una `isSelf` fija (siempre true, o siempre la primera fila) pondría
    // el aviso de «vas a quitártelo a ti» en la persona equivocada.
    const theirs = await loadFinanceGrantOverview(SECOND_ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(theirs?.admins.map((admin) => [admin.membershipId, admin.granted, admin.isSelf])).toEqual([
      [ROBLE_ADMIN, true, false],
      [ROBLE_ADMIN_2, false, true]
    ]);
  });

  it('una concesión REVOCADA no cuenta: la fila vuelve a decir que está apagada', async () => {
    // Revocar no borra la fila, le pone `revoked_at` (el histórico se conserva,
    // migración 0034: la tabla no tiene DELETE). Así que el primer refresco tras
    // CUALQUIER desactivación pasa por aquí, y si la lectura no descartara las
    // concesiones muertas la tarjeta diría «Activado» a una cuenta a la que el
    // layout ya le ha retirado el módulo. No es un caso raro: es el camino
    // normal del botón «Desactivar Finanzas».
    await asOwner(async (client) => {
      await client.query(
        `insert into app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
         values ($1, $2, $3)`,
        [FIXTURE_HOUSEHOLD, ROBLE_ADMIN_2, ROBLE_ADMIN]
      );
    });
    const granted = await loadFinanceGrantOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(granted?.admins.map((admin) => [admin.membershipId, admin.granted])).toEqual([
      [ROBLE_ADMIN, true],
      [ROBLE_ADMIN_2, true]
    ]);

    await asOwner(async (client) => {
      // Exactamente lo que escribe `revokeFinance` (commands/finance.ts): fecha
      // y autoría, sin borrar la fila.
      await client.query(
        `update app.finance_module_grants
            set revoked_at = statement_timestamp(), revoked_by_membership_id = $3
          where household_id = $1 and membership_id = $2 and revoked_at is null`,
        [FIXTURE_HOUSEHOLD, ROBLE_ADMIN_2, ROBLE_ADMIN]
      );
    });
    const revoked = await loadFinanceGrantOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(revoked?.admins.map((admin) => [admin.membershipId, admin.granted])).toEqual([
      [ROBLE_ADMIN, true],
      [ROBLE_ADMIN_2, false]
    ]);
  });

  it('una administración con el acceso retirado deja de aparecer en la tarjeta', async () => {
    await asOwner(async (client) => {
      await client.query('update app.household_memberships set revoked_at = statement_timestamp() where id = $1', [
        ROBLE_ADMIN_2
      ]);
    });
    // Ofrecerle Finanzas a quien ya no puede entrar en la casa sería ofrecer
    // una llave de una puerta que no existe: el comando la rechazaría
    // (membership_not_found) y la tarjeta habría mentido antes de intentarlo.
    const overview = await loadFinanceGrantOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview?.admins.map((admin) => admin.membershipId)).toEqual([ROBLE_ADMIN]);
  });
});
