// ETL única de home-finance (SQLite) → casa-clara (Postgres, esquema 0036).
// Runbook: docs/runbooks/migracion-home-finance.md. Se ejecuta con `node` a
// pelo por conexión DIRECTA (5432) del propietario, como las migraciones.
// PASO 0 innegociable: copia de seguridad datada del .db FUERA de ambos repos.
// Imports EXACTOS de esta tarea: `pnpm lint` aplica @typescript-eslint/no-unused-vars
// como error también a los .mjs, así que cada tarea añade solo lo que estrena.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class ErrorDeUso extends Error {}

const USO = `Uso: node scripts/migrar-home-finance.mjs \\
  --sqlite <ruta finanzas.db> --database-url <postgresql://…> --household <slug> \\
  [--backup-dir <dir>] [--dry-run] [--verify-only] [--force-empty-check]`;

export function parseArgs(argv) {
  const opciones = {
    sqlite: null, databaseUrl: null, household: null,
    backupDir: path.join(os.homedir(), 'copias-home-finance'),
    dryRun: false, verifyOnly: false, forceEmptyCheck: false
  };
  const conValor = { '--sqlite': 'sqlite', '--database-url': 'databaseUrl', '--household': 'household', '--backup-dir': 'backupDir' };
  const banderas = { '--dry-run': 'dryRun', '--verify-only': 'verifyOnly', '--force-empty-check': 'forceEmptyCheck' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in conValor) {
      const valor = argv[i + 1];
      if (!valor || valor.startsWith('--')) throw new ErrorDeUso(`${arg} necesita un valor.\n${USO}`);
      opciones[conValor[arg]] = valor;
      i += 1;
    } else if (arg in banderas) {
      opciones[banderas[arg]] = true;
    } else {
      throw new ErrorDeUso(`Argumento desconocido: ${arg}.\n${USO}`);
    }
  }
  for (const [bandera, clave] of [['--sqlite', 'sqlite'], ['--database-url', 'databaseUrl'], ['--household', 'household']]) {
    if (!opciones[clave]) throw new ErrorDeUso(`Falta ${bandera}.\n${USO}`);
  }
  if (opciones.dryRun && opciones.verifyOnly) throw new ErrorDeUso(`--dry-run y --verify-only son excluyentes.\n${USO}`);
  return opciones;
}

