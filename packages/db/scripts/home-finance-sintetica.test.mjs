import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDedupHash } from '../../server/src/finance/dedup-hash.ts';
import { construirSqliteSintetica, CUENTAS, TOTALES, TRANSACCIONES } from './home-finance-sintetica.mjs';

const hashDe = (id) => {
  const t = TRANSACCIONES.find((x) => x.id === id);
  const cuenta = CUENTAS.find((c) => c.id === t.account_id);
  return computeDedupHash({
    bankRef: cuenta.bank_ref, opDate: t.op_date, amountCents: t.amount_cents,
    concept: t.concept, balanceCents: t.balance_cents, dedupRef: t.dedup_ref ?? null
  });
};

describe('home-finance-sintetica', () => {
  let dir;
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-sintetica-')); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('construye la base con los conteos prometidos y hashes recomputables', () => {
    const ruta = path.join(dir, 'finanzas-sintetica.db');
    construirSqliteSintetica(ruta, { computeDedupHash });
    const db = new DatabaseSync(ruta, { readOnly: true });
    try {
      const contar = (t) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
      expect(contar('accounts')).toBe(TOTALES.accounts);
      expect(contar('categories')).toBe(TOTALES.categories);
      expect(contar('rules')).toBe(TOTALES.rules);
      expect(contar('import_batches')).toBe(TOTALES.importBatches);
      expect(contar('transactions')).toBe(TOTALES.transactions);
      expect(contar('provider_aliases')).toBe(TOTALES.providerAliases);
      expect(contar('events')).toBe(TOTALES.events);
      expect(contar('transaction_events')).toBe(TOTALES.transactionEvents);
      expect(contar('event_rules')).toBe(TOTALES.eventRules);
      expect(Number(db.prepare('SELECT count(*) AS n FROM rules WHERE active = 1').get().n))
        .toBe(TOTALES.rulesActivas);
      expect(db.prepare('SELECT dedup_hash FROM transactions WHERE id = 1').get().dedup_hash)
        .toBe(hashDe(1));
      // Las formas raras del origen están presentes: cuentas virtuales y lote manual.
      // group_concat sin GROUP BY no es determinista si se ordena la fila-resultado
      // (una sola fila): se ordena en una subconsulta ANTES de agregar.
      expect(db.prepare(`
        SELECT group_concat(bank_ref, ',') AS refs FROM (
          SELECT bank_ref FROM accounts WHERE bank IN ('efectivo', 'inversion') ORDER BY id
        )
      `).get().refs).toBe('EFECTIVO,INV-SINTETICO');
      expect(Number(db.prepare("SELECT count(*) AS n FROM import_batches WHERE bank = 'manual'").get().n)).toBe(1);
      expect(Number(db.prepare('SELECT count(DISTINCT transfer_group_id) AS n FROM transactions WHERE transfer_group_id IS NOT NULL').get().n))
        .toBe(TOTALES.gruposTransferencia);
    } finally { db.close(); }
  });

  it('corromperHashDeTx cambia SOLO el hash pedido', () => {
    const ruta = path.join(dir, 'finanzas-corrupta.db');
    construirSqliteSintetica(ruta, { computeDedupHash, corromperHashDeTx: 2 });
    const db = new DatabaseSync(ruta, { readOnly: true });
    try {
      const fila = db.prepare('SELECT dedup_hash FROM transactions WHERE id = 2').get();
      expect(fila.dedup_hash).not.toBe(hashDe(2));
      expect(fila.dedup_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(db.prepare('SELECT dedup_hash FROM transactions WHERE id = 1').get().dedup_hash)
        .toBe(hashDe(1));
    } finally { db.close(); }
  });
});
