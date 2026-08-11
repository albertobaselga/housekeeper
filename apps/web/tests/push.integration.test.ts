import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { forgetOwnDevice, listOwnDevices, saveOwnDevice } from '../src/lib/server/push.server';

/**
 * Los dispositivos de cada quien, desde la aplicación y bajo RLS de verdad.
 *
 * Lo que se comprueba aquí no es la consulta: es que **no existe ningún camino
 * por el que una persona alcance el canal de otra**, ni para verlo, ni para
 * apagarlo, ni para encendérselo. La suite 170 de `packages/db` lo pina en la
 * base; esta lo pina a través del código que de verdad se ejecuta cuando alguien
 * toca el interruptor, que es donde se colaría el descuido.
 */

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_push_login';
// Base propia: las demás suites recrean el esquema entero en paralelo.
const PUSH_DB = 'casaclara_push_it';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };

const ADMIN_ENDPOINT = 'https://push.ejemplo.test/el-de-quien-administra';
const EMPLOYEE_ENDPOINT = 'https://push.ejemplo.test/el-de-la-empleada';

function pushUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${PUSH_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('avisos por dispositivo desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${PUSH_DB} with (force)`);
      await cluster.query(`create database ${PUSH_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: pushUrlFor(adminUrl as string) });
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

    const url = new URL(pushUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('cada quien guarda y ve su propio dispositivo, y ninguno más', async () => {
    expect(
      await saveOwnDevice(
        ADMIN_USER,
        { endpoint: ADMIN_ENDPOINT, p256dh: 'pub-admin', auth: 'auth-admin', deviceLabel: 'El de la cocina' },
        appPool
      )
    ).toBe(true);
    expect(
      await saveOwnDevice(
        EMPLOYEE_USER,
        { endpoint: EMPLOYEE_ENDPOINT, p256dh: 'pub-empleada', auth: 'auth-empleada', deviceLabel: null },
        appPool
      )
    ).toBe(true);

    const adminDevices = await listOwnDevices(ADMIN_USER, appPool);
    expect(adminDevices.map((device) => device.endpoint)).toEqual([ADMIN_ENDPOINT]);
    expect(adminDevices[0]?.deviceLabel).toBe('El de la cocina');

    // Quien administra el hogar NO ve el canal de la empleada. No es un filtro
    // de esta consulta: es que la RLS no le enseña la fila. Saber si tiene los
    // avisos encendidos —y cuándo recibió el último— sería un detector de si
    // mira el teléfono en su tiempo libre, en una casa donde ese tiempo libre
    // transcurre en el mismo edificio que el trabajo.
    expect(adminDevices.some((device) => device.endpoint === EMPLOYEE_ENDPOINT)).toBe(false);

    // Y la simetría, que es lo que hace defendible la regla: ella tampoco ve el
    // de quien administra.
    const employeeDevices = await listOwnDevices(EMPLOYEE_USER, appPool);
    expect(employeeDevices.map((device) => device.endpoint)).toEqual([EMPLOYEE_ENDPOINT]);
  });

  it('nadie puede apagarle los avisos a otra persona', async () => {
    // La operación no falla: sencillamente no encuentra ninguna fila que borrar,
    // porque para quien administra esa fila no existe.
    expect(await forgetOwnDevice(ADMIN_USER, EMPLOYEE_ENDPOINT, appPool)).toBe(true);
    expect((await listOwnDevices(EMPLOYEE_USER, appPool)).map((d) => d.endpoint)).toEqual([
      EMPLOYEE_ENDPOINT
    ]);
  });

  it('volver a suscribir el mismo aparato actualiza sus claves en vez de duplicarlo', async () => {
    await saveOwnDevice(
      EMPLOYEE_USER,
      { endpoint: EMPLOYEE_ENDPOINT, p256dh: 'pub-nueva', auth: 'auth-nueva', deviceLabel: null },
      appPool
    );
    const devices = await listOwnDevices(EMPLOYEE_USER, appPool);
    expect(devices).toHaveLength(1);

    // Y revive un dispositivo que el servicio de push había dado por muerto: sin
    // esto, «volver a encenderlos» dejaría de funcionar en cuanto el navegador
    // hubiera limpiado los datos del sitio una vez.
    const admin = new pg.Client({ connectionString: pushUrlFor(adminUrl as string) });
    await admin.connect();
    try {
      await admin.query(
        'update app.push_subscriptions set revoked_at = now(), failure_count = 7 where endpoint = $1',
        [EMPLOYEE_ENDPOINT]
      );
    } finally {
      await admin.end();
    }
    expect(await listOwnDevices(EMPLOYEE_USER, appPool)).toHaveLength(0);

    await saveOwnDevice(
      EMPLOYEE_USER,
      { endpoint: EMPLOYEE_ENDPOINT, p256dh: 'pub-revivida', auth: 'auth-revivida', deviceLabel: null },
      appPool
    );
    const revived = await listOwnDevices(EMPLOYEE_USER, appPool);
    expect(revived).toHaveLength(1);
    expect(revived[0]?.failureCount).toBe(0);
  });

  it('apagar los suyos los apaga de verdad, y sin dejar constancia de cuándo', async () => {
    expect(await forgetOwnDevice(EMPLOYEE_USER, EMPLOYEE_ENDPOINT, appPool)).toBe(true);
    expect(await listOwnDevices(EMPLOYEE_USER, appPool)).toEqual([]);

    // Se borra la fila, no se marca revocada: apagar los avisos es una decisión
    // de la persona, no una avería, y no tiene por qué dejar rastro de cuándo la
    // tomó. `revoked_at` es para el endpoint que el servicio de push dio por
    // muerto, donde la fecha es lo único que explica el silencio.
    const admin = new pg.Client({ connectionString: pushUrlFor(adminUrl as string) });
    await admin.connect();
    try {
      const rows = await admin.query('select count(*)::int as total from app.push_subscriptions where endpoint = $1', [
        EMPLOYEE_ENDPOINT
      ]);
      expect(rows.rows[0]?.total).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