// Réplica EXACTA de backend/app/money.py::norm_text del origen, congelada a
// propósito: lo migrado debe casar con los alias que el origen escribió.
export function normText(valor) {
  const sinMarcas = valor.normalize('NFKD').replace(/\p{M}+/gu, '');
  return sinMarcas.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** «Fuera de ambos repos» hecho comprobable: fuera de CUALQUIER repo git. */
export async function estaDentroDeUnRepo(dir) {
  let actual = path.resolve(dir);
  for (;;) {
    try {
      await access(path.join(actual, '.git'));
      return true;
    } catch {
      const padre = path.dirname(actual);
      if (padre === actual) return false;
      actual = padre;
    }
  }
}

export async function hacerCopiaSeguridad(rutaSqlite, backupDir, ahora = new Date()) {
  if (await estaDentroDeUnRepo(backupDir)) {
    throw new Error(`El directorio de copias ${backupDir} está dentro de un repositorio git; la copia de seguridad debe vivir fuera de ambos repos.`);
  }
  await mkdir(backupDir, { recursive: true });
  const sello = ahora.toISOString().replace(/[:.]/g, '-');
  const destino = path.join(backupDir, `finanzas-${sello}.db`);
  await copyFile(rutaSqlite, destino, constants.COPYFILE_EXCL);
  const [origen, copia] = await Promise.all([readFile(rutaSqlite), readFile(destino)]);
  const sha256 = createHash('sha256').update(origen).digest('hex');
  if (sha256 !== createHash('sha256').update(copia).digest('hex')) {
    throw new Error('La copia de seguridad no coincide con el original (sha256 distinto).');
  }
  return { destino, sha256 };
}

export function leerOrigen(rutaSqlite) {
  const db = new DatabaseSync(rutaSqlite, { readOnly: true });
  try {
    const todo = (sql) => {
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true); // céntimos SIEMPRE bigint, nunca Number
      return stmt.all();
    };
    const n = (v) => (v === null ? null : Number(v));
    return {
      accounts: todo('SELECT id, name, bank, kind, owner, bank_ref, owner_aliases, transfer_refs FROM accounts ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), owner_aliases: f.owner_aliases ?? '[]', transfer_refs: f.transfer_refs ?? '[]' })),
      categories: todo('SELECT id, name, parent_id, kind FROM categories ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), parent_id: n(f.parent_id) })),
      rules: todo('SELECT id, match_type, pattern, code_common, category_id, origin, priority, active FROM rules ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), category_id: n(f.category_id), priority: n(f.priority), active: f.active === 1n })),
      importBatches: todo('SELECT id, filename, bank, imported_at, new_count, dup_count FROM import_batches ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), new_count: n(f.new_count), dup_count: n(f.dup_count) })),
      // `raw` es nullable en el origen (models.py:74) y en 0036 la columna es
      // `jsonb NOT NULL DEFAULT '{}'` con CHECK de objeto: se coalesce AQUÍ, una
      // sola vez, igual que owner_aliases/transfer_refs (resolución canónica 8).
      transactions: todo(`SELECT id, account_id, batch_id, op_date, value_date, concept, provider,
          amount_cents, balance_cents, code_common, code_own, category_id, status,
          transfer_group_id, dedup_hash, recurrence, recurrence_manual, bank_category, raw
          FROM transactions ORDER BY id`)
        .map((f) => ({ ...f, id: n(f.id), account_id: n(f.account_id), batch_id: n(f.batch_id),
          category_id: n(f.category_id), recurrence_manual: f.recurrence_manual === 1n,
          raw: f.raw ?? '{}' })),
      providerAliases: todo('SELECT id, provider_norm, alias FROM provider_aliases ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id) })),
      events: todo('SELECT id, name FROM events ORDER BY id').map((f) => ({ ...f, id: n(f.id) })),
      transactionEvents: todo('SELECT id, transaction_id, event_id FROM transaction_events ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), transaction_id: n(f.transaction_id), event_id: n(f.event_id) })),
      eventRules: todo('SELECT id, provider_norm, concept_norm, category_id, event_id FROM event_rules ORDER BY id')
        .map((f) => ({ ...f, id: n(f.id), category_id: n(f.category_id), event_id: n(f.event_id) }))
    };
  } finally {
    db.close();
  }
}

/** Tablas destino cuyo conteo verifica el informe (0036, sin la de grants). */
export const TABLAS_DESTINO = [
  'finance_accounts', 'finance_categories', 'finance_rules', 'finance_import_batches',
  'finance_transactions', 'finance_provider_aliases', 'finance_events',
  'finance_transaction_events', 'finance_event_rules'
];

export function resumenOrigen(origen) {
  const cuentasPorId = new Map(origen.accounts.map((c) => [c.id, c]));
  const sumasCuentaMes = new Map();
  const grupos = new Map();
  const estados = new Map();
  let fechaMin = null;
  let fechaMax = null;
  for (const tx of origen.transactions) {
    const clave = `${cuentasPorId.get(tx.account_id).bank_ref}|${tx.op_date.slice(0, 7)}`;
    sumasCuentaMes.set(clave, (sumasCuentaMes.get(clave) ?? 0n) + tx.amount_cents);
    estados.set(tx.status, (estados.get(tx.status) ?? 0) + 1);
    if (tx.transfer_group_id) {
      const g = grupos.get(tx.transfer_group_id) ?? { patas: 0, suma: 0n };
      g.patas += 1;
      g.suma += tx.amount_cents;
      grupos.set(tx.transfer_group_id, g);
    }
    if (fechaMin === null || tx.op_date < fechaMin) fechaMin = tx.op_date;
    if (fechaMax === null || tx.op_date > fechaMax) fechaMax = tx.op_date;
  }
  return {
    conteos: {
      finance_accounts: origen.accounts.length,
      finance_categories: origen.categories.length,
      finance_rules: origen.rules.filter((r) => r.active).length,
      finance_import_batches: origen.importBatches.length,
      finance_transactions: origen.transactions.length,
      finance_provider_aliases: origen.providerAliases.length,
      finance_events: origen.events.length,
      finance_transaction_events: origen.transactionEvents.length,
      finance_event_rules: origen.eventRules.length
    },
    sumasCuentaMes, grupos, estados, fechaMin, fechaMax
  };
}

/** Todo lo que el destino NO conserva, dicho en voz alta. Ningún aviso bloquea:
 *  el informe tiene que poder decir «Resultado: OK» y aun así declarar qué se
 *  pierde, en vez de callarse pérdidas que el usuario vería luego en la UI. */
export function avisosOrigen(origen) {
  const avisos = [];
  const inactivas = origen.rules.filter((r) => !r.active).length;
  if (inactivas > 0) avisos.push(`${inactivas} regla(s) inactiva(s) del origen no se migran (el esquema destino no conserva reglas apagadas).`);
  const conCodigo = origen.rules.filter((r) => r.active && r.code_common !== null && r.match_type !== 'codigo_norma43').length;
  if (conCodigo > 0) avisos.push(`${conCodigo} regla(s) activa(s) con code_common fuera de codigo_norma43 pierden ese filtro (columna sin equivalente en destino).`);
  // Estas dos son incondicionales: el destino no tiene columna equivalente, así
  // que la pérdida ocurre SIEMPRE (categories.sort_order y rules.learned_from_id
  // existen en models.py:27 y :80 y leerOrigen ni los trae).
  avisos.push('El orden manual del árbol de categorías (categories.sort_order) no se conserva: el destino ordena por nombre.');
  avisos.push('La procedencia de las reglas aprendidas (rules.learned_from_id) no se conserva: el destino solo guarda origin.');
  // Invariante «cada grupo netea 0» (spec §9.3): se INFORMA, no se exige. El
  // origen admite patas huérfanas (transfers.py::orphan_legs) y migrarlas es lo fiel.
  const gruposRotos = [...resumenOrigen(origen).grupos.entries()]
    .filter(([, g]) => g.suma !== 0n)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  if (gruposRotos.length > 0) {
    const lista = gruposRotos.map(([id, g]) => `${id} (patas=${g.patas}, suma=${g.suma})`).join('; ');
    avisos.push(`${gruposRotos.length} grupo(s) de transferencia del origen no netean 0 (patas huérfanas, spec §9.3; se migran tal cual): ${lista}.`);
  }
  return avisos;
}

/** Vocabularios del origen y del destino, en un solo sitio: los usan
 *  `validarOrigen` (tarea 4) y el mapeo de bancos de `migrar()` (tarea 5). */
export const BANCOS_CUENTA_ORIGEN = {
  caixabank: 'caixabank', deutsche_bank: 'deutsche_bank', openbank: 'openbank', amex: 'amex',
  // Cuentas virtuales del origen: en 0036 `finance_accounts.bank` es NULL
  // (resolución canónica 6 del doc de interfaces).
  efectivo: null, inversion: null, manual: null
};
export const BANCOS_LOTE_DESTINO = ['caixabank', 'deutsche_bank', 'openbank', 'amex', 'manual'];
export const ESTADOS_DESTINO = ['pendiente', 'sugerida_regla', 'sugerida_agente', 'confirmada'];
export const CLASES_CUENTA_DESTINO = ['comun', 'personal', 'inversion'];
export const CLASES_CATEGORIA_DESTINO = ['gasto', 'ingreso', 'transferencia'];
export const TIPOS_REGLA_DESTINO = ['proveedor_exacto', 'concepto_contiene', 'codigo_norma43'];
export const ORIGENES_REGLA_DESTINO = ['manual', 'agente'];

/** Invariantes que 0036 impone y el origen NO garantiza, comprobados ANTES de
 *  abrir la transacción: mejor una lista legible en el informe que un error
 *  crudo de `pg` a mitad de escritura. Orden de las comprobaciones fijo. */
export function validarOrigen(origen) {
  const problemas = [];
  const raices = origen.categories.filter((c) => c.parent_id === null && c.kind === 'transferencia');
  if (raices.length !== 1) {
    problemas.push(`${raices.length} categoría(s) raíz de tipo «transferencia» en el origen; el destino admite exactamente una (índice único parcial de 0036).`);
  }
  const porId = new Map(origen.categories.map((c) => [c.id, c]));
  const nietas = origen.categories.filter((c) => c.parent_id !== null && (porId.get(c.parent_id)?.parent_id ?? null) !== null);
  if (nietas.length > 0) {
    problemas.push(`${nietas.length} categoría(s) de tercer nivel (ids: ${nietas.map((c) => c.id).join(', ')}); el destino solo admite árbol de 2 niveles (trigger de 0036).`);
  }
  const largos = origen.transactions.filter((t) => t.concept.length > 500);
  if (largos.length > 0) {
    problemas.push(`${largos.length} transacción(es) con concept de más de 500 caracteres (ids: ${largos.map((t) => t.id).join(', ')}); el destino lo limita con CHECK.`);
  }
  for (const t of origen.transactions) {
    if (!ESTADOS_DESTINO.includes(t.status)) {
      problemas.push(`Transacción ${t.id} con status «${t.status}» fuera del vocabulario del destino (${ESTADOS_DESTINO.join(', ')}).`);
    }
  }
  for (const c of origen.accounts) {
    if (!CLASES_CUENTA_DESTINO.includes(c.kind)) {
      problemas.push(`Cuenta ${c.id} («${c.name}») con kind «${c.kind}» fuera del vocabulario del destino (${CLASES_CUENTA_DESTINO.join(', ')}).`);
    }
  }
  for (const c of origen.accounts) {
    if (!(c.bank in BANCOS_CUENTA_ORIGEN)) {
      problemas.push(`Cuenta ${c.id} («${c.name}») con bank «${c.bank}» fuera del vocabulario del origen (${Object.keys(BANCOS_CUENTA_ORIGEN).join(', ')}).`);
    }
  }
  for (const b of origen.importBatches) {
    if (!BANCOS_LOTE_DESTINO.includes(b.bank)) {
      problemas.push(`Lote ${b.id} («${b.filename}») con bank «${b.bank}» fuera del vocabulario del destino (${BANCOS_LOTE_DESTINO.join(', ')}).`);
    }
  }
  for (const c of origen.categories) {
    if (!CLASES_CATEGORIA_DESTINO.includes(c.kind)) {
      problemas.push(`Categoría ${c.id} («${c.name}») con kind «${c.kind}» fuera del vocabulario del destino (${CLASES_CATEGORIA_DESTINO.join(', ')}).`);
    }
  }
  for (const r of origen.rules.filter((x) => x.active)) {
    if (!TIPOS_REGLA_DESTINO.includes(r.match_type)) {
      problemas.push(`Regla ${r.id} con match_type «${r.match_type}» fuera del vocabulario del destino (${TIPOS_REGLA_DESTINO.join(', ')}).`);
    }
    if (!ORIGENES_REGLA_DESTINO.includes(r.origin)) {
      problemas.push(`Regla ${r.id} con origin «${r.origin}» fuera del vocabulario del destino (${ORIGENES_REGLA_DESTINO.join(', ')}).`);
    }
  }
  // Resolución del coordinador (fase 3): tres invariantes más que 0036 exige con
  // CHECK/UNIQUE y el origen no garantiza. Bloquean, igual que los de arriba.
  const clavePorPadreYNombre = new Map();
  for (const c of origen.categories) {
    const clave = `${c.parent_id}|${normText(c.name)}`;
    const lista = clavePorPadreYNombre.get(clave) ?? [];
    lista.push(c);
    clavePorPadreYNombre.set(clave, lista);
  }
  const categoriasDuplicadas = [...clavePorPadreYNombre.values()].filter((lista) => lista.length > 1).flat();
  if (categoriasDuplicadas.length > 0) {
    const ids = categoriasDuplicadas.map((c) => c.id).sort((x, y) => x - y);
    problemas.push(`${categoriasDuplicadas.length} categoría(s) duplicada(s) bajo el mismo padre tras normalizar el nombre (ids: ${ids.join(', ')}); el destino tiene UNIQUE NULLS NOT DISTINCT (household_id, parent_id, name).`);
  }
  const patronesVacios = origen.rules.filter((r) => r.active && (r.pattern === null || r.pattern.trim() === ''));
  if (patronesVacios.length > 0) {
    problemas.push(`${patronesVacios.length} regla(s) activa(s) con pattern vacío o solo blancos (ids: ${patronesVacios.map((r) => r.id).join(', ')}); el destino exige un patrón no vacío (CHECK de 0036).`);
  }
  const lotesSinNombre = origen.importBatches.filter((b) => b.filename === null || b.filename.trim() === '');
  if (lotesSinNombre.length > 0) {
    problemas.push(`${lotesSinNombre.length} lote(s) con filename vacío o solo blancos (ids: ${lotesSinNombre.map((b) => b.id).join(', ')}); el destino exige un filename no vacío (CHECK de 0036).`);
  }
  return problemas;
}

export function compararResumenes(a, b) {
  const lineas = [];
  const anotar = (seccion, etiqueta, ok, detalle) => lineas.push({ seccion, etiqueta, ok, detalle });
  for (const tabla of Object.keys(a.conteos)) {
    const real = b.conteos[tabla] ?? 0;
    anotar('conteos', tabla, real === a.conteos[tabla], `origen=${a.conteos[tabla]} destino=${real}`);
  }
  for (const clave of [...new Set([...a.sumasCuentaMes.keys(), ...b.sumasCuentaMes.keys()])].sort()) {
    const x = a.sumasCuentaMes.get(clave) ?? 0n;
    const y = b.sumasCuentaMes.get(clave) ?? 0n;
    anotar('sumas', clave, x === y, `origen=${x} destino=${y}`);
  }
  anotar('grupos', 'total de grupos', a.grupos.size === b.grupos.size, `origen=${a.grupos.size} destino=${b.grupos.size}`);
  for (const grupo of [...new Set([...a.grupos.keys(), ...b.grupos.keys()])].sort()) {
    const x = a.grupos.get(grupo) ?? { patas: 0, suma: 0n };
    const y = b.grupos.get(grupo) ?? { patas: 0, suma: 0n };
    // SOLO origen↔destino. «Cada grupo netea 0» NO se exige aquí: el origen
    // tiene patas huérfanas legítimas (transfers.py::orphan_legs) y exigirlo
    // haría fallar una migración fiel. Ese invariante va a avisosOrigen.
    anotar('grupos', `grupo ${grupo} (patas y suma)`,
      x.patas === y.patas && x.suma === y.suma,
      `origen patas=${x.patas} suma=${x.suma}; destino patas=${y.patas} suma=${y.suma}`);
  }
  for (const estado of [...new Set([...a.estados.keys(), ...b.estados.keys()])].sort()) {
    const x = a.estados.get(estado) ?? 0;
    const y = b.estados.get(estado) ?? 0;
    anotar('estados', estado, x === y, `origen=${x} destino=${y}`);
  }
  anotar('fechas', 'op_date min/max', a.fechaMin === b.fechaMin && a.fechaMax === b.fechaMax,
    `origen=${a.fechaMin}…${a.fechaMax} destino=${b.fechaMin}…${b.fechaMax}`);
  return { ok: lineas.every((l) => l.ok), lineas };
}

// Resolución del coordinador (fase 3): `verificarHashes` NO muestrea en
// silencio. Por defecto (`muestra = Infinity`) verifica TODA transacción
// comprobable; solo si se pide una muestra explícita queda algo sin comprobar,
// y eso se cuenta en `noMuestreados` (no se calla). La Task 6 llama con
// `{ muestra: Infinity }`.
export function verificarHashes(origen, computeDedupHash, { muestra = Infinity } = {}) {
  const cuentasPorId = new Map(origen.accounts.map((c) => [c.id, c]));
  const esSha256 = /^[0-9a-f]{64}$/;
  const discrepancias = [];
  let comprobados = 0;
  let descartados = 0;
  let noMuestreados = 0;
  for (const tx of origen.transactions) {
    const cuenta = cuentasPorId.get(tx.account_id);
    // Amex lleva dedup_ref (columna Referencia) que el origen no persiste en
    // la tabla; los prefijos manual-/cashpair-/invmirror- no son sha256.
    if (cuenta.bank === 'amex' || !esSha256.test(tx.dedup_hash)) {
      descartados += 1;
      continue;
    }
    if (comprobados >= muestra) {
      noMuestreados += 1;
      continue;
    }
    const recalculado = computeDedupHash({
      bankRef: cuenta.bank_ref, opDate: tx.op_date, amountCents: tx.amount_cents,
      concept: tx.concept, balanceCents: tx.balance_cents, dedupRef: null
    });
    comprobados += 1;
    if (recalculado !== tx.dedup_hash) discrepancias.push({ id: tx.id, esperado: tx.dedup_hash, recalculado });
  }
  return { comprobados, descartados, noMuestreados, discrepancias };
}

export function renderInforme({ modo, hogar, rutaSqlite, copia, comparacion, hashes, avisos,
  motivoAborto = null, ahora = new Date() }) {
  const ok = motivoAborto === null && hashes.discrepancias.length === 0
    && comparacion !== null && comparacion.ok;
  const marca = (bien) => (bien ? '✓' : '✗');
  const l = ['# Informe de verificación — migración home-finance → casa-clara', '',
    `- Fecha: ${ahora.toISOString()}`, `- Modo: ${modo}`, `- Origen: ${rutaSqlite}`,
    `- Hogar destino: ${hogar}`, ''];
  if (motivoAborto !== null) {
    l.push('## Aborto', '', `La ejecución se interrumpió: ${motivoAborto}`, '');
  }
  // La copia del PASO 0 es la garantía frente al riesgo «única copia de la base
  // origen» (spec §13): su ruta y su sha256 viven en el informe, que se guarda,
  // no solo en la consola, que se pierde al cerrar la terminal.
  l.push('## Copia de seguridad (PASO 0)', '');
  l.push(copia === null
    ? `- (no se hizo copia en esta ejecución${modo === 'verify-only' ? ': --verify-only no escribe' : ''})`
    : `- fichero: ${copia.destino}\n- sha256: ${copia.sha256}`);
  l.push('');
  for (const [titulo, clave] of [
    ['Conteos por tabla', 'conteos'],
    ['Sumas de amount_cents por cuenta y mes', 'sumas'],
    ['Grupos de transferencia', 'grupos'],
    ['Distribución de estados', 'estados'],
    ['Rango de fechas', 'fechas']
  ]) {
    l.push(`## ${titulo}`, '');
    if (comparacion === null) {
      l.push('(sin datos: la migración abortó antes de escribir en la base destino)', '');
      continue;
    }
    for (const linea of comparacion.lineas.filter((x) => x.seccion === clave)) {
      l.push(`- ${marca(linea.ok)} ${linea.etiqueta}: ${linea.detalle}`);
    }
    l.push('');
  }
  l.push('## Verificación cruzada de dedup_hash', '',
    `- comprobados: ${hashes.comprobados}`,
    `- descartados (amex u otros bancos sin hash comparable): ${hashes.descartados}`,
    `- no muestreados (fuera de la muestra pedida): ${hashes.noMuestreados}`);
  if (hashes.discrepancias.length === 0) l.push('- ✓ sin discrepancias');
  else for (const d of hashes.discrepancias) l.push(`- ✗ transacción origen ${d.id}: almacenado ${d.esperado} ≠ recalculado ${d.recalculado}`);
  l.push('', '## Avisos', '', ...(avisos.length ? avisos.map((a) => `- ${a}`) : ['- (ninguno)']));
  l.push('', `Resultado: ${ok ? 'OK' : 'FALLO'}`, '');
  return l.join('\n');
}

const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `provider_norm`: cadena vacía (o ausente) → NULL, cualquier otro valor →
 *  normText(). La comparten dos sitios: las transacciones (normalizando
 *  `provider`) y `finance_event_rules` (coalesciendo su propio `provider_norm`,
 *  que en el origen es NOT NULL y usa '' como centinela de «sin proveedor» —
 *  resolución del coordinador: misma función auxiliar en los dos sitios).
 *  Aplicar normText() a un valor ya normalizado es inocuo (la función es
 *  idempotente), así que reutilizarla aquí no altera lo que ya venía limpio. */
export function providerNormOSuNulo(valor) {
  return valor ? normText(valor) : null;
}

/** `finance_accounts.bank`: los cuatro bancos reales pasan; las cuentas
 *  virtuales del origen (efectivo/inversion/manual) van a NULL; cualquier otro
 *  valor es un dato que nadie previó y la migración se para AQUÍ, con nombre y
 *  apellidos, en vez de reventar con un CHECK de Postgres a mitad de escritura. */
export function bancoDeCuenta(cuenta) {
  if (!(cuenta.bank in BANCOS_CUENTA_ORIGEN)) {
    throw new Error(`La cuenta ${cuenta.id} («${cuenta.name}») tiene bank «${cuenta.bank}», que no está contemplado (${Object.keys(BANCOS_CUENTA_ORIGEN).join(', ')}). Amplía BANCOS_CUENTA_ORIGEN o corrige el origen antes de migrar.`);
  }
  return BANCOS_CUENTA_ORIGEN[cuenta.bank];
}

/** `finance_import_batches.bank`: el destino admite los cuatro bancos y
 *  además 'manual' (resolución canónica 6), así que se pasa tal cual. */
export function bancoDeLote(lote) {
  if (!BANCOS_LOTE_DESTINO.includes(lote.bank)) {
    throw new Error(`El lote ${lote.id} («${lote.filename}») tiene bank «${lote.bank}», que el destino no admite (${BANCOS_LOTE_DESTINO.join(', ')}).`);
  }
  return lote.bank;
}

/** Inserta el origen completo bajo el hogar dado. SIEMPRE dentro de una
 *  transacción abierta por quien llama (una sola transacción, spec §9.2). */
export async function migrar(client, householdId, origen) {
  const mapas = { cuentas: new Map(), categorias: new Map(), lotes: new Map(), transacciones: new Map(), eventos: new Map() };
  for (const c of origen.accounts) {
    const id = randomUUID();
    mapas.cuentas.set(c.id, id);
    await client.query(
      `INSERT INTO app.finance_accounts (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
      [householdId, id, c.name, bancoDeCuenta(c), c.kind, c.owner, c.bank_ref, c.owner_aliases, c.transfer_refs]);
  }
  const padres = origen.categories.filter((c) => c.parent_id === null);
  const hijas = origen.categories.filter((c) => c.parent_id !== null);
  for (const c of [...padres, ...hijas]) {
    const id = randomUUID();
    mapas.categorias.set(c.id, id);
    await client.query(
      `INSERT INTO app.finance_categories (household_id, id, parent_id, name, kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [householdId, id, c.parent_id === null ? null : mapas.categorias.get(c.parent_id), c.name, c.kind]);
  }
  for (const r of origen.rules) {
    if (!r.active) continue; // el destino no conserva reglas apagadas (aviso en el informe)
    await client.query(
      `INSERT INTO app.finance_rules (household_id, id, rule_type, pattern, category_id, priority, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [householdId, randomUUID(), r.match_type, r.pattern, mapas.categorias.get(r.category_id), r.priority, r.origin]);
  }
  for (const b of origen.importBatches) {
    const id = randomUUID();
    mapas.lotes.set(b.id, id);
    await client.query(
      `INSERT INTO app.finance_import_batches (household_id, id, filename, bank, imported_at, new_count, dup_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [householdId, id, b.filename, bancoDeLote(b), b.imported_at, b.new_count, b.dup_count]);
  }
  for (const t of origen.transactions) {
    if (t.transfer_group_id !== null && !esUuid.test(t.transfer_group_id)) {
      throw new Error(`La transacción ${t.id} tiene transfer_group_id no-UUID: ${t.transfer_group_id}`);
    }
    const id = randomUUID();
    mapas.transacciones.set(t.id, id);
    await client.query(
      `INSERT INTO app.finance_transactions (household_id, id, account_id, batch_id, op_date, value_date,
         concept, provider, provider_norm, amount_cents, balance_cents, code_common, code_own,
         category_id, status, transfer_group_id, dedup_hash, recurrence, recurrence_manual,
         bank_category, raw, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, 'EUR')`,
      [householdId, id, mapas.cuentas.get(t.account_id), mapas.lotes.get(t.batch_id),
        t.op_date, t.value_date, t.concept, t.provider, providerNormOSuNulo(t.provider),
        String(t.amount_cents), t.balance_cents === null ? null : String(t.balance_cents),
        t.code_common, t.code_own, t.category_id === null ? null : mapas.categorias.get(t.category_id),
        t.status, t.transfer_group_id, t.dedup_hash, t.recurrence, t.recurrence_manual,
        // `leerOrigen` ya coalesce raw a '{}'; el ?? es la red por si migrar()
        // recibe un origen construido a mano (la columna es NOT NULL en 0036).
        t.bank_category, t.raw ?? '{}']);
  }
  for (const a of origen.providerAliases) {
    await client.query(
      `INSERT INTO app.finance_provider_aliases (household_id, id, provider_norm, display)
       VALUES ($1, $2, $3, $4)`,
      [householdId, randomUUID(), a.provider_norm, a.alias]);
  }
  for (const e of origen.events) {
    const id = randomUUID();
    mapas.eventos.set(e.id, id);
    await client.query(
      `INSERT INTO app.finance_events (household_id, id, name) VALUES ($1, $2, $3)`,
      [householdId, id, e.name]);
  }
  for (const v of origen.transactionEvents) {
    await client.query(
      `INSERT INTO app.finance_transaction_events (household_id, id, transaction_id, event_id)
       VALUES ($1, $2, $3, $4)`,
      [householdId, randomUUID(), mapas.transacciones.get(v.transaction_id), mapas.eventos.get(v.event_id)]);
  }
  for (const v of origen.eventRules) {
    await client.query(
      `INSERT INTO app.finance_event_rules (household_id, id, provider_norm, concept_norm, category_id, event_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [householdId, randomUUID(), providerNormOSuNulo(v.provider_norm), v.concept_norm,
        v.category_id === null ? null : mapas.categorias.get(v.category_id), mapas.eventos.get(v.event_id)]);
  }
}

export async function resumenDestino(client, householdId) {
  const conteos = {};
  for (const tabla of TABLAS_DESTINO) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM app.${tabla} WHERE household_id = $1`, [householdId]);
    conteos[tabla] = rows[0].n;
  }
  const sumas = await client.query(
    `SELECT a.bank_ref, to_char(t.op_date, 'YYYY-MM') AS mes, sum(t.amount_cents)::text AS suma
       FROM app.finance_transactions t
       JOIN app.finance_accounts a ON a.household_id = t.household_id AND a.id = t.account_id
      WHERE t.household_id = $1 GROUP BY 1, 2`, [householdId]);
  const gruposQ = await client.query(
    `SELECT transfer_group_id::text AS grupo, count(*)::int AS patas, sum(amount_cents)::text AS suma
       FROM app.finance_transactions
      WHERE household_id = $1 AND transfer_group_id IS NOT NULL GROUP BY 1`, [householdId]);
  const estadosQ = await client.query(
    `SELECT status::text AS estado, count(*)::int AS n
       FROM app.finance_transactions WHERE household_id = $1 GROUP BY 1`, [householdId]);
  const fechas = await client.query(
    `SELECT min(op_date)::text AS min, max(op_date)::text AS max
       FROM app.finance_transactions WHERE household_id = $1`, [householdId]);
  return {
    conteos,
    sumasCuentaMes: new Map(sumas.rows.map((f) => [`${f.bank_ref}|${f.mes}`, BigInt(f.suma)])),
    grupos: new Map(gruposQ.rows.map((f) => [f.grupo, { patas: f.patas, suma: BigInt(f.suma) }])),
    estados: new Map(estadosQ.rows.map((f) => [f.estado, f.n])),
    fechaMin: fechas.rows[0].min,
    fechaMax: fechas.rows[0].max
  };
}
