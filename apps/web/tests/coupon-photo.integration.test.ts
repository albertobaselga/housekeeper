import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadCouponPhoto } from '../src/lib/server/coupon-photo.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

/**
 * La foto de un cupón bajo RLS (spec cupones §7.3 y §9). Quién la ve no lo
 * decide este código: lo decide la política `storage_objects_read_coupon_photo`
 * de la 0039 —la familia, a través del cupón— y la de `app.coupons`. La ruta
 * convierte el null en un 404 opaco.
 */

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_coupon_photo_login';
// Base propia, como las demás suites de integración de la web.
const PHOTO_DB = 'housekeeper_coupon_photo_it';

const OLIVO_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const FAMILY_MEMBERSHIP = '11000000-0000-4000-8000-000000000002';
const OLIVO_ADMIN_MEMBERSHIP = '21000000-0000-4000-8000-000000000001';

// `cd…` el hogar roble, `ce…` el olivo; 1 = foto, 2 = cupón.
const PHOTO = 'cd100000-0000-4000-8000-000000000001';
const PHOTO_DELETED = 'cd100000-0000-4000-8000-000000000002';
const COUPON = 'cd200000-0000-4000-8000-000000000001';
const COUPON_DISCARDED = 'cd200000-0000-4000-8000-000000000002';
const COUPON_PHOTO_DELETED = 'cd200000-0000-4000-8000-000000000003';
const OLIVO_PHOTO = 'ce100000-0000-4000-8000-000000000001';
const OLIVO_COUPON = 'ce200000-0000-4000-8000-000000000001';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };
const OLIVO_ADMIN_USER = { id: 'fixture:olivo:admin' };

const PHOTO_SEED = `
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.storage_objects (id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id, deleted_at) VALUES
  ('${PHOTO}', '${FIXTURE_HOUSEHOLD}', 'housekeeper-it', 'coupons-it/vale.jpg', 'image/jpeg', 2048, repeat('a', 64), '${FAMILY_MEMBERSHIP}', NULL),
  ('${PHOTO_DELETED}', '${FIXTURE_HOUSEHOLD}', 'housekeeper-it', 'coupons-it/borrada.jpg', 'image/jpeg', 1024, repeat('b', 64), '${FAMILY_MEMBERSHIP}', statement_timestamp()),
  ('${OLIVO_PHOTO}', '${OLIVO_HOUSEHOLD}', 'housekeeper-it', 'coupons-it/olivo.png', 'image/png', 512, repeat('c', 64), '${OLIVO_ADMIN_MEMBERSHIP}', NULL);
INSERT INTO app.coupons (household_id, id, merchant, offer, code, photo_storage_object_id, created_by_membership_id, discarded_at, discarded_by_membership_id) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${COUPON}', 'Comercio IT', 'Oferta IT', 'CODIGO-IT', '${PHOTO}', '${FAMILY_MEMBERSHIP}', NULL, NULL),
  ('${FIXTURE_HOUSEHOLD}', '${COUPON_DISCARDED}', 'Comercio IT', 'Oferta IT', NULL, '${PHOTO}', '${FAMILY_MEMBERSHIP}', now(), '${ADMIN_MEMBERSHIP}'),
  ('${FIXTURE_HOUSEHOLD}', '${COUPON_PHOTO_DELETED}', 'Comercio IT', 'Oferta IT', NULL, '${PHOTO_DELETED}', '${FAMILY_MEMBERSHIP}', NULL, NULL),
  ('${OLIVO_HOUSEHOLD}', '${OLIVO_COUPON}', 'Olivo IT', 'Oferta IT', NULL, '${OLIVO_PHOTO}', '${OLIVO_ADMIN_MEMBERSHIP}', NULL, NULL);
COMMIT;
`;

function photoDbUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${PHOTO_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('foto del cupón bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${PHOTO_DB} with (force)`);
      await cluster.query(`create database ${PHOTO_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: photoDbUrlFor(adminUrl as string) });
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
      await admin.query(PHOTO_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(photoDbUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la familia, con sus dos papeles, llega a la foto; y solo a lo que hace falta para servirla', async () => {
    for (const user of [ADMIN_USER, FAMILY_USER]) {
      // Ni comercio, ni código, ni oferta: lo que no se lee no puede acabar en
      // un registro ni en una cabecera.
      expect(await loadCouponPhoto(user, FIXTURE_HOUSEHOLD, COUPON, appPool), user.id).toEqual({
        bucket: 'housekeeper-it',
        objectKey: 'coupons-it/vale.jpg',
        mediaType: 'image/jpeg',
        byteSize: '2048'
      });
    }
  });

  it('la empleada, el apoyo y el acceso puntual no la ven: ni el cupón ni el objeto existen para ellos', async () => {
    for (const user of [EMPLOYEE_USER, HELPER_USER, VIEWER_USER]) {
      expect(await loadCouponPhoto(user, FIXTURE_HOUSEHOLD, COUPON, appPool), user.id).toBeNull();
    }
  });

  it('nadie llega a la foto de otro hogar, ni pidiéndola desde el suyo', async () => {
    // Sin membresía en el roble: la transacción autorizada ni se abre.
    expect(await loadCouponPhoto(OLIVO_ADMIN_USER, FIXTURE_HOUSEHOLD, COUPON, appPool)).toBeNull();
    // Desde su hogar, con el id del cupón ajeno: no existe.
    expect(await loadCouponPhoto(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, COUPON, appPool)).toBeNull();
    expect(await loadCouponPhoto(ADMIN_USER, FIXTURE_HOUSEHOLD, OLIVO_COUPON, appPool)).toBeNull();
    // Y su propia foto sí la ve.
    expect(await loadCouponPhoto(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, OLIVO_COUPON, appPool)).toMatchObject({
      mediaType: 'image/png'
    });
  });

  it('un cupón descartado conserva su foto: se puede recuperar y hay que poder reconocerlo', async () => {
    expect(await loadCouponPhoto(FAMILY_USER, FIXTURE_HOUSEHOLD, COUPON_DISCARDED, appPool)).toMatchObject({
      objectKey: 'coupons-it/vale.jpg'
    });
  });

  it('una foto borrada o un cupón que no existe no ofrecen nada', async () => {
    expect(await loadCouponPhoto(FAMILY_USER, FIXTURE_HOUSEHOLD, COUPON_PHOTO_DELETED, appPool)).toBeNull();
    expect(
      await loadCouponPhoto(FAMILY_USER, FIXTURE_HOUSEHOLD, 'cd200000-0000-4000-8000-000000000999', appPool)
    ).toBeNull();
  });

  it('sin pool (maqueta) no hay foto que servir', async () => {
    expect(await loadCouponPhoto(FAMILY_USER, FIXTURE_HOUSEHOLD, COUPON, null)).toBeNull();
  });
});
