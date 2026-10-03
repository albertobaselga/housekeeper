import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCouponsPageData, loadCoupons } from '../src/lib/server/coupons.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Esta suite afirma el comportamiento CON base configurada, que es el de
// producción: declararla aquí es parte de la prueba (patrón de contactos).
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgres://prueba/afirmada' } }));
const APP_LOGIN = 'it_housekeeper_coupons_login';
// Base de datos propia: las otras suites recrean el esquema entero en paralelo
// y ninguna puede compartir instancia.
const COUPONS_DB = 'hk_coupons_web_it';

const OLIVO_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const ADMIN = '11000000-0000-4000-8000-000000000001';
const FAMILY = '11000000-0000-4000-8000-000000000002';
const OLIVO_ADMIN = '21000000-0000-4000-8000-000000000001';

// Prefijo `ca…` para lo de esta suite (cupones `ca0…`, fotos `ca1…`, usos `ca2…`).
const PHOTO_ADMIN = 'ca100000-0000-4000-8000-000000000001';
const PHOTO_FAMILY = 'ca100000-0000-4000-8000-000000000002';
const PHOTO_OLIVO = 'ca100000-0000-4000-8000-000000000003';
const SOON = 'ca000000-0000-4000-8000-000000000001';
const MULTI = 'ca000000-0000-4000-8000-000000000002';
const UNLIMITED = 'ca000000-0000-4000-8000-000000000003';
const USED = 'ca000000-0000-4000-8000-000000000004';
const EXPIRED = 'ca000000-0000-4000-8000-000000000005';
const DISCARDED = 'ca000000-0000-4000-8000-000000000006';
const OLIVO_COUPON = 'ca000000-0000-4000-8000-000000000099';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };
const OLIVO_ADMIN_USER = { id: 'fixture:olivo:admin' };

// Las 10:00 UTC del sábado 3 de octubre de 2026: en Madrid, el mismo día.
const NOW = new Date('2026-10-03T10:00:00Z');

function couponsUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${COUPONS_DB}`;
  return url.toString();
}

/**
 * Siembra como propietario (sin contexto de hogar): así escribe una siembra, y
 * los disparadores de la 0039 la dejan pasar a propósito. Todo es inventado.
 */
const COUPONS_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.storage_objects (id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id) VALUES
  ('${PHOTO_ADMIN}', '${FIXTURE_HOUSEHOLD}', 'it-coupons', 'roble/cupon-admin.jpg', 'image/jpeg', 1000, repeat('c', 64), '${ADMIN}'),
  ('${PHOTO_FAMILY}', '${FIXTURE_HOUSEHOLD}', 'it-coupons', 'roble/cupon-familia.jpg', 'image/jpeg', 1000, repeat('d', 64), '${FAMILY}'),
  ('${PHOTO_OLIVO}', '${OLIVO_HOUSEHOLD}', 'it-coupons', 'olivo/cupon.jpg', 'image/jpeg', 1000, repeat('e', 64), '${OLIVO_ADMIN}');

INSERT INTO app.coupons (household_id, id, merchant, offer, code, expires_on, max_uses, notes, photo_storage_object_id, created_by_membership_id, created_at, discarded_at, discarded_by_membership_id) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${SOON}', 'Frutería Lola', '2 × 1 en naranjas', 'NARANJA2X1', '2026-10-05', 1, NULL, '${PHOTO_ADMIN}', '${ADMIN}', '2026-09-20T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', '${MULTI}', 'Droguería Sol', '10 % de descuento', NULL, '2026-12-31', 5, 'En la caja del fondo', '${PHOTO_FAMILY}', '${FAMILY}', '2026-09-21T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', '${UNLIMITED}', 'Panadería Ñandú', 'Café gratis con la barra', NULL, NULL, NULL, NULL, '${PHOTO_ADMIN}', '${ADMIN}', '2026-09-22T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', '${USED}', 'Zapatería', '5 € en la segunda compra', NULL, NULL, 1, NULL, '${PHOTO_ADMIN}', '${ADMIN}', '2026-09-23T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', '${EXPIRED}', 'Óptica', 'Revisión gratis', NULL, '2026-09-01', 1, NULL, '${PHOTO_ADMIN}', '${ADMIN}', '2026-08-01T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', '${DISCARDED}', 'droguería sol', 'Muestra', NULL, NULL, 1, NULL, '${PHOTO_ADMIN}', '${ADMIN}', '2026-08-02T10:00:00Z', '2026-10-01T09:00:00Z', '${FAMILY}'),
  ('${OLIVO_HOUSEHOLD}', '${OLIVO_COUPON}', 'Ferretería Olivo', '3 € de descuento', NULL, NULL, 1, NULL, '${PHOTO_OLIVO}', '${OLIVO_ADMIN}', '2026-09-20T10:00:00Z', NULL, NULL);

INSERT INTO app.coupon_uses (household_id, id, coupon_id, used_on, used_by_membership_id, recorded_at, voided_at, voided_by_membership_id) VALUES
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000001', '${MULTI}', '2026-09-25', '${ADMIN}', '2026-09-25T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000002', '${MULTI}', '2026-10-01', '${FAMILY}', '2026-10-01T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000003', '${MULTI}', '2026-10-02', '${ADMIN}', '2026-10-02T10:00:00Z', '2026-10-02T10:05:00Z', '${ADMIN}'),
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000004', '${UNLIMITED}', '2026-09-26', '${ADMIN}', '2026-09-26T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000005', '${UNLIMITED}', '2026-09-27', '${ADMIN}', '2026-09-27T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000006', '${UNLIMITED}', '2026-09-28', '${FAMILY}', '2026-09-28T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000007', '${UNLIMITED}', '2026-09-29', '${FAMILY}', '2026-09-29T10:00:00Z', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', 'ca200000-0000-4000-8000-000000000008', '${USED}', '2026-09-30', '${FAMILY}', '2026-09-30T10:00:00Z', NULL, NULL);

COMMIT;
`;

