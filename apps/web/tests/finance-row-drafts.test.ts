import { describe, expect, it } from 'vitest';

import { draftedRow, releaseDraft, restoreDraft, withDraft, type RowDrafts } from '../src/lib/finance/row-drafts';

/**
 * [FASE 5 · despacho de cierre, F5-I5 + T13-R1..R4] El borrador por fila dejó
 * de ser cosa de Ajustes: Movimientos construía `eventIds` desde la FOTO DEL
 * SERVIDOR (`row.eventIds`) y, como con `queued` no hay `invalidate`, esa foto
 * no se refresca — marcar el evento A y luego el B mandaba `[B]` a secas y A
 * desaparecía al vaciarse la cola.
 *
 * La revisión de T13 pedía además tres cosas que el borrador de Ajustes no
 * hacía: revertir en el rechazo (R1), soltar en `settle` SOLO las claves que
 * llevaba ese comando (R2) y comparar contra el borrador, no contra la foto
 * vieja, al decidir si hay cambios (R3). Todo eso es bookkeeping puro, así que
 * vive aquí —y no en el componente— para poder probar el CICLO DE VIDA y no un
 * `spread` (R4).
 */
interface Fila {
  id: string;
  eventIds: string[];
  categoryId: string | null;
  name: string;
}

const FILA: Fila = { id: 'tx1', eventIds: [], categoryId: null, name: 'Recibo' };

/** Lo que hace `toggleEvent` en Movimientos, sin Svelte de por medio. */
function toggleEvent(
  row: Fila,
  drafts: RowDrafts<Fila>,
  eventId: string,
  add: boolean
): { enviado: Partial<Fila>; drafts: RowDrafts<Fila> } {
  const visible = draftedRow(row, drafts[row.id]);
  const eventIds = add ? [...visible.eventIds, eventId] : visible.eventIds.filter((id) => id !== eventId);
  return { enviado: { eventIds }, drafts: withDraft(drafts, row.id, { eventIds }) };
}

describe('borradores por fila: el ciclo de vida completo', () => {
  it('dos toggles seguidos acumulan los dos eventos, no solo el último', () => {
    let drafts: RowDrafts<Fila> = {};
    const primero = toggleEvent(FILA, drafts, 'a', true);
    drafts = primero.drafts;
    expect(primero.enviado).toEqual({ eventIds: ['a'] });

    // La foto del servidor sigue siendo la misma (`queued` no invalida nada):
    // sin borrador, este segundo comando mandaría `['b']` y borraría A.
    const segundo = toggleEvent(FILA, drafts, 'b', true);
    drafts = segundo.drafts;
    expect(segundo.enviado).toEqual({ eventIds: ['a', 'b'] });
    expect(draftedRow(FILA, drafts[FILA.id]).eventIds).toEqual(['a', 'b']);
  });

  it('quitar un evento parte también del borrador, no de la foto', () => {
    let drafts: RowDrafts<Fila> = {};
    drafts = toggleEvent(FILA, drafts, 'a', true).drafts;
    drafts = toggleEvent(FILA, drafts, 'b', true).drafts;
    const quitado = toggleEvent(FILA, drafts, 'a', false);
    expect(quitado.enviado).toEqual({ eventIds: ['b'] });
  });

  it('T13-R1: el rechazo devuelve el borrador al estado previo, no lo deja envenenado', () => {
    let drafts: RowDrafts<Fila> = {};
    drafts = withDraft(drafts, 'tx1', { name: 'Bueno' });
    const previo = drafts['tx1'];
    drafts = withDraft(drafts, 'tx1', { name: 'Rechazado' });
    expect(draftedRow(FILA, drafts['tx1']).name).toBe('Rechazado');

    drafts = restoreDraft(drafts, 'tx1', previo);
    expect(draftedRow(FILA, drafts['tx1']).name).toBe('Bueno');
  });

  it('T13-R1: si no había borrador previo, revertir lo deja como estaba: sin entrada', () => {
    let drafts: RowDrafts<Fila> = {};
    const previo = drafts['tx1'];
    drafts = withDraft(drafts, 'tx1', { name: 'Rechazado' });
    drafts = restoreDraft(drafts, 'tx1', previo);
    expect(drafts).toEqual({});
  });

  it('T13-R2: `settle` suelta SOLO las claves que llevaba ese comando', () => {
    let drafts: RowDrafts<Fila> = {};
    drafts = withDraft(drafts, 'tx1', { name: 'Nuevo nombre' });
    // Segundo comando, aún en vuelo, sobre otra clave de la misma fila.
    drafts = withDraft(drafts, 'tx1', { categoryId: 'cat-1' });

    // Llega el acuse del PRIMERO: si borrase el borrador entero se llevaría por
    // delante la categoría que todavía no ha viajado, y la siguiente edición
    // partiría de una foto que no la incluye.
    drafts = releaseDraft(drafts, 'tx1', { name: 'Nuevo nombre' });
    expect(drafts['tx1']).toEqual({ categoryId: 'cat-1' });

    drafts = releaseDraft(drafts, 'tx1', { categoryId: 'cat-1' });
    expect(drafts).toEqual({});
  });

  it('`settle` de una fila sin borrador no inventa una entrada vacía', () => {
    expect(releaseDraft<Fila>({}, 'tx1', { name: 'x' })).toEqual({});
  });

  it('T13-R3: la fila visible es foto + borrador + parche, en ese orden', () => {
    const drafts = withDraft<Fila>({}, 'tx1', { name: 'Editado' });
    expect(draftedRow(FILA, drafts['tx1'])).toMatchObject({ name: 'Editado', id: 'tx1' });
    // El parche del gesto en curso gana al borrador acumulado.
    expect(draftedRow(FILA, drafts['tx1'], { name: 'Más nuevo' }).name).toBe('Más nuevo');
    // Y ninguna de las tres capas se muta por el camino.
    expect(FILA.name).toBe('Recibo');
    expect(drafts['tx1']).toEqual({ name: 'Editado' });
  });

  it('los borradores de dos filas no se pisan', () => {
    let drafts: RowDrafts<Fila> = {};
    drafts = withDraft(drafts, 'tx1', { name: 'Uno' });
    drafts = withDraft(drafts, 'tx2', { name: 'Dos' });
    drafts = releaseDraft(drafts, 'tx1', { name: 'Uno' });
    expect(drafts).toEqual({ tx2: { name: 'Dos' } });
  });
});
