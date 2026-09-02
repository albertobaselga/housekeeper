import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { importarModuloTs } from './cargar-ts.mjs';
import { construirSqliteSintetica, CUENTAS, GRUPO_HUERFANO, GRUPO_TRASPASO, GRUPO_TRASPASO_CANONICO, SUMAS_CUENTA_MES, TOTALES } from './home-finance-sintetica.mjs';
import { aUuid, avisosOrigen, compararResumenes, ErrorDeUso, hacerCopiaSeguridad, leerOrigen, normText, parseArgs, renderInforme, resumenOrigen, validarOrigen, verificarHashes } from './migrar-home-finance.mjs';

describe('parseArgs', () => {
  it('lee flags con valor y banderas', () => {
    expect(parseArgs(['--sqlite', '/tmp/x.db', '--database-url', 'postgresql://u@h/db',
      '--household', 'hogar', '--backup-dir', '/tmp/copias', '--dry-run']))
      .toMatchObject({ sqlite: '/tmp/x.db', databaseUrl: 'postgresql://u@h/db', household: 'hogar',
        backupDir: '/tmp/copias', dryRun: true, verifyOnly: false, forceEmptyCheck: false });
  });
  it('rechaza ausencias, desconocidos y combinaciones imposibles', () => {
    expect(() => parseArgs([])).toThrow(ErrorDeUso);
    expect(() => parseArgs(['--sqlite'])).toThrow(/necesita un valor/);
    expect(() => parseArgs(['--sqlite', 'a', '--database-url', 'b', '--household', 'c', '--rarisimo'])).toThrow(/desconocido/);
    expect(() => parseArgs(['--sqlite', 'a', '--database-url', 'b', '--household', 'c', '--dry-run', '--verify-only'])).toThrow(/excluyentes/);
  });
});

describe('normText (réplica de money.py::norm_text)', () => {
  it('quita acentos, colapsa espacios y pasa a mayúsculas', () => {
    expect(normText('  Café  con\tleche  ')).toBe('CAFE CON LECHE');
    expect(normText('Peluquería Ñoño')).toBe('PELUQUERIA NONO');
  });

  it('coincide con el normText del dominio (fase 2) para una muestra de cadenas', async () => {
    const { normText: normTextDominio } = await importarModuloTs(
      new URL('../../domain/src/finance/text.ts', import.meta.url));
    const muestras = [
      '  Café  con\tleche  ',
      'Peluquería Ñoño',
      'ÁÉÍÓÚ ñÑ   múltiples    espacios',
      'símbolos: %&/()=?¡¿@#',
      '',
      '   ',
      'ya limpio',
      'MAYÚSCULAS y minúsculas MEZCLADAS'
    ];
    for (const muestra of muestras) {
      expect(normText(muestra)).toBe(normTextDominio(muestra));
    }
  });
});

describe('aUuid (transfer_group_id: el origen usa uuid4().hex, 32 hex sin guiones)', () => {
  it('canonicaliza la forma REAL del origen, 32 hex sin guiones', () => {
    expect(aUuid('fc9cabf5d7cb4499abbdead6b78db63e', 7))
      .toBe('fc9cabf5-d7cb-4499-abbd-ead6b78db63e');
    expect(aUuid('FC9CABF5D7CB4499ABBDEAD6B78DB63E', 7))
      .toBe('fc9cabf5-d7cb-4499-abbd-ead6b78db63e');
  });
  it('deja la forma canónica igual, siempre en minúsculas (es idempotente)', () => {
    expect(aUuid('e7b8c9d0-1234-4abc-8def-000000000002', 9))
      .toBe('e7b8c9d0-1234-4abc-8def-000000000002');
    expect(aUuid('E7B8C9D0-1234-4ABC-8DEF-000000000002', 9))
      .toBe('e7b8c9d0-1234-4abc-8def-000000000002');
    expect(aUuid(aUuid(GRUPO_TRASPASO, 3), 3)).toBe(GRUPO_TRASPASO_CANONICO);
  });
  it('«sin grupo» (null o cadena vacía) es null, no un error', () => {
    expect(aUuid(null, 1)).toBe(null);
    expect(aUuid('', 1)).toBe(null);
  });
  it('cualquier otra cosa aborta nombrando la transacción y el valor', () => {
    expect(() => aUuid('no-soy-un-uuid', 42)).toThrow(/42.*no-soy-un-uuid/);
    expect(() => aUuid('fc9cabf5d7cb4499abbdead6b78db63', 42)).toThrow(/transfer_group_id no-UUID/);
    expect(() => aUuid('zz9cabf5d7cb4499abbdead6b78db63e', 42)).toThrow(/transfer_group_id no-UUID/);
  });
});