describe.runIf(Boolean(adminUrl))('cargador de cupones desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${COUPONS_DB} with (force)`);
      await cluster.query(`create database ${COUPONS_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: couponsUrlFor(adminUrl as string) });
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
      await admin.query(COUPONS_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(couponsUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la familia ve toda la cartera, con cada cupón en su cubo y «hoy» de Madrid', async () => {
    for (const user of [ADMIN_USER, FAMILY_USER]) {
      const data = await loadCoupons(user, FIXTURE_HOUSEHOLD, appPool, NOW);
      expect(data).not.toBeNull();
      expect(data?.today).toBe('2026-10-03');
      expect(data?.coupons.map((coupon) => coupon.id).sort()).toEqual(
        [SOON, MULTI, UNLIMITED, USED, EXPIRED, DISCARDED].sort()
      );
      expect(data?.counts).toEqual({ available: 3, used: 1, expired: 1, discarded: 1 });
      const bucketOf = Object.fromEntries((data?.coupons ?? []).map((coupon) => [coupon.id, coupon.bucket]));
      expect(bucketOf).toEqual({
        [SOON]: 'available',
        [MULTI]: 'available',
        [UNLIMITED]: 'available',
        [USED]: 'used',
        [EXPIRED]: 'expired',
        [DISCARDED]: 'discarded'
      });
    }
  });

  it('cada cupón trae sus datos tal como los pinta la pantalla', async () => {
    const data = await loadCoupons(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    const byId = new Map((data?.coupons ?? []).map((coupon) => [coupon.id, coupon]));

    expect(byId.get(SOON)).toMatchObject({
      merchant: 'Frutería Lola',
      offer: '2 × 1 en naranjas',
      code: 'NARANJA2X1',
      // Fecha de calendario en texto, no un Date de node-postgres.
      expiresOn: '2026-10-05',
      maxUses: 1,
      liveUses: 0,
      remaining: 1,
      notes: null,
      expiresSoon: true,
      discardedAt: null,
      createdAt: '2026-09-20T10:00:00.000Z',
      createdByName: 'Fixture Admin Roble',
      // La foto va por la ruta con sesión, nunca por una URL del almacén.
      // Con la versión de la foto en la URL: otra foto, otra dirección.
      photoUrl: `/api/v1/households/${FIXTURE_HOUSEHOLD}/coupons/${SOON}/photo?v=${PHOTO_ADMIN}`,
      uses: []
    });

    // Varios usos: los anulados no cuentan, y los vivos van del más reciente
    // al más antiguo, con quién lo usó.
    expect(byId.get(MULTI)).toMatchObject({
      maxUses: 5,
      liveUses: 2,
      remaining: 3,
      expiresSoon: false,
      notes: 'En la caja del fondo',
      createdByName: 'Fixture Familiar Roble',
      uses: [
        { id: 'ca200000-0000-4000-8000-000000000002', usedOn: '2026-10-01', usedByName: 'Fixture Familiar Roble' },
        { id: 'ca200000-0000-4000-8000-000000000001', usedOn: '2026-09-25', usedByName: 'Fixture Admin Roble' }
      ]
    });

    // Sin límite: nunca «usado», y el recuento es un número, no el texto de un count(*).
    const unlimited = byId.get(UNLIMITED);
    expect(unlimited).toMatchObject({ maxUses: null, liveUses: 4, remaining: null, bucket: 'available' });
    expect(typeof unlimited?.liveUses).toBe('number');

    expect(byId.get(USED)).toMatchObject({ liveUses: 1, remaining: 0, bucket: 'used' });
    expect(byId.get(EXPIRED)).toMatchObject({ expiresOn: '2026-09-01', bucket: 'expired', expiresSoon: false });
    expect(byId.get(DISCARDED)).toMatchObject({ bucket: 'discarded', discardedAt: '2026-10-01T09:00:00.000Z' });

    // Los comercios para el datalist: sin repetir aunque cambien las mayúsculas.
    expect(data?.merchants).toEqual(['Droguería Sol', 'Frutería Lola', 'Óptica', 'Panadería Ñandú', 'Zapatería']);
  });

  it('la familia que no administra también ve quién guardó y quién usó cada cupón', async () => {
    // `user_profiles` (0005) solo le enseña su propio perfil; los nombres de
    // la cartera le llegan por `app.coupon_people()` (0039). La spec §8.2 pide
    // «Usado el mar 7 oct por Marta» a toda la familia, no solo a la
    // administración (revisión de la fase 2, I-1).
    const data = await loadCoupons(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    const byId = new Map((data?.coupons ?? []).map((coupon) => [coupon.id, coupon]));
    expect(byId.get(SOON)?.createdByName).toBe('Fixture Admin Roble');
    expect(byId.get(MULTI)?.createdByName).toBe('Fixture Familiar Roble');
    expect(byId.get(MULTI)?.uses.map((use) => use.usedByName)).toEqual(['Fixture Familiar Roble', 'Fixture Admin Roble']);
    expect(byId.get(UNLIMITED)?.uses.map((use) => use.usedByName)).toEqual([
      'Fixture Familiar Roble',
      'Fixture Familiar Roble',
      'Fixture Admin Roble',
      'Fixture Admin Roble'
    ]);
  });

  it('un nombre que no llega sale como «Alguien de la familia», nunca como hueco', () => {
    // Una persona sin perfil (una baja) o un nombre en blanco: la ficha dice
    // algo verdadero en vez de un hueco.
    const view = buildCouponsPageData(FIXTURE_HOUSEHOLD, '2026-10-03', [
      {
        id: SOON,
        merchant: 'Frutería Lola',
        offer: '2 × 1',
        code: null,
        expiresOn: null,
        maxUses: 1,
        notes: null,
        discardedAt: null,
        createdAt: '2026-09-20T10:00:00.000Z',
        createdByName: null,
        photoStorageObjectId: PHOTO_ADMIN
      }
    ], [{ id: 'u', couponId: SOON, usedOn: '2026-10-01', usedByName: '  ' }]);
    expect(view.coupons[0]?.createdByName).toBe('Alguien de la familia');
    expect(view.coupons[0]?.uses[0]?.usedByName).toBe('Alguien de la familia');
  });

  it('el cubo sigue a «hoy»: el mismo cupón caduca al día siguiente de su fecha', async () => {
    const later = await loadCoupons(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, new Date('2026-10-06T10:00:00Z'));
    expect(later?.coupons.find((coupon) => coupon.id === SOON)?.bucket).toBe('expired');
    // A las 23:30 UTC del 4 ya es día 5 en Madrid: caduca HOY, sigue disponible.
    const lastDay = await loadCoupons(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, new Date('2026-10-04T23:30:00Z'));
    expect(lastDay?.today).toBe('2026-10-05');
    expect(lastDay?.coupons.find((coupon) => coupon.id === SOON)).toMatchObject({ bucket: 'available', expiresSoon: true });
  });

  it('quien no es de la familia no ve ni un cupón (RLS), aunque la ruta le fallara', async () => {
    for (const user of [EMPLOYEE_USER, HELPER_USER, VIEWER_USER]) {
      const data = await loadCoupons(user, FIXTURE_HOUSEHOLD, appPool, NOW);
      expect(data?.coupons, user.id).toEqual([]);
      expect(data?.merchants).toEqual([]);
      expect(data?.counts).toEqual({ available: 0, used: 0, expired: 0, discarded: 0 });
    }
  });

  it('a quien no tiene la capacidad ni se le pregunta a la base por los cupones', async () => {
    // Segunda reja (spec §9) también en GET: un `__data.json` con
    // `x-sveltekit-invalidated` puede saltarse el `load` del layout, que es el
    // que da el 403, y ejecutar solo el de la página. La RLS ya devuelve cero
    // filas; con esto, además, ni se consulta (revisión de seguridad, ronda 2, m1).
    const asked: string[] = [];
    const spyPool = {
      async connect() {
        const client = await appPool.connect();
        const query = client.query.bind(client);
        const release = client.release.bind(client);
        client.query = ((text: string | { text: string }, ...rest: unknown[]) => {
          asked.push(typeof text === 'string' ? text : text.text);
          return (query as (...args: unknown[]) => unknown)(text, ...rest);
        }) as typeof client.query;
        client.release = ((...args: Parameters<typeof release>) => {
          client.query = query;
          client.release = release;
          return release(...args);
        }) as typeof client.release;
        return client;
      }
    } as unknown as pg.Pool;

    for (const user of [EMPLOYEE_USER, HELPER_USER, VIEWER_USER]) {
      asked.length = 0;
      const data = await loadCoupons(user, FIXTURE_HOUSEHOLD, spyPool, NOW);
      expect(data?.coupons, user.id).toEqual([]);
      expect(data?.today).toBe('2026-10-03');
      expect(asked.filter((sql) => /app\.coupon/.test(sql)), user.id).toEqual([]);
    }
    // Control: a la familia sí se le pregunta.
    asked.length = 0;
    await loadCoupons(FAMILY_USER, FIXTURE_HOUSEHOLD, spyPool, NOW);
    expect(asked.some((sql) => /from app\.coupons\b/.test(sql))).toBe(true);
  });

  it('cada hogar ve su cartera y ninguna otra', async () => {
    const olivo = await loadCoupons(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, appPool, NOW);
    expect(olivo?.coupons.map((coupon) => coupon.id)).toEqual([OLIVO_COUPON]);
    // Sin membresía en el hogar pedido: null, que la página convierte en 403/404.
    expect(await loadCoupons(OLIVO_ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, NOW)).toBeNull();
  });

  it('sin base de datos no hay nada que leer', async () => {
    expect(await loadCoupons(ADMIN_USER, FIXTURE_HOUSEHOLD, null, NOW)).toBeNull();
  });
});
