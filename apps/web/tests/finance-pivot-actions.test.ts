import { describe, expect, it, vi } from 'vitest';

import type { FinanceWritePayloadV1 } from '@housekeeper/contracts';

/**
 * `$lib/offline/queue-command` es el único punto que toca red/almacén: se
 * sustituye ENTERO por un doble de pruebas (patrón ya usado en
 * `finance-grant-dispatch.test.ts` para `OptimisticActions`). `pivot-actions.ts`
 * lo importa con el alias `$lib/...`, así que se intercepta con ese mismo
 * especificador — resuelve al mismo módulo que la ruta relativa de abajo.
 */
const { queueCommandMock } = vi.hoisted(() => ({
  queueCommandMock: vi.fn<
    (envelope: Record<string, unknown>, options?: unknown) => Promise<{ outcome: string; message: string }>
  >()
}));
vi.mock('$lib/offline/queue-command', () => ({ queueCommand: queueCommandMock }));

import {
  acuse,
  assignConceptRecurrence,
  assignConceptToCategory,
  assignConceptToEvent,
  assignTransactionsToEvent,
  buildTxCategoryIndex,
  bulkByIds,
  COLA,
  conceptTargetOf,
  createEventPayload,
  investTransaction,
  planCategoryUndo,
  sendAll,
  sendFinanceCommand,
  undoEventAssign,
  updateTransactionRecurrence,
  type SendOutcome,
  type TxCategoryRow
} from '../src/lib/finance/pivot-actions';
import type { SelectableItem } from '../src/lib/finance/pivot-state';

const item = (partial: Partial<SelectableItem>): SelectableItem =>
  ({ key: 'k', parentKey: '', provider: 'Prov', concept: null, count: 1, ...partial });