describe('hacerCopiaSeguridad', () => {
  it('se niega a copiar dentro de un repositorio git', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'copia-repo-'));
    try {
      await mkdir(path.join(dir, '.git'));
      await expect(hacerCopiaSeguridad('/no/importa.db', path.join(dir, 'sub', 'copias')))
        .rejects.toThrow(/fuera de ambos repos/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('crea una copia datada idéntica fuera de cualquier repo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'copia-ok-'));
    try {
      const original = path.join(dir, 'finanzas.db');
      await writeFile(original, 'contenido sintético');
      const { destino, sha256 } = await hacerCopiaSeguridad(
        original, path.join(dir, 'copias'), new Date('2026-08-31T10:00:00.000Z'));
      expect(path.basename(destino)).toBe('finanzas-2026-08-31T10-00-00-000Z.db');
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('leerOrigen', () => {
  it('lee todas las tablas con importes bigint, ids number y booleanos JS', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'origen-'));
    try {
      const ruta = path.join(dir, 'sintetica.db');
      construirSqliteSintetica(ruta, { computeDedupHash });
      const origen = leerOrigen(ruta);
      expect(origen.transactions).toHaveLength(TOTALES.transactions);
      expect(origen.accounts.map((c) => c.bank_ref)).toEqual(CUENTAS.map((c) => c.bank_ref));
      const primera = origen.transactions.find((t) => t.id === 1);
      expect(typeof primera.amount_cents).toBe('bigint');
      expect(primera.op_date).toBe('2026-01-10');
      expect(primera.recurrence_manual).toBe(false);
      expect(origen.transactions.find((t) => t.id === 2).recurrence_manual).toBe(true);
      expect(typeof primera.raw).toBe('string'); // JSON verbatim, sin reserializar
      // raw es nullable en el origen y NOT NULL en 0036: leerOrigen lo coalesce a '{}'.
      expect(origen.transactions.find((t) => t.id === 2).raw).toBe('{}');
      expect(origen.rules).toHaveLength(TOTALES.rules); // la inactiva también: filtra migrar()
      expect(origen.rules.find((r) => r.id === 3).active).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

async function crearOrigenSintetico(corromperHashDeTx = null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resumen-'));
  const ruta = path.join(dir, 'sintetica.db');
  construirSqliteSintetica(ruta, { computeDedupHash, corromperHashDeTx });
  const origen = leerOrigen(ruta);
  await rm(dir, { recursive: true, force: true });
  return origen;
}

describe('resumenOrigen y compararResumenes', () => {
  it('agrega conteos, sumas cuenta·mes, grupos, estados y fechas', async () => {
    const resumen = resumenOrigen(await crearOrigenSintetico());
    expect(resumen.conteos.finance_transactions).toBe(TOTALES.transactions);
    expect(resumen.conteos.finance_rules).toBe(TOTALES.rulesActivas); // solo activas: es lo que migrará
    expect(resumen.sumasCuentaMes.get('00490001512345678901|2026-01'))
      .toBe(SUMAS_CUENTA_MES['00490001512345678901']['2026-01']);
    expect(resumen.sumasCuentaMes.get('EFECTIVO|2026-02')).toBe(SUMAS_CUENTA_MES.EFECTIVO['2026-02']);
    expect(resumen.grupos.size).toBe(TOTALES.gruposTransferencia);
    // La clave es el UUID CANÓNICO, no el crudo del origen: es la única forma
    // que puede casar con la de resumenDestino (Postgres canonicaliza al ::uuid).
    expect(resumen.grupos.get(GRUPO_TRASPASO_CANONICO)).toEqual({ patas: 2, suma: 0n });
    expect(resumen.grupos.get(GRUPO_TRASPASO)).toBeUndefined();
    expect(Object.fromEntries(resumen.estados)).toEqual(TOTALES.estados);
    expect(resumen.fechaMin).toBe(TOTALES.fechaMin);
    expect(resumen.fechaMax).toBe(TOTALES.fechaMax);
  });
  it('una comparación idéntica es OK y una rota señala la línea', async () => {
    const origen = await crearOrigenSintetico();
    const a = resumenOrigen(origen);
    expect(compararResumenes(a, resumenOrigen(origen)).ok).toBe(true);
    const b = resumenOrigen(origen);
    b.grupos.set(GRUPO_TRASPASO_CANONICO, { patas: 2, suma: 5n });
    const rota = compararResumenes(a, b);
    expect(rota.ok).toBe(false);
    expect(rota.lineas.filter((l) => !l.ok).map((l) => l.etiqueta))
      .toContain(`grupo ${GRUPO_TRASPASO_CANONICO} (patas y suma)`);
  });
  it('una pata huérfana del origen NO rompe la comparación', async () => {
    const origen = await crearOrigenSintetico();
    const resumen = resumenOrigen(origen);
    expect(resumen.grupos.get(GRUPO_HUERFANO)).toEqual({ patas: 1, suma: -7500n });
    const comparacion = compararResumenes(resumen, resumenOrigen(origen));
    expect(comparacion.ok).toBe(true);
    expect(comparacion.lineas.find((l) => l.etiqueta === `grupo ${GRUPO_HUERFANO} (patas y suma)`).ok)
      .toBe(true);
  });
});

describe('verificarHashes', () => {
  it('recalcula la muestra y descarta prefijos y amex', async () => {
    expect(verificarHashes(await crearOrigenSintetico(), computeDedupHash))
      .toMatchObject({ comprobados: TOTALES.hashesComprobables,
        descartados: TOTALES.hashesDescartados, noMuestreados: 0, discrepancias: [] });
  });
  it('detecta un hash corrupto', async () => {
    const resultado = verificarHashes(await crearOrigenSintetico(2), computeDedupHash);
    expect(resultado.discrepancias).toHaveLength(1);
    expect(resultado.discrepancias[0].id).toBe(2);
  });
  it('sin opciones verifica TODO (no muestrea en silencio: por defecto muestra = Infinity)', async () => {
    const origen = await crearOrigenSintetico();
    const resultado = verificarHashes(origen, computeDedupHash);
    expect(resultado.comprobados + resultado.descartados).toBe(origen.transactions.length);
    expect(resultado.noMuestreados).toBe(0);
  });
  it('con muestra finita deja el resto sin comprobar en noMuestreados, no lo calla', async () => {
    const resultado = verificarHashes(await crearOrigenSintetico(), computeDedupHash, { muestra: 2 });
    expect(resultado).toEqual({ comprobados: 2, descartados: TOTALES.hashesDescartados,
      noMuestreados: TOTALES.hashesComprobables - 2, discrepancias: [] });
  });
});

describe('validarOrigen', () => {
  it('la muestra íntegra no tiene ningún problema', async () => {
    expect(validarOrigen(await crearOrigenSintetico())).toEqual([]);
  });
  it('detecta doble raíz transferencia, concepto larguísimo y banco desconocido', async () => {
    const origen = await crearOrigenSintetico();
    origen.categories.push({ id: 99, name: 'Traspasos duplicados', parent_id: null, kind: 'transferencia' });
    origen.transactions[0].concept = 'X'.repeat(501);
    origen.accounts[0].bank = 'bancoinventado';
    expect(validarOrigen(origen)).toEqual([
      '2 categoría(s) raíz de tipo «transferencia» en el origen; el destino admite exactamente una (índice único parcial de 0036).',
      '1 transacción(es) con concept de más de 500 caracteres (ids: 1); el destino lo limita con CHECK.',
      'Cuenta 1 («Cuenta Común») con bank «bancoinventado» fuera del vocabulario del origen (caixabank, deutsche_bank, openbank, amex, efectivo, inversion, manual).'
    ]);
  });
  it('detecta categorías duplicadas bajo el mismo padre tras normalizar el nombre', async () => {
    const origen = await crearOrigenSintetico();
    // id 2 «Suministros» ya cuelga de parent_id=1: esta duplica ese mismo padre
    // y solo difiere en acentos/mayúsculas/espacios, que normText igual normaliza.
    origen.categories.push({ id: 100, name: '  suministros  ', parent_id: 1, kind: 'gasto' });
    expect(validarOrigen(origen)).toEqual([
      '2 categoría(s) duplicada(s) bajo el mismo padre tras normalizar el nombre (ids: 2, 100); el destino tiene UNIQUE NULLS NOT DISTINCT (household_id, parent_id, name).'
    ]);
  });
  it('detecta reglas activas con pattern NULL, vacío o solo blancos', async () => {
    const origen = await crearOrigenSintetico();
    origen.rules[0].pattern = '   ';
    expect(validarOrigen(origen)).toEqual([
      '1 regla(s) activa(s) con pattern vacío o solo blancos (ids: 1); el destino exige un patrón no vacío (CHECK de 0036).'
    ]);
  });
  it('detecta lotes con filename NULL, vacío o solo blancos', async () => {
    const origen = await crearOrigenSintetico();
    origen.importBatches[0].filename = '';
    expect(validarOrigen(origen)).toEqual([
      '1 lote(s) con filename vacío o solo blancos (ids: 1); el destino exige un filename no vacío (CHECK de 0036).'
    ]);
  });
});

describe('avisosOrigen y renderInforme', () => {
  it('avisa de todo lo que el destino no conserva, sin bloquear', async () => {
    expect(avisosOrigen(await crearOrigenSintetico())).toEqual([
      '1 regla(s) inactiva(s) del origen no se migran (el esquema destino no conserva reglas apagadas).',
      '1 regla(s) activa(s) con code_common fuera de codigo_norma43 pierden ese filtro (columna sin equivalente en destino).',
      'El orden manual del árbol de categorías (categories.sort_order) no se conserva: el destino ordena por nombre.',
      'La procedencia de las reglas aprendidas (rules.learned_from_id) no se conserva: el destino solo guarda origin.',
      `1 grupo(s) de transferencia del origen no netean 0 (patas huérfanas, spec §9.3; se migran tal cual): ${GRUPO_HUERFANO} (patas=1, suma=-7500).`
    ]);
  });
  it('el informe contiene las secciones obligatorias y el resultado', async () => {
    const resumen = resumenOrigen(await crearOrigenSintetico());
    const texto = renderInforme({
      modo: 'real', hogar: 'hogar-prueba', rutaSqlite: '/tmp/finanzas.db',
      copia: { destino: '/home/abf/copias-home-finance/finanzas-2026-08-31T10-00-00-000Z.db', sha256: 'a'.repeat(64) },
      comparacion: compararResumenes(resumen, resumen),
      hashes: { comprobados: TOTALES.hashesComprobables, descartados: TOTALES.hashesDescartados, noMuestreados: 0, discrepancias: [] },
      avisos: ['un aviso'], motivoAborto: null, ahora: new Date('2026-08-31T10:00:00Z')
    });
    for (const seccion of ['## Copia de seguridad (PASO 0)', '## Conteos por tabla',
      '## Sumas de amount_cents por cuenta y mes', '## Grupos de transferencia',
      '## Distribución de estados', '## Rango de fechas',
      '## Verificación cruzada de dedup_hash', '## Avisos']) {
      expect(texto).toContain(seccion);
    }
    expect(texto).toContain('/home/abf/copias-home-finance/finanzas-2026-08-31T10-00-00-000Z.db');
    expect(texto).toContain('a'.repeat(64));
    expect(texto).toContain('no muestreados (fuera de la muestra pedida): 0');
    expect(texto).not.toContain('## Aborto');
    expect(texto).toContain('Resultado: OK');
  });
  it('sin comparación (aborto temprano) el informe dice FALLO y explica el motivo', () => {
    const texto = renderInforme({
      modo: 'real', hogar: 'h', rutaSqlite: 'x', copia: null, comparacion: null,
      hashes: { comprobados: 5, descartados: 0, noMuestreados: 0, discrepancias: [{ id: 2, esperado: 'a', recalculado: 'b' }] },
      avisos: [], motivoAborto: 'El hogar «h» ya tiene 42 filas de finanzas; aborto.',
      ahora: new Date('2026-08-31T10:00:00Z')
    });
    expect(texto).toContain('## Aborto');
    expect(texto).toContain('El hogar «h» ya tiene 42 filas de finanzas; aborto.');
    expect(texto).toContain('## Copia de seguridad (PASO 0)');
    expect(texto).toContain('(no se hizo copia en esta ejecución)');
    expect(texto).toContain('Resultado: FALLO');
  });
});
