import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { importarModuloTs } from './cargar-ts.mjs';
import { construirSqliteSintetica, CUENTAS, TOTALES } from './home-finance-sintetica.mjs';
import { ErrorDeUso, hacerCopiaSeguridad, leerOrigen, normText, parseArgs } from './migrar-home-finance.mjs';

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
