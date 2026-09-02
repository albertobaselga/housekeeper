import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { applyMigrations } from './migrate.mjs';
import { construirSqliteSintetica, GRUPO_TRASPASO, TOTALES } from './home-finance-sintetica.mjs';
import { compararResumenes, leerOrigen, migrar, resumenDestino, resumenOrigen } from './migrar-home-finance.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;
const HOGAR = '7f000000-0000-4000-8000-000000000001';

export async function reiniciarBase(client) {
  await client.query('drop schema if exists app cascade');
  await client.query('drop schema if exists app_private cascade');
  await client.query('drop table if exists public.schema_migrations');
  await applyMigrations(client);
}

// La suite jamás se salta en CI en silencio: si CI no exporta la variable, es
// un fallo de configuración, no un test omitido sin ruido.
if (process.env.CI && !process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL es obligatoria en CI');
}

describe.runIf(Boolean(adminUrl))('migrar() contra Postgres real', () => {
  let client; let dir; let origen;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await reiniciarBase(client);
    await client.query('set row_security = off'); // propietario local, como las fixtures
    await client.query(`insert into app.households (id, slug, display_name)
      values ($1, 'hogar-etl', 'Hogar del ETL')`, [HOGAR]);
    dir = await mkdtemp(path.join(os.tmpdir(), 'etl-pg-'));
    const ruta = path.join(dir, 'finanzas-sintetica.db');
    construirSqliteSintetica(ruta, { computeDedupHash });
    origen = leerOrigen(ruta);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('inserta el origen completo y los resúmenes origen=destino casan', async () => {
    await client.query('begin');
    try {
      await migrar(client, HOGAR, origen);
      const destino = await resumenDestino(client, HOGAR);
      const comparacion = compararResumenes(resumenOrigen(origen), destino);
      expect(comparacion.lineas.filter((l) => !l.ok)).toEqual([]);
      expect(destino.conteos.finance_transactions).toBe(TOTALES.transactions);
      expect(destino.conteos.finance_rules).toBe(TOTALES.rulesActivas);

      const { rows: [nomina] } = await client.query(
        `select recurrence, recurrence_manual, provider_norm, currency_code
           from app.finance_transactions where household_id = $1 and concept = 'NOMINA EMPRESA EJEMPLO SL'`, [HOGAR]);
      expect(nomina).toEqual({ recurrence: 'recurrente', recurrence_manual: true,
        provider_norm: 'EMPRESA EJEMPLO', currency_code: 'EUR' });

      const { rows: [farmacia] } = await client.query(
        `select provider, provider_norm, dedup_hash from app.finance_transactions
          where household_id = $1 and concept = 'GASTO EN EFECTIVO FARMACIA'`, [HOGAR]);
      expect(farmacia).toEqual({ provider: 'Farmacia Ñuñez', provider_norm: 'FARMACIA NUNEZ',
        dedup_hash: 'manual-a1b2c3d4e5f60718' });

      const { rows: patas } = await client.query(
        `select amount_cents::text as importe from app.finance_transactions
          where household_id = $1 and transfer_group_id = $2 order by amount_cents`, [HOGAR, GRUPO_TRASPASO]);
      expect(patas.map((p) => p.importe)).toEqual(['-50000', '50000']);

      const { rows: [hija] } = await client.query(
        `select h.name from app.finance_categories h
           join app.finance_categories p on p.household_id = h.household_id and p.id = h.parent_id
          where h.household_id = $1 and p.name = 'Alimentación'`, [HOGAR]);
      expect(hija.name).toBe('Supermercado');

      const { rows: [crudo] } = await client.query(
        `select raw->>'Concepto' as concepto from app.finance_transactions
          where household_id = $1 and concept like 'COMPRA SUPERMERCADOS%'`, [HOGAR]);
      expect(crudo.concepto).toBe('COMPRA SUPERMERCADOS ACME S.L.');

      // raw nullable en el origen → '{}' en destino (la columna es NOT NULL).
      const { rows: [sinRaw] } = await client.query(
        `select raw::text as raw from app.finance_transactions
          where household_id = $1 and concept = 'NOMINA EMPRESA EJEMPLO SL'`, [HOGAR]);
      expect(sinRaw.raw).toBe('{}');

      // Vocabulario de bancos: cuentas virtuales → NULL, lote manual intacto.
      const { rows: sinBanco } = await client.query(
        `select bank_ref from app.finance_accounts
          where household_id = $1 and bank is null order by bank_ref`, [HOGAR]);
      expect(sinBanco.map((f) => f.bank_ref)).toEqual(['EFECTIVO', 'INV-SINTETICO']);
      const { rows: [loteManual] } = await client.query(
        `select bank from app.finance_import_batches
          where household_id = $1 and filename = 'manual'`, [HOGAR]);
      expect(loteManual.bank).toBe('manual');

      // Resolución del coordinador: provider_norm de finance_event_rules
      // coalescea '' a NULL igual que en las transacciones (misma función
      // auxiliar), y la regla de solo-categoría (provider_norm='' en el
      // origen) sobrevive porque category_id no es NULL (CHECK de 0036).
      const { rows: eventRules } = await client.query(
        `select provider_norm, category_id is not null as tiene_categoria
           from app.finance_event_rules where household_id = $1 order by provider_norm nulls first`, [HOGAR]);
      expect(eventRules).toEqual([
        { provider_norm: null, tiene_categoria: true },
        { provider_norm: 'SUPERMERCADOS ACME', tiene_categoria: false }
      ]);
    } finally {
      await client.query('rollback');
    }
  }, 120_000);
});