describe('constructores de payloads (kinds canónicos del doc de interfaces)', () => {
  it('conceptTargetOf: categoría entera en una sola llamada, o proveedor/concepto', () => {
    expect(conceptTargetOf(item({ provider: '', categoryId: 'c1' }))).toEqual({ categoryId: 'c1' });
    expect(conceptTargetOf(item({ provider: 'Mercadona', concept: 'Compra' }))).toEqual({
      provider: 'Mercadona',
      concept: 'Compra'
    });
    expect(conceptTargetOf(item({ provider: 'Mercadona' }))).toEqual({ provider: 'Mercadona' });
  });

  it('asignar a evento existente, a evento nuevo y deshacer (eventId null)', () => {
    expect(assignConceptToEvent({ categoryId: 'c1' }, { eventId: 'e1' })).toEqual({
      kind: 'finance.event.assignConcept',
      categoryId: 'c1',
      eventId: 'e1'
    });
    expect(assignConceptToEvent({ provider: 'P' }, { newEventName: 'Boda' })).toEqual({
      kind: 'finance.event.assignConcept',
      provider: 'P',
      newEventName: 'Boda'
    });
    expect(undoEventAssign({ provider: 'P' })).toEqual({
      kind: 'finance.event.assignConcept',
      provider: 'P',
      eventId: null
    });
  });

  it('recategorizar concepto y naturaleza por concepto', () => {
    expect(assignConceptToCategory('Mercadona', 'Compra', 'c2')).toEqual({
      kind: 'finance.category.assignConcept',
      provider: 'Mercadona',
      concept: 'Compra',
      categoryId: 'c2'
    });
    expect(assignConceptRecurrence({ categoryId: 'c1' }, 'recurrente')).toEqual({
      kind: 'finance.transactions.assignConceptRecurrence',
      categoryId: 'c1',
      recurrence: 'recurrente'
    });
  });

  it('acciones por ids exactos: bulk usa transactionIds (nunca txIds) y status es opcional', () => {
    expect(bulkByIds(['t1', 't2'], { categoryId: 'c1' })).toEqual({
      kind: 'finance.transactions.bulk',
      transactionIds: ['t1', 't2'],
      categoryId: 'c1'
    });
    expect(bulkByIds(['t1'], { categoryId: 'c1', status: 'confirmada' })).toEqual({
      kind: 'finance.transactions.bulk',
      transactionIds: ['t1'],
      categoryId: 'c1',
      status: 'confirmada'
    });
  });

  it('añadir/quitar evento por ids exactos va por finance.event.assignTransactions', () => {
    expect(assignTransactionsToEvent('e1', ['t1', 't2'], 'add')).toEqual({
      kind: 'finance.event.assignTransactions',
      eventId: 'e1',
      transactionIds: ['t1', 't2'],
      action: 'add'
    });
    expect(assignTransactionsToEvent('e1', ['t1'], 'remove')).toEqual({
      kind: 'finance.event.assignTransactions',
      eventId: 'e1',
      transactionIds: ['t1'],
      action: 'remove'
    });
  });

  it('naturaleza de una hoja suelta va por finance.transaction.update', () => {
    expect(updateTransactionRecurrence('t1', 'extraordinario')).toEqual({
      kind: 'finance.transaction.update',
      transactionId: 't1',
      recurrence: 'extraordinario'
    });
  });

  it('invertir usa transactionId (nunca txId)', () => {
    expect(investTransaction('t1', 'a1')).toEqual({
      kind: 'finance.transaction.invest',
      transactionId: 't1',
      accountId: 'a1'
    });
  });

  // Desviación del texto del brief (Step 2), anotada en el informe: la firma
  // real (resolución R5 del coordinador) es `createEventPayload(name, id?)`,
  // no `createEventPayload(id, name)` — el id lo genera el cliente por
  // defecto para poder encadenar «crear evento → asignarle movimientos» sin
  // esperar al ACK.
  it('crear evento: id de cliente por defecto (uuid v4) y un id inyectado se respeta', () => {
    const generated = createEventPayload('Boda');
    expect(generated.name).toBe('Boda');
    expect(generated.kind).toBe('finance.event.create');
    expect(generated.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    expect(createEventPayload('Boda', 'ev-1')).toEqual({
      kind: 'finance.event.create',
      id: 'ev-1',
      name: 'Boda'
    });
  });
});

describe('plan de deshacer una recategorización', () => {
  // Desviación del texto del brief (Step 2), anotada en el informe:
  // `buildTxCategoryIndex` indexa FILAS PLANAS `{ id, categoryId }` (resolución
  // del coordinador), no grupos `{ catId, movs }` — es la forma mínima de una
  // fila de movimiento del servidor, sin importar su DTO completo.
  const rows: TxCategoryRow[] = [
    { id: 't1', categoryId: 'c1' },
    { id: 't2', categoryId: 'c1' },
    { id: 't3', categoryId: 'c2' },
    { id: 't4', categoryId: null }
  ];
  const txCat = buildTxCategoryIndex(rows);

  it('indexa tx → categoría previa', () => {
    expect(txCat.get('t1')).toBe('c1');
    expect(txCat.get('t4')).toBeNull();
  });

  // F6-I1: re-asignar el concepto NO revierte la regla creada por el drop (el
  // servidor siempre inserta una nueva); solo devuelve los movimientos.
  it('categoría previa única → volver a asignar el concepto', () => {
    const movIdsByKey = new Map([['/cat:X/prov:P', ['t1', 't2']]]);
    const plan = planCategoryUndo([item({ key: '/cat:X/prov:P', provider: 'P', count: 2 })], movIdsByKey, txCat);
    expect(plan.reassignments).toEqual([{ provider: 'P', concept: null, categoryId: 'c1' }]);
    expect(plan.bulkRestores).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it('previas mixtas → restauración por ids agrupada (transactionIds); las previas null se saltan y se cuentan', () => {
    const movIdsByKey = new Map([['/cat:X/prov:P', ['t1', 't3', 't4']]]);
    const plan = planCategoryUndo([item({ key: '/cat:X/prov:P', provider: 'P', count: 3 })], movIdsByKey, txCat);
    expect(plan.reassignments).toEqual([]);
    expect(plan.bulkRestores).toEqual([
      { transactionIds: ['t1'], categoryId: 'c1' },
      { transactionIds: ['t3'], categoryId: 'c2' }
    ]);
    expect(plan.skipped).toBe(1);
  });

  it('los ítems categoría/subcategoría no entran en el plan (el drop tampoco los procesa)', () => {
    const plan = planCategoryUndo([item({ provider: '', categoryId: 'c9' })], new Map(), txCat);
    expect(plan.reassignments).toEqual([]);
    expect(plan.bulkRestores).toEqual([]);
  });

  it('todas las categorías previas eran null (el caso más habitual: recategorizar lo sin clasificar) → plan sin nada que restaurar', () => {
    // Regresión I2: si el llamador ofreciera «Deshacer» aquí, `runCategoryUndo`
    // mandaría un lote vacío y el toast diría «No hay nada que asignar»
    // (acuse con sent===0), engañoso tras pulsar «Deshacer». El plan en sí ya
    // deja claro que no hay reasignaciones ni restauraciones posibles — el
    // llamador debe leer justo esto (`reassignments`/`bulkRestores` vacíos)
    // para decidir NO ofrecer el botón.
    const movIdsByKey = new Map([['/cat:X/prov:P', ['t4']]]);
    const plan = planCategoryUndo([item({ key: '/cat:X/prov:P', provider: 'P', count: 1 })], movIdsByKey, txCat);
    expect(plan.reassignments).toEqual([]);
    expect(plan.bulkRestores).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('mezcla de un nodo de concepto y una hoja de movimiento: el nodo revierte el concepto, la hoja (provider vacío) va por ids', () => {
    // El nodo de concepto (provider 'P', categoría previa única t1/t2 → c1) debe
    // ir a `reassignments`. La hoja de movimiento (provider '', igual que
    // construye `toMovementSelectable`) tiene también categoría previa única
    // (t3 → c2), pero la guarda `item.provider` debe impedir que acabe en
    // `reassignments` — de lo contrario saldría `{ provider: '' }`, que el
    // esquema del servidor rechaza, y crearía una regla por proveedor donde
    // el usuario solo quería deshacer un movimiento suelto.
    const movIdsByKey = new Map([['/cat:X/prov:P', ['t1', 't2']]]);
    const items = [
      item({ key: '/cat:X/prov:P', provider: 'P', count: 2 }),
      item({ key: '/cat:X/mov:t3', provider: '', txId: 't3', count: 1 })
    ];
    const plan = planCategoryUndo(items, movIdsByKey, txCat);
    expect(plan.reassignments).toEqual([{ provider: 'P', concept: null, categoryId: 'c1' }]);
    expect(plan.bulkRestores).toEqual([{ transactionIds: ['t3'], categoryId: 'c2' }]);
    expect(plan.skipped).toBe(0);
  });
});

describe('sendFinanceCommand envía el envelope de Finanzas por la cola (R6)', () => {
  it('la cola recibe aggregateType finance, el hogar y el payload íntegro', async () => {
    queueCommandMock.mockReset();
    queueCommandMock.mockResolvedValue({ outcome: 'synced', message: 'Guardado ✓' });
    const payload: FinanceWritePayloadV1 = {
      kind: 'finance.transaction.invest',
      transactionId: 't1',
      accountId: 'a1'
    };

    const result = await sendFinanceCommand('h1', payload);

    expect(result).toEqual({ outcome: 'synced', message: 'Guardado ✓' });
    expect(queueCommandMock).toHaveBeenCalledTimes(1);
    const [envelope] = queueCommandMock.mock.calls[0];
    expect(envelope).toMatchObject({ householdId: 'h1', aggregateType: 'finance', payload });
  });
});

describe('sendAll y acuse (R14): plan de envío en cadena de la barra de acciones', () => {
  const PAYLOADS: FinanceWritePayloadV1[] = [
    { kind: 'finance.transaction.invest', transactionId: 't1', accountId: 'a1' },
    { kind: 'finance.transaction.invest', transactionId: 't2', accountId: 'a1' },
    { kind: 'finance.transaction.invest', transactionId: 't3', accountId: 'a1' }
  ];

  it('cadena mixta synced+queued invalida cc:finance una vez y devuelve la nota de cola', async () => {
    const invalidated: string[] = [];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'synced', message: 'Guardado ✓' })
      .mockResolvedValueOnce({ outcome: 'queued', message: COLA });

    const result = await sendAll('h1', PAYLOADS.slice(0, 2), {
      send,
      invalidate: async (token: string) => {
        invalidated.push(token);
      }
    });

    expect(result).toEqual({ ok: true, sent: 2, queued: true, message: COLA });
    expect(invalidated).toEqual(['cc:finance']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('todo synced (sin nada en cola) no lleva mensaje propio: acuse usa el resumen del llamador', async () => {
    const invalidated: string[] = [];
    const send = vi.fn().mockResolvedValue({ outcome: 'synced', message: 'Guardado ✓' });

    const result = await sendAll('h1', PAYLOADS.slice(0, 2), {
      send,
      invalidate: async (token: string) => {
        invalidated.push(token);
      }
    });

    expect(result).toEqual({ ok: true, sent: 2, queued: false, message: '' });
    expect(invalidated).toEqual(['cc:finance']);
  });

  it('un rechazo en el segundo comando corta la cadena y no invalida', async () => {
    const invalidated: string[] = [];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'synced', message: 'Guardado ✓' })
      .mockResolvedValueOnce({ outcome: 'rejected', message: 'No se pudo guardar el cambio.' });

    const result = await sendAll('h1', PAYLOADS, {
      send,
      invalidate: async (token: string) => {
        invalidated.push(token);
      }
    });

    expect(result).toEqual({ ok: false, sent: 3, queued: false, message: 'No se pudo guardar el cambio.' });
    expect(invalidated).toEqual([]);
    // Cortó: el tercer comando de la lista no llegó a enviarse.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('un conflicto en el segundo comando corta la cadena igual que un rechazo, y no invalida', async () => {
    const invalidated: string[] = [];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'synced', message: 'Guardado ✓' })
      .mockResolvedValueOnce({ outcome: 'conflict', message: 'El movimiento cambió en otro sitio.' });

    const result = await sendAll('h1', PAYLOADS, {
      send,
      invalidate: async (token: string) => {
        invalidated.push(token);
      }
    });

    expect(result).toEqual({ ok: false, sent: 3, queued: false, message: 'El movimiento cambió en otro sitio.' });
    expect(invalidated).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('F6-I5: onProgress publica (nº de comando, total) antes de cada envío, y no se llama con el lote vacío', async () => {
    const pasos: [number, number][] = [];
    const send = vi.fn().mockResolvedValue({ outcome: 'synced', message: 'Guardado ✓' });
    const invalidate = async () => {};

    await sendAll('h1', PAYLOADS, { send, invalidate, onProgress: (done, total) => pasos.push([done, total]) });
    expect(pasos).toEqual([
      [1, 3],
      [2, 3],
      [3, 3]
    ]);

    pasos.length = 0;
    await sendAll('h1', [], { send, invalidate, onProgress: (done, total) => pasos.push([done, total]) });
    expect(pasos).toEqual([]);
  });

  it('F6-I5: un corte deja de publicar progreso (los comandos posteriores no se envían)', async () => {
    const pasos: number[] = [];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'synced', message: 'Guardado ✓' })
      .mockResolvedValueOnce({ outcome: 'rejected', message: 'No se pudo guardar el cambio.' });

    await sendAll('h1', PAYLOADS, {
      send,
      invalidate: async () => {},
      onProgress: (done) => pasos.push(done)
    });

    expect(pasos).toEqual([1, 2]);
  });

  it('lista vacía no envía nada, y acuse devuelve el copy de "vacío"', async () => {
    const invalidated: string[] = [];
    const send = vi.fn();

    const result = await sendAll('h1', [], {
      send,
      invalidate: async (token: string) => {
        invalidated.push(token);
      }
    });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(0);
    expect(invalidated).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(acuse(result, '3 movimientos actualizados')).toBe('No hay nada que asignar');
    expect(acuse(result, '3 movimientos actualizados', 'Nada seleccionado')).toBe('Nada seleccionado');
  });

  it('acuse: éxito sin cola usa solo el resumen; con cola, el resumen seguido de la nota; con rechazo, el mensaje del resultado', () => {
    const ok: SendOutcome = { ok: true, sent: 2, queued: false, message: '' };
    expect(acuse(ok, '2 movimientos recategorizados')).toBe('2 movimientos recategorizados');

    // El usuario sin conexión no debe perder lo que trae el `resumen` (avisos
    // de reglas conservadas, movimientos saltados…): `acuse` lo antepone a la
    // nota de cola en vez de sustituirlo por ella.
    const queued: SendOutcome = { ok: true, sent: 2, queued: true, message: COLA };
    expect(acuse(queued, '2 movimientos recategorizados')).toBe(`2 movimientos recategorizados · ${COLA}`);

    const rejected: SendOutcome = { ok: false, sent: 2, queued: false, message: 'No se pudo guardar el cambio.' };
    expect(acuse(rejected, '2 movimientos recategorizados')).toBe('No se pudo guardar el cambio.');
  });
});
