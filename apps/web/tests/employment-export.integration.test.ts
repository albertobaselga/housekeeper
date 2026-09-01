import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

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
const APP_LOGIN = 'it_housekeeper_export_login';
// Base de datos propia (patrón de la suite de comida): las otras suites recrean
// el esquema entero en paralelo y ninguna puede compartir instancia.
const EXPORT_DB = 'housekeeper_employment_export_it';

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

/**
 * El texto que un PDF de pdf-lib enseña de verdad.
 *
 * Dos capas que hay que deshacer para poder afirmar algo sobre el documento y
 * no sobre sus bytes: los flujos de contenido van comprimidos con Flate, y
 * dentro pdf-lib escribe cada cadena como HEXADECIMAL (`<4C6120…> Tj`), no como
 * literal entre paréntesis. Se infla, se pasa el hexadecimal a bytes y se lee
 * como Latin-1, que es lo que WinAnsi es en su mayor parte: así «Seguro médico
 * privado» y «-200,00 EUR» se comparan tal como se ven en la hoja.
 */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = raw.indexOf('stream', cursor);
    if (start === -1) break;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    cursor = end + 'endstream'.length;
    let from = start + 'stream'.length;
    if (raw[from] === 0x0d) from += 1;
    if (raw[from] === 0x0a) from += 1;
    try {
      pieces.push(inflateSync(raw.subarray(from, end)).toString('latin1'));
    } catch {
      // Un flujo que no es Flate (una fuente incrustada, por ejemplo): se salta.
    }
  }
  const content = pieces.join('\n');
  const shown: string[] = [];
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
    shown.push(Buffer.from(match[1]!.replace(/\s+/g, ''), 'hex').toString('latin1'));
  }
  for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    shown.push(match[1]!.replace(/\\([()\\])/g, '$1'));
  }
  return shown.join('\n');
}

/**
 * Filas CSV como objetos cabecera→valor, con comillas de verdad (RFC 4180).
 *
 * Partir por comas era suficiente mientras ningún campo llevaba una: dejó de
 * serlo en cuanto el motivo de un concepto apuntado a mano —texto que escribe
 * una persona— entró en el fichero. Un lector ingenuo desplazaba las columnas
 * y el test comparaba la columna equivocada creyendo que comparaba bien.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0] ?? [];
  return rows
    .slice(1)
    .map((fields) => Object.fromEntries(header.map((name, index) => [name, fields[index] ?? ''])));
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

const MAY_SETTLEMENT = '12b00000-0000-4000-8000-0000000000aa';

/**
 * Un mes con TODOS los tipos de concepto a la vez, sembrado solo en la base de
 * esta suite.
 *
 * La fixture compartida trae marzo de 2025, que sirve para lo que ya se
 * comprobaba pero no para lo que el propietario pidió: no tiene ningún concepto
 * que reste apuntado a mano, ni ninguno de los que «constan y no se
 * transfieren». Mayo de 2025 los tiene los cuatro:
 *
 *   · salario base de la v2 del contrato        +1.500,00 €
 *   · complemento de antigüedad (suma)             +30,00 €
 *   · descuento acordado, apuntado a mano           −50,00 €
 *   ────────────────────────────────────────────────────────
 *     total a transferir                          1.480,00 €
 *
 *   · seguro médico privado, lo paga la casa        45,00 €  ← consta, no suma
 *   · anticipo devuelto en mano, apuntado a mano   −200,00 €  ← consta, no resta
 *
 * El descuento por cuota de anticipo —el otro tipo de resta— ya lo trae marzo
 * en la fixture compartida, así que no se duplica aquí.
 *
 * El orden importa: el concepto apuntado a mano entra ANTES de cerrar el mes,
 * porque el disparador de la 0022 prohíbe imputar nada a un mes ya cerrado.
 */
