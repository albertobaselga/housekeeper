import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import { OptimisticActions } from '../src/lib/offline/optimistic';
import type { QueueCommandResult } from '../src/lib/offline/queue-command';
import type { OutboxRecord } from '../src/lib/offline/schema';
import { FIXTURE_HOUSEHOLD as HOUSEHOLD, envelopeFixture } from './helpers';

const OP = '44444444-0000-4000-8000-0000000000';

function actions(
  result: QueueCommandResult,
  records: OutboxRecord[] = []
): {
  optimistic: OptimisticActions;
  queueCommandFn: ReturnType<typeof vi.fn>;
  invalidateFn: ReturnType<typeof vi.fn>;
} {
  const queueCommandFn = vi.fn().mockResolvedValue(result);
  const invalidateFn = vi.fn().mockResolvedValue(undefined);
  const optimistic = new OptimisticActions({
    householdId: HOUSEHOLD,
    invalidateToken: 'cc:test',
    queueCommandFn: queueCommandFn as never,
    invalidateFn,
    listOutboxFn: vi.fn().mockResolvedValue(records) as never
  });
  return { optimistic, queueCommandFn, invalidateFn };
}

function recordFixture(operationId: string, status: OutboxRecord['status'], lastErrorCode?: string): OutboxRecord {
  return {
    id: operationId,
    householdId: HOUSEHOLD,
    createdAt: '2026-08-07T08:00:00.000Z',
    status,
    attempts: 1,
    ...(lastErrorCode ? { lastErrorCode } : {}),
    envelope: envelopeFixture(operationId, '2026-08-07T08:00:00.000Z')
  } as OutboxRecord;
}

describe('OptimisticActions: patrón wiki reutilizable', () => {
  it('synced: apply ANTES del envío, invalidate selectivo y settle después', async () => {
    const { optimistic, queueCommandFn, invalidateFn } = actions({ outcome: 'synced', message: 'Cambio sincronizado.' });
    const order: string[] = [];
    queueCommandFn.mockImplementation(async () => {
      order.push('queue');
      return { outcome: 'synced', message: 'Cambio sincronizado.' };
    });

    const outcome = await optimistic.run(envelopeFixture(`${OP}01`, '2026-08-07T08:00:00.000Z'), {
      apply: () => order.push('apply'),
      revert: () => order.push('revert'),
      settle: () => order.push('settle')
    });

    expect(outcome).toBe('synced');
    expect(order).toEqual(['apply', 'queue', 'settle']);
    expect(invalidateFn).toHaveBeenCalledWith('cc:test');
    expect(get(optimistic.status)).toEqual({ tone: 'success', text: 'Cambio sincronizado.' });
  });

  it('rejected: reversión inmediata y nota roja con el mensaje veraz', async () => {
    const { optimistic, invalidateFn } = actions({
      outcome: 'rejected',
      errorCode: 'not_allowed',
      message: 'No se pudo guardar: Tu rol no permite esta acción.'
    });
    const hooks = { apply: vi.fn(), revert: vi.fn(), settle: vi.fn() };

    await optimistic.run(envelopeFixture(`${OP}02`, '2026-08-07T08:00:00.000Z'), hooks);

    expect(hooks.apply).toHaveBeenCalledOnce();
    expect(hooks.revert).toHaveBeenCalledOnce();
    expect(hooks.settle).not.toHaveBeenCalled();
    expect(invalidateFn).not.toHaveBeenCalled();
    expect(get(optimistic.status)?.tone).toBe('error');
    expect(get(optimistic.status)?.text).not.toContain('se sincronizará');
  });

  it('queued: nota ámbar, el estado optimista se conserva y la reconciliación lo confirma', async () => {
    const message = 'Guardado en este dispositivo; se enviará al recuperar la conexión.';
    const { optimistic, invalidateFn } = actions({ outcome: 'queued', message });
    const hooks = { revert: vi.fn(), settle: vi.fn() };

    await optimistic.run(envelopeFixture(`${OP}03`, '2026-08-07T08:00:00.000Z'), hooks);
    expect(get(optimistic.status)).toEqual({ tone: 'pending', text: message });
    expect(hooks.settle).not.toHaveBeenCalled();

    // Un flush posterior vació el outbox: la operación quedó confirmada.
    await optimistic.reconcile();
    expect(hooks.settle).toHaveBeenCalledOnce();
    expect(hooks.revert).not.toHaveBeenCalled();
    expect(invalidateFn).toHaveBeenCalledWith('cc:test');
    expect(get(optimistic.status)).toEqual({ tone: 'success', text: 'Cambio sincronizado.' });
  });

  it('queued → rechazado en un flush posterior: revert y causa traducida', async () => {
    const operationId = `${OP}04`;
    const { optimistic } = actions(
      { outcome: 'queued', message: 'Guardado en este dispositivo; se enviará al recuperar la conexión.' },
      [recordFixture(operationId, 'rejected', 'not_allowed')]
    );
    const hooks = { revert: vi.fn(), settle: vi.fn() };

    await optimistic.run(envelopeFixture(operationId, '2026-08-07T08:00:00.000Z'), hooks);
    await optimistic.reconcile();

    expect(hooks.revert).toHaveBeenCalledOnce();
    expect(hooks.settle).not.toHaveBeenCalled();
    expect(get(optimistic.status)).toEqual({
      tone: 'error',
      text: 'No se pudo guardar: Tu rol no permite esta acción.'
    });
  });

  it('queued → sigue pendiente: la operación queda vigilada sin tocar la UI', async () => {
    const operationId = `${OP}05`;
    const { optimistic, invalidateFn } = actions(
      { outcome: 'queued', message: 'Guardado en este dispositivo; se enviará al recuperar la conexión.' },
      [recordFixture(operationId, 'pending')]
    );
    const hooks = { revert: vi.fn(), settle: vi.fn() };

    await optimistic.run(envelopeFixture(operationId, '2026-08-07T08:00:00.000Z'), hooks);
    await optimistic.reconcile();

    expect(hooks.revert).not.toHaveBeenCalled();
    expect(hooks.settle).not.toHaveBeenCalled();
    expect(invalidateFn).not.toHaveBeenCalled();
    expect(get(optimistic.status)?.tone).toBe('pending');
  });
});
