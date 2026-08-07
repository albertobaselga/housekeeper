import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildCsv,
  buildEmploymentExport,
  centsToDecimal,
  csvField
} from '../src/lib/server/employment-export.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_export_login';
// Base de datos propia (patrón de la suite de comida): las otras suites recrean
// el esquema entero en paralelo y ninguna puede compartir instancia.
const EXPORT_DB = 'casaclara_employment_export_it';

const OLIVO_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';

const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const ADMIN_USER = { id: 'fixture:roble:admin' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };
const OLIVO_EMPLOYEE_USER = { id: 'fixture:olivo:employee' };

const GENERATED_AT = new Date('2026-08-07T10:00:00.000Z');

const EXPECTED_FILES = [
  'gastos.csv',
  'jornadas-extra.csv',
  'liquidaciones.csv',
  'pagos.csv',
  'partes-semanales.csv',
  'resumen.pdf',
  'saldos.csv'
];

function exportUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${EXPORT_DB}`;
  return url.toString();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Filas CSV como objetos cabecera→valor (la fixture no trae comas en campos). */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\r\n').filter((line) => line.length > 0);
  const header = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    const fields = line.split(',');
    return Object.fromEntries(header.map((name, index) => [name, fields[index] ?? '']));
  });
}

interface Manifest {
  version: number;
  household: { name: string };
  employee: { name: string };
  generatedAt: string;
  files: Array<{ path: string; sha256: string }>;
  filesHash: string;
}

describe('formateo CSV (RFC 4180)', () => {
  it('escapa comas, comillas y saltos de línea; null es campo vacío', () => {
    expect(csvField('sin cambios')).toBe('sin cambios');
    expect(csvField('con, coma')).toBe('"con, coma"');
    expect(csvField('con "comillas" dentro')).toBe('"con ""comillas"" dentro"');
    expect(csvField('línea\npartida')).toBe('"línea\npartida"');
    expect(csvField('retorno\r\nde carro')).toBe('"retorno\r\nde carro"');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField(0)).toBe('0');
    expect(csvField(true)).toBe('si');
    expect(csvField(false)).toBe('no');
  });

  it('buildCsv produce cabecera + filas con finales CRLF', () => {
    const csv = buildCsv(['a', 'b'], [['1', 'x, y'], ['2', null]]);
    expect(csv).toBe('a,b\r\n1,"x, y"\r\n2,\r\n');
  });

  it('centsToDecimal usa punto decimal y conserva el signo', () => {
    expect(centsToDecimal('145330')).toBe('1453.30');
    expect(centsToDecimal('-10000')).toBe('-100.00');
    expect(centsToDecimal('5')).toBe('0.05');
    expect(centsToDecimal('0')).toBe('0.00');
    expect(() => centsToDecimal('12.5')).toThrow(TypeError);
  });
});

describe.runIf(Boolean(adminUrl))('exportación del expediente laboral (AC-13) bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${EXPORT_DB} with (force)`);
      await cluster.query(`create database ${EXPORT_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: exportUrlFor(adminUrl as string) });
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

    const url = new URL(exportUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  async function buildZip(
    user: { id: string } = EMPLOYEE_USER,
    householdId: string = FIXTURE_HOUSEHOLD
  ): Promise<Record<string, Uint8Array>> {
    const zip = await buildEmploymentExport(user, householdId, appPool, GENERATED_AT);
    expect(zip).not.toBeNull();
    return unzipSync(zip!);
  }

  it('el ZIP trae los 7 ficheros y un manifest con sha-256 correctos y hash global', async () => {
    const entries = await buildZip();
    expect(Object.keys(entries).sort()).toEqual(['manifest.json', ...EXPECTED_FILES].sort());

    const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as Manifest;
    expect(manifest.version).toBe(1);
    expect(manifest.generatedAt).toBe(GENERATED_AT.toISOString());
    expect(manifest.household).toEqual({ name: 'Fixture Casa Roble' });
    expect(manifest.employee).toEqual({ name: 'Fixture Empleada Roble' });

    // El manifest cubre exactamente los 7 ficheros, ordenados y verificables.
    expect(manifest.files.map((file) => file.path)).toEqual(EXPECTED_FILES);
    for (const file of manifest.files) {
      expect(sha256(entries[file.path]!)).toBe(file.sha256);
    }
    const recomputedFilesHash = sha256(
      new TextEncoder().encode(manifest.files.map((file) => `${file.path}\n${file.sha256}\n`).join(''))
    );
    expect(manifest.filesHash).toBe(recomputedFilesHash);
  });

  it('liquidaciones.csv trae la fila de marzo con 145330 céntimos, cerrada y con cobro confirmado', async () => {
    const entries = await buildZip();
    const rows = parseCsv(strFromU8(entries['liquidaciones.csv']!));

    const total = rows.find((row) => row['tipo'] === 'total_transferencia');
    expect(total).toBeDefined();
    expect(total!['periodo_inicio']).toBe('2025-03-01');
    expect(total!['importe_centimos']).toBe('145330');
    expect(total!['importe_eur']).toBe('1453.30');
    expect(total!['estado']).toBe('cerrada');
    expect(total!['cobro_confirmado_en']).toContain('2025-03-31');

    // Las 8 líneas trazables de marzo conservan su origen.
    const lineRows = rows.filter((row) => row['tipo'] === 'linea');
    expect(lineRows).toHaveLength(8);
    expect(lineRows[0]!['clase']).toBe('base_salary');
    expect(lineRows[0]!['importe_centimos']).toBe('140000');
    expect(lineRows[0]!['version_acuerdo_id']).toBe('12100000-0000-4000-8000-000000000001');
    const advanceLine = lineRows.find((row) => row['clase'] === 'advance_deduction');
    expect(advanceLine!['importe_centimos']).toBe('-10000');
    expect(advanceLine!['importe_eur']).toBe('-100.00');
    expect(advanceLine!['anticipo_id']).toBe('12800000-0000-4000-8000-000000000001');
    const expenseLine = lineRows.find((row) => row['gasto_id'] === '12a00000-0000-4000-8000-000000000001');
    expect(expenseLine!['seccion']).toBe('reembolso');
  });

  it('pagos.csv, partes-semanales.csv, jornadas-extra.csv y gastos.csv traen el histórico completo', async () => {
    const entries = await buildZip();

    const payments = parseCsv(strFromU8(entries['pagos.csv']!));
    expect(payments.map((row) => row['importe_centimos'])).toEqual(['80000', '65330']);
    expect(payments[0]!['metodo']).toBe('transferencia');
    expect(payments[0]!['estado']).toBe('registrado');

    const reports = parseCsv(strFromU8(entries['partes-semanales.csv']!));
    expect(reports).toHaveLength(1);
    expect(reports[0]!['semana_inicio']).toBe('2025-03-10');
    expect(reports[0]!['estado']).toBe('confirmada');

    const extras = parseCsv(strFromU8(entries['jornadas-extra.csv']!));
    expect(extras).toHaveLength(5);
    const sunday = extras.find((row) => row['fecha'] === '2025-03-09');
    expect(sunday!['tipo']).toBe('descanso_trabajado');
    expect(sunday!['resolucion']).toBe('dinero');
    expect(sunday!['tarifa_congelada_centimos']).toBe('7000');
    const pending = extras.find((row) => row['fecha'] === '2025-03-27');
    expect(pending!['estado']).toBe('realizada_sin_aceptacion');
    expect(pending!['resolucion']).toBe('');

    const expenses = parseCsv(strFromU8(entries['gastos.csv']!));
    expect(expenses).toHaveLength(2);
    expect(expenses[0]!['estado']).toBe('aprobado');
    // Cada gasto reembolsado enlaza con su liquidación.
    expect(expenses[0]!['liquidacion_id']).toBe('12b00000-0000-4000-8000-000000000001');
  });

  it('saldos.csv trae el crédito permanente de 1440 min y el anticipo con 20000 pendiente', async () => {
    const entries = await buildZip();
    const rows = parseCsv(strFromU8(entries['saldos.csv']!));

    const credit = rows.find((row) => row['tipo'] === 'compensacion_permanente');
    expect(credit).toBeDefined();
    expect(credit!['detalle']).toBe('descanso_trabajado');
    expect(credit!['minutos']).toBe('1440');

    const advance = rows.find((row) => row['tipo'] === 'anticipo');
    expect(advance).toBeDefined();
    expect(advance!['principal_centimos']).toBe('40000');
    expect(advance!['pendiente_centimos']).toBe('20000');
    expect(advance!['pendiente_eur']).toBe('200.00');
  });

  it('el ZIP es determinista: mismo generatedAt → bytes idénticos', async () => {
    const first = await buildEmploymentExport(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, GENERATED_AT);
    const second = await buildEmploymentExport(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, GENERATED_AT);
    expect(first).not.toBeNull();
    expect(Buffer.from(first!).equals(Buffer.from(second!))).toBe(true);
  });

  it('resumen.pdf empieza por %PDF y su sha-256 es estable entre builds', async () => {
    const first = await buildZip();
    const second = await buildZip();
    const pdf = first['resumen.pdf']!;
    expect(strFromU8(pdf.slice(0, 5))).toBe('%PDF-');
    expect(sha256(pdf)).toBe(sha256(second['resumen.pdf']!));
  });

  it('solo la propia empleada: admin, helper y viewer reciben null', async () => {
    expect(await buildEmploymentExport(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, GENERATED_AT)).toBeNull();
    expect(await buildEmploymentExport(HELPER_USER, FIXTURE_HOUSEHOLD, appPool, GENERATED_AT)).toBeNull();
    expect(await buildEmploymentExport(VIEWER_USER, FIXTURE_HOUSEHOLD, appPool, GENERATED_AT)).toBeNull();
    // Sin pool (demo sin base de datos) tampoco hay exportación.
    expect(await buildEmploymentExport(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, null, GENERATED_AT)).toBeNull();
  });

  it('la empleada de otro hogar solo exporta lo suyo: cero filas de roble', async () => {
    // Sobre el hogar roble no tiene membresía: null.
    expect(
      await buildEmploymentExport(OLIVO_EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, GENERATED_AT)
    ).toBeNull();

    // Sobre su propio hogar exporta, pero sin una sola fila del expediente roble.
    const entries = await buildZip(OLIVO_EMPLOYEE_USER, OLIVO_HOUSEHOLD);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as Manifest;
    expect(manifest.household).toEqual({ name: 'Fixture Casa Olivo' });
    expect(manifest.employee).toEqual({ name: 'Fixture Empleada Olivo' });

    for (const name of EXPECTED_FILES.filter((file) => file.endsWith('.csv'))) {
      const rows = parseCsv(strFromU8(entries[name]!));
      expect(rows, `${name} debe llegar vacío para olivo`).toHaveLength(0);
      const text = strFromU8(entries[name]!);
      expect(text).not.toContain('145330');
      expect(text).not.toContain('Roble');
    }
  });
});
