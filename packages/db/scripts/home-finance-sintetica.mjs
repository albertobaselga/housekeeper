// SQLite SINTÉTICA con el MISMO esquema que el origen home-finance (DDL
// calcada de backend/app/models.py + columnas de ensure_schema). Solo datos
// inventados: con esto ensayan los tests del ETL sin acercarse a la base real.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { importarModuloTs, rutaDedupHash } from './cargar-ts.mjs';

export const DDL_ORIGEN = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL, bank VARCHAR(20) NOT NULL,
  kind VARCHAR(10) NOT NULL, owner VARCHAR(10) NOT NULL,
  bank_ref VARCHAR(34) NOT NULL UNIQUE, owner_aliases JSON, transfer_refs JSON
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY, name VARCHAR(60) NOT NULL,
  parent_id INTEGER REFERENCES categories(id), kind VARCHAR(15) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY, filename VARCHAR(255) NOT NULL, bank VARCHAR(20) NOT NULL,
  imported_at DATETIME NOT NULL, new_count INTEGER NOT NULL DEFAULT 0,
  dup_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  op_date DATE NOT NULL, value_date DATE, concept TEXT NOT NULL,
  provider VARCHAR(200) NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL,
  balance_cents INTEGER, code_common VARCHAR(2), code_own VARCHAR(3),
  category_id INTEGER REFERENCES categories(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pendiente', transfer_group_id VARCHAR(36),
  dedup_hash VARCHAR(64) NOT NULL UNIQUE, recurrence VARCHAR(15),
  recurrence_manual BOOLEAN NOT NULL DEFAULT 0, bank_category VARCHAR(120), raw JSON
);
CREATE TABLE rules (
  id INTEGER PRIMARY KEY, match_type VARCHAR(20) NOT NULL, pattern VARCHAR(200) NOT NULL,
  code_common VARCHAR(2), category_id INTEGER NOT NULL REFERENCES categories(id),
  origin VARCHAR(10) NOT NULL DEFAULT 'manual',
  learned_from_id INTEGER REFERENCES transactions(id),
  priority INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT 1
);
CREATE TABLE provider_aliases (
  id INTEGER PRIMARY KEY, provider_norm VARCHAR(200) NOT NULL UNIQUE,
  alias VARCHAR(120) NOT NULL
);
CREATE TABLE events (id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE);
CREATE TABLE transaction_events (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  UNIQUE (transaction_id, event_id)
);
CREATE TABLE event_rules (
  id INTEGER PRIMARY KEY, provider_norm VARCHAR(200) NOT NULL,
  concept_norm VARCHAR(300), category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE (provider_norm, concept_norm, category_id)
);
`;

export const GRUPO_TRASPASO = 'e7b8c9d0-1234-4abc-8def-000000000001';
export const GRUPO_INVERSION = 'e7b8c9d0-1234-4abc-8def-000000000002';
// Pata suelta: el origen las admite (transfers.py::orphan_legs). No es un error.
export const GRUPO_HUERFANO = 'e7b8c9d0-1234-4abc-8def-000000000003';

export const CUENTAS = [
  { id: 1, name: 'Cuenta Común', bank: 'caixabank', kind: 'comun', owner: 'familia', bank_ref: '00490001512345678901', owner_aliases: ['FAMILIA PRUEBA'], transfer_refs: [] },
  { id: 2, name: 'Cuenta Padre', bank: 'deutsche_bank', kind: 'personal', owner: 'padre', bank_ref: 'ES9100190020961234567890', owner_aliases: ['PADRE PRUEBA'], transfer_refs: [] },
  { id: 3, name: 'Tarjeta Amex', bank: 'amex', kind: 'personal', owner: 'padre', bank_ref: 'AMEX-SINTETICA-1001', owner_aliases: [], transfer_refs: [] },
  // Cuentas virtuales del origen: bank fuera del vocabulario del destino (→ NULL en 0036).
  { id: 4, name: 'Efectivo', bank: 'efectivo', kind: 'comun', owner: 'familia', bank_ref: 'EFECTIVO', owner_aliases: [], transfer_refs: [] },
  { id: 5, name: 'Fondo Sintético Indexado', bank: 'inversion', kind: 'inversion', owner: 'familia', bank_ref: 'INV-SINTETICO', owner_aliases: [], transfer_refs: ['REF-FONDO-01'] }
];

export const CATEGORIAS = [
  { id: 1, name: 'Vivienda', parent_id: null, kind: 'gasto', sort_order: 0 },
  { id: 2, name: 'Suministros', parent_id: 1, kind: 'gasto', sort_order: 0 },
  { id: 3, name: 'Alimentación', parent_id: null, kind: 'gasto', sort_order: 1 },
  { id: 4, name: 'Supermercado', parent_id: 3, kind: 'gasto', sort_order: 0 },
  { id: 5, name: 'Nómina', parent_id: null, kind: 'ingreso', sort_order: 2 },
  { id: 6, name: 'Transferencia interna', parent_id: null, kind: 'transferencia', sort_order: 3 }
];

export const REGLAS = [
  { id: 1, match_type: 'proveedor_exacto', pattern: 'SUPERMERCADOS ACME', code_common: null, category_id: 4, origin: 'manual', priority: 0, active: 1 },
  { id: 2, match_type: 'codigo_norma43', pattern: '03', code_common: '03', category_id: 5, origin: 'manual', priority: 0, active: 1 },
  { id: 3, match_type: 'concepto_contiene', pattern: 'LUZ', code_common: null, category_id: 2, origin: 'manual', priority: 5, active: 0 },
  { id: 4, match_type: 'proveedor_exacto', pattern: 'BAR PEPE SINTETICO', code_common: '02', category_id: 3, origin: 'agente', priority: 0, active: 1 }
];

export const LOTES = [
  { id: 1, filename: 'extracto-comun-enero.xls', bank: 'caixabank', imported_at: '2026-02-01 10:00:00', new_count: 3, dup_count: 0 },
  { id: 2, filename: 'amex-enero.xlsx', bank: 'amex', imported_at: '2026-02-02 10:30:00', new_count: 1, dup_count: 0 },
  { id: 3, filename: 'db-febrero.xls', bank: 'deutsche_bank', imported_at: '2026-03-02 09:00:00', new_count: 6, dup_count: 1 },
  // Lote de altas manuales: bank='manual', que el destino SÍ admite en lotes.
  { id: 4, filename: 'manual', bank: 'manual', imported_at: '2026-02-14 12:00:00', new_count: 2, dup_count: 0 }
];

// hash 'sha256' = lo calcula construirSqliteSintetica con computeDedupHash;
// cualquier otro valor se guarda literal (prefijos del origen).
export const TRANSACCIONES = [
  { id: 1, account_id: 1, batch_id: 1, op_date: '2026-01-10', value_date: '2026-01-11', concept: 'COMPRA SUPERMERCADOS ACME S.L. TARJETA 9999', provider: 'SUPERMERCADOS ACME', amount_cents: -2550n, balance_cents: 150000n, code_common: '01', code_own: 'TCR', category_id: 4, status: 'confirmada', transfer_group_id: null, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: 'Supermercados', raw: { Concepto: 'COMPRA SUPERMERCADOS ACME S.L.', Importe: '-25,50' } },
  { id: 2, account_id: 1, batch_id: 1, op_date: '2026-01-31', value_date: null, concept: 'NOMINA EMPRESA EJEMPLO SL', provider: 'EMPRESA EJEMPLO', amount_cents: 250000n, balance_cents: 400000n, code_common: '03', code_own: null, category_id: 5, status: 'confirmada', transfer_group_id: null, hash: 'sha256', recurrence: 'recurrente', recurrence_manual: 1, bank_category: null, raw: null },
  { id: 3, account_id: 1, batch_id: 1, op_date: '2026-02-05', value_date: null, concept: 'TRASPASO A CUENTA PADRE', provider: '', amount_cents: -50000n, balance_cents: 350000n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_TRASPASO, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 4, account_id: 2, batch_id: 3, op_date: '2026-02-05', value_date: null, concept: 'TRASPASO RECIBIDO DE CUENTA COMUN', provider: '', amount_cents: 50000n, balance_cents: 60000n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_TRASPASO, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  // 5 y 6: par de efectivo, ambas patas en la cuenta virtual Efectivo (cash.py:44-58);
  // el hash de la contrapartida es literalmente `cashpair-<hash del gasto>`.
  { id: 5, account_id: 4, batch_id: 4, op_date: '2026-02-14', value_date: null, concept: 'GASTO EN EFECTIVO FARMACIA', provider: 'Farmacia Ñuñez', amount_cents: -2000n, balance_cents: null, code_common: null, code_own: null, category_id: 3, status: 'confirmada', transfer_group_id: null, hash: 'manual-a1b2c3d4e5f60718', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 6, account_id: 4, batch_id: 4, op_date: '2026-02-14', value_date: null, concept: 'Contrapartida efectivo — GASTO EN EFECTIVO FARMACIA', provider: 'EFECTIVO', amount_cents: 2000n, balance_cents: null, code_common: null, code_own: null, category_id: 3, status: 'confirmada', transfer_group_id: null, hash: 'cashpair-manual-a1b2c3d4e5f60718', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 7, account_id: 3, batch_id: 2, op_date: '2026-01-20', value_date: null, concept: 'RESTAURANTE EJEMPLO MADRID', provider: 'RESTAURANTE EJEMPLO', amount_cents: -1234n, balance_cents: null, code_common: null, code_own: null, category_id: 3, status: 'sugerida_regla', transfer_group_id: null, hash: 'sha256', dedup_ref: 'REF-AMEX-0001', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 8, account_id: 2, batch_id: 3, op_date: '2026-02-20', value_date: null, concept: 'RECIBO LUZ ENERGIA EJEMPLO SL', provider: 'ENERGIA EJEMPLO', amount_cents: -6789n, balance_cents: 53211n, code_common: '05', code_own: null, category_id: null, status: 'pendiente', transfer_group_id: null, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  { id: 9, account_id: 2, batch_id: 3, op_date: '2026-03-01', value_date: null, concept: 'APORTACION FONDO REF-FONDO-01', provider: '', amount_cents: -10000n, balance_cents: 43211n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_INVERSION, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  // 10: espejo de inversión, en la cuenta virtual de inversión (investments.py:52-70).
  { id: 10, account_id: 5, batch_id: 3, op_date: '2026-03-01', value_date: null, concept: 'APORTACION FONDO ESPEJO', provider: '', amount_cents: 10000n, balance_cents: null, code_common: null, code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_INVERSION, hash: 'invmirror-c3d4e5f607182930', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null },
  // 11: pata huérfana (grupo de una sola pata, suma ≠ 0). El origen las tiene; migrarlas
  // tal cual es lo correcto, y la comparación de la tarea 4 NO debe tomarlo por un fallo.
  { id: 11, account_id: 2, batch_id: 3, op_date: '2026-03-05', value_date: null, concept: 'TRASPASO PENDIENTE DE PAREJA', provider: '', amount_cents: -7500n, balance_cents: 35711n, code_common: '04', code_own: null, category_id: 6, status: 'confirmada', transfer_group_id: GRUPO_HUERFANO, hash: 'sha256', recurrence: null, recurrence_manual: 0, bank_category: null, raw: null }
];

export const ALIAS = [{ id: 1, provider_norm: 'SUPERMERCADOS ACME', alias: 'Acme' }];
export const EVENTOS = [{ id: 1, name: 'Semana Santa Sintética 2026' }];
export const TRANSACCION_EVENTOS = [{ id: 1, transaction_id: 1, event_id: 1 }];
export const REGLAS_EVENTO = [
  { id: 1, provider_norm: 'SUPERMERCADOS ACME', concept_norm: null, category_id: null, event_id: 1 },
  { id: 2, provider_norm: '', concept_norm: null, category_id: 4, event_id: 1 }
];

// Números derivados de las constantes de arriba. NINGÚN test del plan repite
// estos valores como literal: todos los importan de aquí (una sola verdad).
export const TOTALES = {
  accounts: 5, categories: 6, rules: 4, rulesActivas: 3, importBatches: 4,
  transactions: 11, providerAliases: 1, events: 1, transactionEvents: 1, eventRules: 2,
  // comprobables = hash sha256 y cuenta no-amex: 1, 2, 3, 4, 8, 9, 11.
  // descartados = amex (7) + prefijos manual-/cashpair-/invmirror- (5, 6, 10).
  hashesComprobables: 7, hashesDescartados: 4, gruposTransferencia: 3,
  estados: { confirmada: 9, pendiente: 1, sugerida_regla: 1 },
  fechaMin: '2026-01-10', fechaMax: '2026-03-05'
};

export const SUMAS_CUENTA_MES = {
  '00490001512345678901': { '2026-01': 247450n, '2026-02': -50000n },
  ES9100190020961234567890: { '2026-02': 43211n, '2026-03': -17500n },
  'AMEX-SINTETICA-1001': { '2026-01': -1234n },
  EFECTIVO: { '2026-02': 0n },
  'INV-SINTETICO': { '2026-03': 10000n }
};

export function construirSqliteSintetica(ruta, { computeDedupHash, corromperHashDeTx = null }) {
  const db = new DatabaseSync(ruta);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(DDL_ORIGEN);
    const cuenta = db.prepare('INSERT INTO accounts (id, name, bank, kind, owner, bank_ref, owner_aliases, transfer_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const c of CUENTAS) cuenta.run(c.id, c.name, c.bank, c.kind, c.owner, c.bank_ref, JSON.stringify(c.owner_aliases), JSON.stringify(c.transfer_refs));
    const categoria = db.prepare('INSERT INTO categories (id, name, parent_id, kind, sort_order) VALUES (?, ?, ?, ?, ?)');
    for (const c of CATEGORIAS) categoria.run(c.id, c.name, c.parent_id, c.kind, c.sort_order);
    const lote = db.prepare('INSERT INTO import_batches (id, filename, bank, imported_at, new_count, dup_count) VALUES (?, ?, ?, ?, ?, ?)');
    for (const b of LOTES) lote.run(b.id, b.filename, b.bank, b.imported_at, b.new_count, b.dup_count);
    const transaccion = db.prepare(`INSERT INTO transactions
      (id, account_id, batch_id, op_date, value_date, concept, provider, amount_cents, balance_cents,
       code_common, code_own, category_id, status, transfer_group_id, dedup_hash, recurrence,
       recurrence_manual, bank_category, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of TRANSACCIONES) {
      const cuentaDeTx = CUENTAS.find((c) => c.id === t.account_id);
      let hash = t.hash === 'sha256'
        ? computeDedupHash({
            bankRef: cuentaDeTx.bank_ref, opDate: t.op_date, amountCents: t.amount_cents,
            concept: t.concept, balanceCents: t.balance_cents, dedupRef: t.dedup_ref ?? null
          })
        : t.hash;
      if (t.id === corromperHashDeTx) {
        hash = hash.startsWith('0') ? `1${hash.slice(1)}` : `0${hash.slice(1)}`;
      }
      transaccion.run(t.id, t.account_id, t.batch_id, t.op_date, t.value_date, t.concept, t.provider,
        t.amount_cents, t.balance_cents, t.code_common, t.code_own, t.category_id, t.status,
        t.transfer_group_id, hash, t.recurrence, t.recurrence_manual, t.bank_category,
        t.raw === null ? null : JSON.stringify(t.raw));
    }
    const regla = db.prepare('INSERT INTO rules (id, match_type, pattern, code_common, category_id, origin, learned_from_id, priority, active) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)');
    for (const r of REGLAS) regla.run(r.id, r.match_type, r.pattern, r.code_common, r.category_id, r.origin, r.priority, r.active);
    const alias = db.prepare('INSERT INTO provider_aliases (id, provider_norm, alias) VALUES (?, ?, ?)');
    for (const a of ALIAS) alias.run(a.id, a.provider_norm, a.alias);
    const evento = db.prepare('INSERT INTO events (id, name) VALUES (?, ?)');
    for (const e of EVENTOS) evento.run(e.id, e.name);
    const te = db.prepare('INSERT INTO transaction_events (id, transaction_id, event_id) VALUES (?, ?, ?)');
    for (const v of TRANSACCION_EVENTOS) te.run(v.id, v.transaction_id, v.event_id);
    const re = db.prepare('INSERT INTO event_rules (id, provider_norm, concept_norm, category_id, event_id) VALUES (?, ?, ?, ?, ?)');
    for (const v of REGLAS_EVENTO) re.run(v.id, v.provider_norm, v.concept_norm, v.category_id, v.event_id);
  } finally {
    db.close();
  }
}

const esEjecucionDirecta =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esEjecucionDirecta) {
  const destino = process.argv[2];
  if (!destino) {
    console.error('Uso: node scripts/home-finance-sintetica.mjs <ruta-salida.db>');
    process.exit(2);
  }
  const { computeDedupHash } = await importarModuloTs(rutaDedupHash);
  construirSqliteSintetica(destino, { computeDedupHash });
  console.log(`SQLite sintética escrita en ${destino} (${TOTALES.transactions} transacciones).`);
}
