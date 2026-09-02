import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { importarModuloTs } from './cargar-ts.mjs';
import { construirSqliteSintetica, CUENTAS, GRUPO_HUERFANO, GRUPO_TRASPASO, GRUPO_TRASPASO_CANONICO, SUMAS_CUENTA_MES, TOTALES } from './home-finance-sintetica.mjs';
import { aUuid, avisosOrigen, bancoDeCuenta, bancoDeLote, compararResumenes, ErrorDeUso, hacerCopiaSeguridad, leerOrigen, mapear, normText, parseArgs, providerNormOSuNulo, renderInforme, resumenOrigen, validarOrigen, verificarHashes } from './migrar-home-finance.mjs';

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
      'MAYÚSCULAS y minúsculas MEZCLADAS',
      // Muestras de control (Task 99, punto 1): la clase \s de Python NO es la
      // de JavaScript. Ninguna de estas cuatro aparece en un extracto real,
      // pero el ETL tiene que casar con el dominio también en el borde.
      'AB', // NEL (U+0085): espacio para Python, no para JS
      'AB', // FS (U+001C): espacio para Python, no para JS
      '﻿CAFE', // BOM (U+FEFF): NO es espacio para Python; sobrevive
      ' A B　' // NBSP, EM SPACE, IDEOGRAPHIC SPACE: espacio en ambos
    ];
    for (const muestra of muestras) {
      expect(normText(muestra)).toBe(normTextDominio(muestra));
    }
  });

  // Expectativas literales (no dependen del dominio): si algún día el dominio
  // y el ETL divergieran a la vez de la misma manera, el test de arriba no lo
  // vería. Estas cuatro fijan el valor esperado con nombre y apellidos.
  it('la clase de espacio es la de Python en las cuatro muestras de control', () => {
    expect(normText('AB')).toBe('A B'); // NEL
    expect(normText('AB')).toBe('A B'); // FS
    expect(normText('﻿CAFE')).toBe('﻿CAFE'); // BOM sobrevive
    expect(normText(' A B　')).toBe('A B');
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

// Los tres abortos tempranos son lo que alguien leerá a las tantas si la
// migración se para: se comprueba que dicen lo que dicen, sin tocar Postgres.
describe('abortos tempranos de migrar()', () => {
  it('un banco de cuenta no contemplado para la migración con nombre y vocabulario', () => {
    expect(() => bancoDeCuenta({ id: 9, name: 'X', bank: 'revolut' })).toThrow(/revolut/);
    expect(() => bancoDeCuenta({ id: 9, name: 'X', bank: 'revolut' }))
      .toThrow(/La cuenta 9 \(«X»\).*caixabank, deutsche_bank, openbank, amex, efectivo, inversion, manual/s);
    // `in` recorría la cadena de prototipos: 'constructor' colaba y devolvía una función.
    expect(() => bancoDeCuenta({ id: 9, name: 'X', bank: 'constructor' })).toThrow(/constructor/);
    expect(bancoDeCuenta({ id: 1, name: 'Común', bank: 'caixabank' })).toBe('caixabank');
    expect(bancoDeCuenta({ id: 4, name: 'Efectivo', bank: 'efectivo' })).toBe(null);
  });
  it('un banco de lote que el destino no admite para la migración', () => {
    expect(() => bancoDeLote({ id: 3, filename: 'x.xls', bank: 'revolut' })).toThrow(/revolut/);
    expect(() => bancoDeLote({ id: 3, filename: 'x.xls', bank: 'revolut' }))
      .toThrow(/El lote 3 \(«x\.xls»\).*caixabank, deutsche_bank, openbank, amex, manual/s);
    expect(bancoDeLote({ id: 4, filename: 'manual', bank: 'manual' })).toBe('manual');
  });
  it('un transfer_group_id que no es un UUID para la migración', () => {
    expect(() => aUuid('esto-no-es-un-uuid', 42))
      .toThrow(/La transacción 42 tiene transfer_group_id no-UUID: esto-no-es-un-uuid/);
  });
});

describe('mapear (una referencia colgada no se escribe como NULL en silencio)', () => {
  it('traduce el id del origen al uuid del destino y deja pasar «sin referencia»', () => {
    const mapa = new Map([[1, 'a1b2c3d4-0000-4000-8000-000000000001']]);
    expect(mapear(mapa, 1, 'la categoría de la transacción 5')).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    expect(mapear(mapa, null, 'la categoría de la transacción 5')).toBe(null);
  });
  it('un id ausente del mapa aborta nombrando la etiqueta y el id', () => {
    const mapa = new Map([[1, 'a1b2c3d4-0000-4000-8000-000000000001']]);
    expect(() => mapear(mapa, 7, 'la categoría de la transacción 42'))
      .toThrow(/la categoría de la transacción 42/);
    expect(() => mapear(mapa, 7, 'la categoría de la transacción 42')).toThrow(/\b7\b/);
  });
});

describe('providerNormOSuNulo (un solo criterio para transacciones y reglas de evento)', () => {
  it('normaliza lo que trae contenido', () => {
    expect(providerNormOSuNulo('Farmacia Ñuñez')).toBe('FARMACIA NUNEZ');
    expect(providerNormOSuNulo('SUPERMERCADOS ACME')).toBe('SUPERMERCADOS ACME');
  });
  it('«sin proveedor» es NULL, y los blancos también son «sin proveedor»', () => {
    // '' no casaría con ningún finance_provider_aliases (CHECK de longitud ≥ 1
    // tras btrim): un provider de solo blancos tiene que ser NULL, no ''.
    expect(providerNormOSuNulo('')).toBe(null);
    expect(providerNormOSuNulo('   ')).toBe(null);
    expect(providerNormOSuNulo('\t \n ')).toBe(null);
    expect(providerNormOSuNulo(null)).toBe(null);
    expect(providerNormOSuNulo(undefined)).toBe(null);
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
  // Task 99, punto 3: sin la guarda, `cuentasPorId.get(tx.account_id).bank_ref`
  // lee una propiedad de `undefined` y revienta con un TypeError sin id ni
  // account_id — inservible para quien lea el fallo a las tantas.
  it('un account_id colgado lanza un Error con el id de la tx y el account_id, no un TypeError', async () => {
    const origen = await crearOrigenSintetico();
    origen.transactions[0].account_id = 999;
    let error;
    try {
      resumenOrigen(origen);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).toContain('1');
    expect(error.message).toContain('999');
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
  it('un bank que solo existe en la cadena de prototipos NO cuela por vocabulario', async () => {
    // `'constructor' in BANCOS_CUENTA_ORIGEN` es true: con `in` este banco
    // habría pasado la reja y `bancoDeCuenta` habría devuelto una función.
    const origen = await crearOrigenSintetico();
    origen.accounts[0].bank = 'constructor';
    expect(validarOrigen(origen)).toEqual([
      'Cuenta 1 («Cuenta Común») con bank «constructor» fuera del vocabulario del origen (caixabank, deutsche_bank, openbank, amex, efectivo, inversion, manual).'
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

  // Task 99, punto 2: 0036 exige `length(btrim(x)) BETWEEN 1 AND n` (o, para
  // bank_ref, «NULL o esa misma longitud») en estas columnas además de
  // pattern/filename (ya cubiertos arriba). Un caso por columna, uno por test,
  // origen mínimo mutado en un solo campo. concept_norm/provider_norm de
  // finance_event_rules y provider_norm de finance_transactions NO llevan CHECK
  // de blanco en 0036 (nullable, sin btrim): providerNormOSuNulo ya los
  // coalesce a NULL antes del INSERT, así que no hace falta validarlos aquí.
  it('detecta accounts.name en blanco', async () => {
    const origen = await crearOrigenSintetico();
    origen.accounts[0].name = '   ';
    expect(validarOrigen(origen)).toEqual(['accounts id=1: name en blanco (CHECK de 0036).']);
  });
  it('detecta accounts.bank_ref en blanco (cuando no es NULL)', async () => {
    const origen = await crearOrigenSintetico();
    origen.accounts[0].bank_ref = '   ';
    expect(validarOrigen(origen)).toEqual(['accounts id=1: bank_ref en blanco (CHECK de 0036).']);
  });
  it('detecta categories.name en blanco', async () => {
    const origen = await crearOrigenSintetico();
    origen.categories[1].name = '';
    expect(validarOrigen(origen)).toEqual(['categories id=2: name en blanco (CHECK de 0036).']);
  });
  it('detecta provider_aliases.provider_norm en blanco', async () => {
    const origen = await crearOrigenSintetico();
    origen.providerAliases[0].provider_norm = '   ';
    expect(validarOrigen(origen)).toEqual(['provider_aliases id=1: provider_norm en blanco (CHECK de 0036).']);
  });
  it('detecta provider_aliases.alias en blanco', async () => {
    const origen = await crearOrigenSintetico();
    origen.providerAliases[0].alias = '';
    expect(validarOrigen(origen)).toEqual(['provider_aliases id=1: alias en blanco (CHECK de 0036).']);
  });
  it('detecta events.name en blanco', async () => {
    const origen = await crearOrigenSintetico();
    origen.events[0].name = '   ';
    expect(validarOrigen(origen)).toEqual(['events id=1: name en blanco (CHECK de 0036).']);
  });
  it('detecta transactions.dedup_hash en blanco', async () => {
    const origen = await crearOrigenSintetico();
    origen.transactions[0].dedup_hash = '';
    expect(validarOrigen(origen)).toEqual(['transactions id=1: dedup_hash en blanco (CHECK de 0036).']);
  });

  // Task 99, punto 3: una transacción con account_id colgado (no existe en
  // accounts) es un error bloqueante, con nombre y apellidos, ANTES de tocar
  // la base — no un 23503 crudo de Postgres a mitad de INSERT.
  it('detecta transactions.account_id colgado (no existe en accounts)', async () => {
    const origen = await crearOrigenSintetico();
    origen.transactions[0].account_id = 999;
    expect(validarOrigen(origen)).toEqual([
      'transactions id=1: account_id 999 no existe en accounts.'
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
