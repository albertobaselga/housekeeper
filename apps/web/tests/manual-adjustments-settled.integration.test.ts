import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  employmentHrefBases,
  loadEmploymentOverview
} from '../src/lib/server/employment.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_ajustes_login';
// Base propia (patrón de las suites de exportación y documento): las demás
// recrean el esquema entero en paralelo y ninguna puede compartir instancia.
const AJUSTES_DB = 'casaclara_ajustes_it';

const ADMIN_USER = { id: 'fixture:roble:admin' };
// El mismo administrador, con la identidad entera que pide el constructor de
// bases: de él solo sale qué pestaña de contrato enseñar, y la de Pagos —la
// que aquí se comprueba— no depende del rol.
const ADMIN_DEMO = {
  ...ADMIN_USER,
  name: 'Administración',
  initials: 'AD',
  email: 'admin@casa.test',
  memberships: [],
  mustChangePassword: false
};
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const AGREEMENT = '12000000-0000-4000-8000-000000000001';
const EMPLOYEE_M = '11000000-0000-4000-8000-000000000003';
const ADMIN_M = '11000000-0000-4000-8000-000000000001';

// Reloj inyectado: el montaje habla de meses concretos —cuál es «el mes en
// curso» decide qué entra en el devengo—. Con el reloj de verdad, esta suite
// diría cosas distintas según el día en que se ejecute.
const NOW = new Date('2026-09-15T10:00:00Z');
const NOMINA_SEPTIEMBRE = 'ac000000-0000-4000-8000-000000000002';

function dbUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${AJUSTES_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('conceptos a mano: a la página solo llega lo que queda por resolver, bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${AJUSTES_DB} with (force)`);
      await cluster.query(`create database ${AJUSTES_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: dbUrlFor(adminUrl as string) });
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

      // Los seis casos que decide la consulta de la página, con el mes en curso
      // en septiembre de 2026: un adelanto de julio ya descontado en la nómina
      // cerrada de julio; uno del mes en curso sin aplicar; otro del mes en
      // curso YA aplicado por la nómina de septiembre, que se cerró el día 12
      // con medio mes por delante; uno anulado; uno imputado a diciembre; y uno
      // de abril que nunca se cerró y que sigue esperando decisión.
      await admin.query('begin');
      await admin.query('set local row_security = off');
      await admin.query(
        `insert into app.manual_adjustments
           (id, household_id, agreement_id, employee_membership_id, period_month,
            requested_period_month, label, reason, amount_cents, adds_to_pay,
            recorded_by_membership_id, recorded_at)
         values
           ('ac100000-0000-4000-8000-000000000001', $1, $2, $3,
            date '2026-07-01', date '2026-07-01', 'IT Adelanto aplicado',
            'Entregado a cuenta en julio', -10000, true, $4, '2026-07-10T10:00:00Z'),
           ('ac100000-0000-4000-8000-000000000002', $1, $2, $3,
            date '2026-09-01', date '2026-09-01', 'IT Pendiente de aplicar',
            'Acordado este mes', 4000, true, $4, '2026-09-02T10:00:00Z'),
           ('ac100000-0000-4000-8000-000000000003', $1, $2, $3,
            date '2026-09-01', date '2026-09-01', 'IT Aplicado en el mes en curso',
            'Entregado a cuenta el 5 de septiembre', -2500, true, $4, '2026-09-05T10:00:00Z'),
           ('ac100000-0000-4000-8000-000000000004', $1, $2, $3,
            date '2026-09-01', date '2026-09-01', 'IT Anulado',
            'El importe era otro', 3000, true, $4, '2026-09-03T10:00:00Z'),
           ('ac100000-0000-4000-8000-000000000005', $1, $2, $3,
            date '2026-12-01', date '2026-12-01', 'IT Imputado a diciembre',
            'Gratificación de Navidad, acordada ya', 1500, true, $4, '2026-09-04T10:00:00Z'),
           ('ac100000-0000-4000-8000-000000000006', $1, $2, $3,
            date '2026-04-01', date '2026-04-01', 'IT Viejo sin cerrar',
            'De abril, nunca se cerró aquel mes', 2000, true, $4, '2026-04-10T10:00:00Z')`,
        [FIXTURE_HOUSEHOLD, AGREEMENT, EMPLOYEE_M, ADMIN_M]
      );
      // Se anula ANTES de cerrar nada: anular un mes ya cerrado está prohibido,
      // y el montaje tiene que ser un camino legal de la aplicación.
      await admin.query(
        `update app.manual_adjustments
            set status = 'voided', voided_by_membership_id = $1,
                voided_at = '2026-09-03T12:00:00Z', void_reason = 'Se apuntó dos veces'
          where id = 'ac100000-0000-4000-8000-000000000004'`,
        [ADMIN_M]
      );
      await admin.query(
        `insert into app.settlements
           (id, household_id, agreement_id, employee_membership_id, period_start,
            period_end, due_on, created_by_membership_id)
         values ('ac000000-0000-4000-8000-000000000001', $1, $2, $3,
                 date '2026-07-01', date '2026-07-31', date '2026-07-31', $4),
                ($5, $1, $2, $3,
                 date '2026-09-01', date '2026-09-30', date '2026-09-30', $4)`,
        [FIXTURE_HOUSEHOLD, AGREEMENT, EMPLOYEE_M, ADMIN_M, NOMINA_SEPTIEMBRE]
      );
      await admin.query(
        `insert into app.settlement_lines
           (household_id, settlement_id, agreement_id, employee_membership_id,
            line_number, section, kind, occurred_on, concept, amount_cents, manual_adjustment_id)
         values ($1, 'ac000000-0000-4000-8000-000000000001', $2, $3,
                 1, 'salary', 'adjustment', date '2026-07-10',
                 'IT Adelanto aplicado · Entregado a cuenta', -10000,
                 'ac100000-0000-4000-8000-000000000001'),
                ($1, $4, $2, $3,
                 1, 'salary', 'adjustment', date '2026-09-05',
                 'IT Aplicado en el mes en curso · Entregado a cuenta', -2500,
                 'ac100000-0000-4000-8000-000000000003')`,
        [FIXTURE_HOUSEHOLD, AGREEMENT, EMPLOYEE_M, NOMINA_SEPTIEMBRE]
      );
      await admin.query(
        `update app.settlements
            set status = 'closed', closed_by_membership_id = $1,
                closed_at = '2026-07-31T18:00:00Z', snapshot_hash = repeat('f', 64)
          where id = 'ac000000-0000-4000-8000-000000000001'`,
        [ADMIN_M]
      );
      // La de septiembre se cierra el día 12, con medio mes por delante: es la
      // situación que obliga a que el devengo y la lista se lean por separado.
      await admin.query(
        `update app.settlements
            set status = 'closed', closed_by_membership_id = $1,
                closed_at = '2026-09-12T18:00:00Z', snapshot_hash = repeat('e', 64)
          where id = $2`,
        [ADMIN_M, NOMINA_SEPTIEMBRE]
      );
      await admin.query('commit');

      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(dbUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('lo que ya cerró una nómina y lo anulado no llegan; lo viejo sin cerrar SÍ', async () => {
    const overview = await loadEmploymentOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(overview).not.toBeNull();

    const etiquetas = overview!.manualAdjustments.map((row) => row.label);
    // Queda exactamente lo que sigue esperando una decisión: el pendiente del
    // mes, el que se imputó a un mes que aún no ha llegado —que todavía puede
    // anularse antes de que llegue— y el de abril que nunca se cerró.
    //
    // El de abril es el que cambió de bando. Con la ventana de tres meses se
    // caía de aquí, y no aparecía en ninguna otra parte: no está en Pagos
    // (nunca tuvo línea), ni en el devengo (que sólo mira el mes en curso), ni
    // en Hoy, ni en el contador de la portada. Al cuarto mes desaparecía de la
    // aplicación entera sin que nadie hubiera decidido nada sobre él.
    expect(etiquetas).toEqual([
      'IT Imputado a diciembre',
      'IT Pendiente de aplicar',
      'IT Viejo sin cerrar'
    ]);
    expect(etiquetas).not.toContain('IT Adelanto aplicado');
    expect(etiquetas).not.toContain('IT Aplicado en el mes en curso');
    expect(etiquetas).not.toContain('IT Anulado');
  });

  it('pero el devengo del mes sigue contando lo que la nómina de este mismo mes ya pagó', async () => {
    // La trampa del cambio: la cuenta de septiembre se cerró el día 12 y el mes
    // sigue corriendo. Si el concepto ya aplicado desapareciera también del
    // devengo, el «Total previsto del mes» diría más de lo que se pagó.
    const overview = await loadEmploymentOverview(
      ADMIN_USER,
      FIXTURE_HOUSEHOLD,
      appPool,
      NOW,
      null,
      // Con las bases de verdad: el enlace de cada origen es media prueba.
      employmentHrefBases(ADMIN_DEMO, FIXTURE_HOUSEHOLD, AGREEMENT)
    );
    const lineas = overview!.accrual!.lines.filter((line) => line.kind === 'adjustment');
    expect(lineas.map((line) => line.concept)).toEqual([
      'IT Pendiente de aplicar',
      'IT Aplicado en el mes en curso'
    ]);
    // Y el que ya está en la nómina enlaza a su mes de Pagos, no a Conceptos:
    // de Conceptos ya salió, así que el clic no llevaría a ninguna parte.
    const aplicada = lineas.find((line) => line.concept === 'IT Aplicado en el mes en curso');
    expect(aplicada!.href).toBe(
      `/h/${FIXTURE_HOUSEHOLD}/employment/pagos?empleada=${AGREEMENT}#cuenta-${NOMINA_SEPTIEMBRE}`
    );
    const pendiente = lineas.find((line) => line.concept === 'IT Pendiente de aplicar');
    expect(pendiente!.href).toContain('/employment/conceptos?empleada=');
    expect(pendiente!.href).toContain('#concepto-');
  });

  it('la empleada ve la misma verdad: sus conceptos ya aplicados no vuelven como pendientes', async () => {
    const overview = await loadEmploymentOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(overview!.manualAdjustments.map((row) => row.label)).toEqual([
      'IT Imputado a diciembre',
      'IT Pendiente de aplicar',
      'IT Viejo sin cerrar'
    ]);
  });
});
