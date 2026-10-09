import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandRejectedError, processSyncBatch } from '@housekeeper/server';
import { POST } from '../src/routes/api/v1/sync/+server';

/**
 * La ruta de sincronización valida la forma del LOTE y deja cada sobre a
 * `processSyncBatch`, que lo rechaza por separado sin tumbar a los demás. Aquí
 * solo importa ese reparto: el lote y sus rechazos uno a uno se prueban en
 * sync.integration.test.ts (paquete server), así que la base y el procesado
 * se sustituyen por dobles.
 *
 * El caso que lo motiva (revisión final de cupones, H1): un móvil con un
 * comando de un agregado que el servidor no conoce —el de un módulo nuevo,
 * tras volver a un despliegue anterior— no puede dejar atascados los del menú,
 * la compra o las finanzas que viajan en el mismo lote.
 */
vi.mock('$lib/server/db.server', () => ({ getDatabasePool: () => ({}) }));
vi.mock('@housekeeper/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@housekeeper/server')>();
  return { ...actual, processSyncBatch: vi.fn() };
});

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';

const envelope = (operationId: string, aggregateType: string) => ({
  apiVersion: 1,
  operationId,
  householdId: HOUSEHOLD,
  schemaVersion: 1,
  aggregateType,
  aggregateId: null,
  baseRevision: null,
  occurredAt: '2026-10-09T10:00:00Z',
  payload: {}
});

function event(body: unknown) {
  const url = new URL('https://casa.local/api/v1/sync');
  return {
    locals: { user: { id: 'fixture:roble:family' } },
    url,
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url.origin },
      body: JSON.stringify(body)
    })
  } as unknown as Parameters<typeof POST>[0];
}

async function outcome(body: unknown): Promise<{ status: number; body?: unknown }> {
  try {
    const response = await POST(event(body));
    return { status: response.status, body: await response.json() };
  } catch (cause) {
    const failure = cause as { status?: number };
    return { status: failure.status ?? 0 };
  }
}

describe('POST /api/v1/sync', () => {
  beforeEach(() => {
    vi.mocked(processSyncBatch).mockReset();
  });

  it('un agregado desconocido no tumba el lote: todos los sobres llegan a processSyncBatch', async () => {
    const acks = {
      apiVersion: 1,
      acknowledgements: [
        { operationId: 'a1000000-0000-4000-8000-000000000001', status: 'accepted' },
        { operationId: 'a1000000-0000-4000-8000-000000000002', status: 'rejected', errorCode: 'unsupported_aggregate' }
      ],
      nextCursor: '2026-10-09T10:00:01Z',
      snapshotVersion: null
    };
    vi.mocked(processSyncBatch).mockResolvedValueOnce(acks as never);
    const commands = [
      envelope('a1000000-0000-4000-8000-000000000001', 'menu_slot'),
      envelope('a1000000-0000-4000-8000-000000000002', 'modulo_del_futuro')
    ];

    expect(await outcome({ apiVersion: 1, commands })).toEqual({ status: 200, body: acks });
    expect(vi.mocked(processSyncBatch).mock.calls[0]?.[2]).toEqual(commands);
  });

  it('un sobre sin operationId identificable sigue siendo un 422, no un 500', async () => {
    vi.mocked(processSyncBatch).mockRejectedValueOnce(
      new CommandRejectedError('invalid_envelope', 'Comando sin operationId identificable')
    );
    expect(await outcome({ apiVersion: 1, commands: [{ operationId: 7 }] })).toEqual({ status: 422 });
  });

  it('un lote sin la forma del lote es un 422 y no llega a procesarse', async () => {
    expect(await outcome({ apiVersion: 1, commands: [] })).toEqual({ status: 422 });
    expect(await outcome({ commands: [envelope('a1000000-0000-4000-8000-000000000001', 'coupon')] })).toEqual({
      status: 422
    });
    expect(processSyncBatch).not.toHaveBeenCalled();
  });
});