async function seedMayAccount(admin: pg.Client): Promise<void> {
  const HOUSEHOLD = FIXTURE_HOUSEHOLD;
  const AGREEMENT = '12000000-0000-4000-8000-000000000001';
  const EMPLOYEE = '11000000-0000-4000-8000-000000000003';
  const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
  const VERSION_V2 = '12100000-0000-4000-8000-000000000002';

  await admin.query('begin');
  await admin.query('set local row_security = off');

  await admin.query(
    `insert into app.manual_adjustments
       (id, household_id, agreement_id, employee_membership_id, period_month,
        requested_period_month, label, reason, amount_cents, adds_to_pay,
        recorded_by_membership_id, recorded_at)
     values
       ($1, $2, $3, $4, date '2025-05-01', date '2025-05-01',
        'Descuento acordado', 'Rotura de la vitro, acordado a medias',
        -5000, true, $5, '2025-05-02T10:00:00Z'),
       ($6, $2, $3, $4, date '2025-05-01', date '2025-05-01',
        'Anticipo devuelto en mano', 'Ya se devolvio en efectivo el 2 de mayo',
        -20000, false, $5, '2025-05-02T10:01:00Z')`,
    [
      '12aa0000-0000-4000-8000-000000000001',
      HOUSEHOLD,
      AGREEMENT,
      EMPLOYEE,
      ADMIN_MEMBERSHIP,
      '12aa0000-0000-4000-8000-000000000002'
    ]
  );

  await admin.query(
    `insert into app.settlements
       (id, household_id, agreement_id, employee_membership_id, period_start,
        period_end, due_on, created_by_membership_id)
     values ($1, $2, $3, $4, date '2025-05-01', date '2025-05-31', date '2025-06-05', $5)`,
    [MAY_SETTLEMENT, HOUSEHOLD, AGREEMENT, EMPLOYEE, ADMIN_MEMBERSHIP]
  );

  /**
   * [nº, sección, clase, fecha, concepto, importe, versión, complemento, ajuste]
   *
   * Cada clase exige su procedencia (`settlement_lines_provenance_by_kind`),
   * igual que en el cierre real: una línea sin la fila que la justifica sería
   * un importe sin padre. La cuota de anticipo NO se repite aquí: marzo ya
   * tiene la suya, y añadir otra movería el saldo del anticipo de la fixture.
   */
  const lines: Array<
    [number, string, string, string, string, number, string | null, string | null, string | null]
  > = [
    [1, 'salary', 'base_salary', '2025-05-01', 'Salario acordado 2025-05', 150_000, VERSION_V2, null, null],
    [
      2,
      'salary',
      'supplement',
      '2025-05-01',
      'Complemento de antiguedad',
      3_000,
      null,
      '14000000-0000-4000-8000-000000000001',
      null
    ],
    [
      3,
      'salary',
      'adjustment',
      '2025-05-01',
      'Descuento acordado - Rotura de la vitro, acordado a medias',
      -5_000,
      null,
      null,
      '12aa0000-0000-4000-8000-000000000001'
    ]
  ];
  for (const line of lines) {
    await admin.query(
      `insert into app.settlement_lines
         (household_id, settlement_id, agreement_id, employee_membership_id, line_number,
          section, kind, occurred_on, concept, amount_cents,
          agreement_version_id, recurring_supplement_id, manual_adjustment_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13)`,
      [HOUSEHOLD, MAY_SETTLEMENT, AGREEMENT, EMPLOYEE, ...line]
    );
  }

  await admin.query(
    `update app.settlements
        set status = 'closed', closed_by_membership_id = $2,
            closed_at = '2025-06-01T09:00:00Z', snapshot_hash = repeat('d', 64)
      where id = $1`,
    [MAY_SETTLEMENT, ADMIN_MEMBERSHIP]
  );
  await admin.query('commit');
}

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
      await seedMayAccount(admin);
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
    expect(manifest.version).toBe(2);
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
    const rows = parseCsv(strFromU8(entries['liquidaciones.csv']!)).filter(
      (row) => row['periodo_inicio'] === '2025-03-01'
    );

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

  it('liquidaciones.csv trae, en mayo, los conceptos que restan y los que solo constan', async () => {
    const entries = await buildZip();
    const rows = parseCsv(strFromU8(entries['liquidaciones.csv']!)).filter(
      (row) => row['periodo_inicio'] === '2025-05-01'
    );

    // Lo que mueve la transferencia: cuatro líneas, dos de ellas negativas.
    const lineRows = rows.filter((row) => row['tipo'] === 'linea');
    expect(lineRows.map((row) => row['importe_centimos'])).toEqual(['150000', '3000', '-5000']);
    const total = rows.find((row) => row['tipo'] === 'total_transferencia');
    expect(total!['importe_centimos']).toBe('148000');
    // Y cuadra: el total congelado es exactamente la suma de las líneas.
    expect(
      lineRows.reduce((sum, row) => sum + Number(row['importe_centimos']), 0)
    ).toBe(Number(total!['importe_centimos']));

    // Lo que consta y NO se transfiere: van con un `tipo` propio para que
    // filtrar por 'linea' siga dando el total exacto, pero SALEN.
    const noted = rows.filter((row) => row['tipo'] === 'concepto_informativo');
    expect(noted).toHaveLength(2);
    expect(noted.map((row) => [row['clase'], row['importe_centimos']])).toEqual([
      ['complemento', '4500'],
      ['concepto_apuntado', '-20000']
    ]);
    for (const row of noted) {
      expect(row['seccion']).toBe('no_transferido');
      expect(row['concepto']).toContain('no entra en la transferencia');
    }
  });

  it('resumen.pdf escribe la cuenta de cada mes con todos sus conceptos y sus totales', async () => {
    const entries = await buildZip();
    const pdf = pdfText(entries['resumen.pdf']!);

    expect(pdf).toContain('La cuenta de cada mes');
    expect(pdf).toContain('Mayo 2025');
    expect(pdf).toContain('Marzo 2025');

    // Los tres conceptos de mayo, con su signo, y el total al que llegan.
    expect(pdf).toContain('Salario acordado 2025-05');
    expect(pdf).toContain('1.500,00 EUR');
    expect(pdf).toContain('30,00 EUR');
    expect(pdf).toContain('-50,00 EUR');
    expect(pdf).toContain('Total a transferir');
    expect(pdf).toContain('1.480,00 EUR');

    // El descuento por cuota de anticipo, en marzo: un concepto que RESTA y no
    // es un apunte a mano.
    expect(pdf).toContain('Fixture advance installment');
    expect(pdf).toContain('-100,00 EUR');

    // Y los dos de mayo que constan sin transferirse, marcados como tales.
    expect(pdf).toContain('Consta en este mes y NO entra en la transferencia');
    expect(pdf).toContain('Seguro médico privado');
    expect(pdf).toContain('lo paga la casa aparte; no entra en la transferencia');
    expect(pdf).toContain('Anticipo devuelto en mano');
    expect(pdf).toContain('consta en el expediente; no entra en la transferencia');
    expect(pdf).toContain('-200,00 EUR');

    // Ningún aviso de descuadre: las líneas suman el total congelado.
    expect(pdf).not.toContain('Aviso: las líneas de arriba suman');

    // Y cada hoja se identifica sola: una página suelta sigue diciendo de quién
    // es y de cuándo.
    expect(pdf).toContain('1 / 2');
    expect(pdf).toContain('2 / 2');
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
