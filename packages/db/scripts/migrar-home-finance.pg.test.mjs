import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { applyMigrations } from './migrate.mjs';
import { construirSqliteSintetica, GRUPO_TRASPASO_CANONICO, SUMAS_CUENTA_MES, TOTALES } from './home-finance-sintetica.mjs';
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

      // El grupo llega del origen como uuid4().hex (32 hex sin guiones) y se
      // busca por su forma CANÓNICA: es la que `aUuid` escribe y la que Postgres
      // devuelve, y por tanto la única con la que el resumen del origen casa.
      const { rows: patas } = await client.query(
        `select amount_cents::text as importe from app.finance_transactions
          where household_id = $1 and transfer_group_id::text = $2 order by amount_cents`,
        [HOGAR, GRUPO_TRASPASO_CANONICO]);
      expect(patas.map((p) => p.importe)).toEqual(['-50000', '50000']);

      // Un provider de solo blancos es «sin proveedor», no «un proveedor
      // vacío»: el mismo criterio (providerNormOSuNulo) que las reglas de
      // evento de más abajo, también en la tabla grande.
      const { rows: [soloBlancos] } = await client.query(
        `select provider, provider_norm from app.finance_transactions
          where household_id = $1 and concept = 'ADEUDO SIN PROVEEDOR LEGIBLE'`, [HOGAR]);
      expect(soloBlancos).toEqual({ provider: '   ', provider_norm: null });

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

describe.runIf(Boolean(adminUrl))('CLI migrar-home-finance', () => {
  let client; let dir; let backupDir; let rutaSqlite;
  const HOGAR_CLI = '7f000000-0000-4000-8000-000000000002';
  const guion = fileURLToPath(new URL('./migrar-home-finance.mjs', import.meta.url));
  const ejecutar = (extra, hogar = 'hogar-cli') => spawnSync(process.execPath,
    [guion, '--sqlite', rutaSqlite, '--database-url', adminUrl,
      '--household', hogar, '--backup-dir', backupDir, ...extra],
    { encoding: 'utf8' });

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await reiniciarBase(client);
    await client.query('set row_security = off');
    await client.query(`insert into app.households (id, slug, display_name) values
      ($1, 'hogar-cli', 'Hogar CLI'), ($2, 'hogar-corrupto', 'Hogar corrupto')`,
      [HOGAR_CLI, '7f000000-0000-4000-8000-000000000003']);
    dir = await mkdtemp(path.join(os.tmpdir(), 'etl-cli-'));
    backupDir = path.join(dir, 'copias');
    await mkdir(backupDir, { recursive: true });
    rutaSqlite = path.join(dir, 'finanzas-sintetica.db');
    construirSqliteSintetica(rutaSqlite, { computeDedupHash });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const contarTx = async (hogar) => (await client.query(
    `select count(*)::int as n from app.finance_transactions t
      join app.households h on h.id = t.household_id where h.slug = $1`, [hogar])).rows[0].n;

  it('sin argumentos obligatorios sale con código 2', () => {
    const r = spawnSync(process.execPath, [guion], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Uso:');
  });

  it('--dry-run verifica, hace copia y revierte', async () => {
    const r = ejecutar(['--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('DRY-RUN');
    expect(r.stdout).toContain('Resultado: OK');
    expect(await contarTx('hogar-cli')).toBe(0);
    const ficheros = await readdir(backupDir);
    expect(ficheros.some((f) => /^finanzas-.*\.db$/.test(f))).toBe(true);
  });

  it('la ejecución real migra, guarda informe y los números casan', async () => {
    const r = ejecutar([]);
    expect(r.status, r.stderr).toBe(0);
    expect(await contarTx('hogar-cli')).toBe(TOTALES.transactions);
    expect(r.stdout).toContain(`comprobados: ${TOTALES.hashesComprobables}`);
    const { rows: sumas } = await client.query(
      `select to_char(t.op_date, 'YYYY-MM') as mes, sum(t.amount_cents)::text as suma
         from app.finance_transactions t
         join app.finance_accounts a on a.household_id = t.household_id and a.id = t.account_id
         join app.households h on h.id = t.household_id
        where h.slug = 'hogar-cli' and a.bank_ref = '00490001512345678901'
        group by 1 order by 1`);
    // Las sumas esperadas salen de la constante de la muestra, no de literales.
    expect(sumas).toEqual(Object.entries(SUMAS_CUENTA_MES['00490001512345678901'])
      .map(([mes, suma]) => ({ mes, suma: String(suma) })));
    const informes = (await readdir(backupDir)).filter((f) => /^informe-migracion-.*\.md$/.test(f)).sort();
    expect(informes.length).toBeGreaterThan(0);
    const texto = await readFile(path.join(backupDir, informes.at(-1)), 'utf8');
    expect(texto).toContain('Resultado: OK');
    expect(texto).toContain('## Copia de seguridad (PASO 0)');
  });

  it('reejecutar aborta porque el hogar ya tiene datos', async () => {
    const r = ejecutar([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ya tiene');
    expect(await contarTx('hogar-cli')).toBe(TOTALES.transactions);
  });

  it('el aborto también deja informe, con el motivo dentro', async () => {
    const antes = (await readdir(backupDir)).filter((f) => /^informe-migracion-.*\.md$/.test(f));
    const r = ejecutar([]);
    expect(r.status).toBe(1);
    const despues = (await readdir(backupDir)).filter((f) => /^informe-migracion-.*\.md$/.test(f)).sort();
    expect(despues.length).toBe(antes.length + 1); // el informe existe justo cuando hace falta
    const texto = await readFile(path.join(backupDir, despues.at(-1)), 'utf8');
    expect(texto).toContain('## Aborto');
    expect(texto).toContain('ya tiene');
    expect(texto).toContain('Resultado: FALLO');
  });

  it('--verify-only da OK sobre lo migrado y FALLO sobre un hogar vacío', () => {
    const bien = ejecutar(['--verify-only']);
    expect(bien.status).toBe(0);
    expect(bien.stdout).toContain('Resultado: OK');
    const mal = ejecutar(['--verify-only'], 'hogar-corrupto');
    expect(mal.status).toBe(1);
    expect(mal.stdout).toContain('Resultado: FALLO');
  });

  it('un dedup_hash corrupto aborta antes de escribir', async () => {
    const rutaCorrupta = path.join(dir, 'finanzas-corrupta.db');
    construirSqliteSintetica(rutaCorrupta, { computeDedupHash, corromperHashDeTx: 2 });
    const r = spawnSync(process.execPath,
      [guion, '--sqlite', rutaCorrupta, '--database-url', adminUrl,
        '--household', 'hogar-corrupto', '--backup-dir', backupDir],
      { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Resultado: FALLO');
    expect(await contarTx('hogar-corrupto')).toBe(0);
  });
});
