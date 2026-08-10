import { describe, expect, it } from 'vitest';

import {
  buildTodayDecisions,
  greetingFor,
  headerDateLabel,
  type TodayDecisionFacts
} from '../src/lib/server/today.server';
import {
  describeCommand,
  describeError,
  retryableEnvelope,
  triageableRecords
} from '../src/lib/components/outbox-triage';
import { createCommandEnvelope, createOutboxRecord } from '../src/lib/offline/schema';
import { FIXTURE_HOUSEHOLD } from './helpers';

const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
// El acuerdo del que cuelgan los hechos: el enlace de cada decisión tiene que
// decir de quién es el expediente al que lleva.
const AGREEMENT = '12000000-0000-4000-8000-000000000001';

function baseFacts(overrides: Partial<TodayDecisionFacts> = {}): TodayDecisionFacts {
  return {
    householdId: FIXTURE_HOUSEHOLD,
    role: 'family_admin',
    membershipId: '11000000-0000-4000-8000-000000000001',
    todayISO: '2026-08-07',
    extras: [
      {
        id: 'e-requested',
        agreementId: AGREEMENT,
        workedOn: '2026-08-01',
        durationMinutes: 90,
        note: 'Plancha del sábado',
        status: 'requested',
        employeeMembershipId: EMPLOYEE_MEMBERSHIP
      },
      {
        id: 'e-resolver',
        agreementId: AGREEMENT,
        workedOn: '2026-08-02',
        durationMinutes: 480,
        note: '',
        status: 'performed_pending_resolution',
        employeeMembershipId: EMPLOYEE_MEMBERSHIP
      },
      {
        id: 'e-accepted',
        agreementId: AGREEMENT,
        workedOn: '2026-08-03',
        durationMinutes: 60,
        note: 'Canguro',
        status: 'accepted',
        employeeMembershipId: EMPLOYEE_MEMBERSHIP
      }
    ],
    pendingExpenses: [
      {
        id: 'g-1',
        agreementId: AGREEMENT,
        incurredOn: '2026-08-04',
        description: 'Farmacia',
        amountCents: '2175'
      }
    ],
    settlements: [
      {
        id: 's-pendiente',
        agreementId: AGREEMENT,
        periodStart: '2026-07-01',
        dueOn: '2026-07-31',
        status: 'closed',
        paidCents: '0',
        pendingCents: '138330',
        receiptConfirmed: false
      },
      {
        id: 's-pagada',
        agreementId: AGREEMENT,
        periodStart: '2026-06-01',
        dueOn: '2026-06-30',
        status: 'closed',
        paidCents: '138330',
        pendingCents: '0',
        receiptConfirmed: false
      }
    ],
    unconfirmedSlots: [
      { id: 'slot-hoy', onDate: '2026-08-07', meal: 'comida' },
      { id: 'slot-manana', onDate: '2026-08-08', meal: 'cena' }
    ],
    dueRoutines: [
      {
        id: 'r-hoy',
        title: 'Repaso del filtro',
        details: '',
        nextDueOn: '2026-08-07',
        dueLabel: 'Hoy',
        overdue: false,
        completedCurrent: false,
        frequency: 'weekly',
        intervalCount: 1
      },
      {
        id: 'r-hecha',
        title: 'Ventilar',
        details: '',
        nextDueOn: '2026-08-07',
        dueLabel: 'Hoy',
        overdue: false,
        completedCurrent: true,
        frequency: 'weekly',
        intervalCount: 1
      }
    ],
    ...overrides
  };
}

describe('buildTodayDecisions por rol', () => {
  it('admin: jornadas requested/por resolver, gasto, huecos agregados y liquidación con pendiente', () => {
    const items = buildTodayDecisions(baseFacts());
    expect(items.map((item) => item.key)).toEqual([
      'extra-e-requested',
      'extra-e-resolver',
      'gasto-g-1',
      'menu-unconfirmed',
      'liquidacion-s-pendiente'
    ]);

    const requested = items[0]!;
    expect(requested.href).toBe(
      `/h/${FIXTURE_HOUSEHOLD}/employment?empleada=${AGREEMENT}#extra-e-requested`
    );
    // Ola D-5: la jornada solicitada se acepta desde Hoy sin perder el enlace.
    expect(requested.inline).toEqual({ kind: 'accept_extra', id: 'e-requested' });
    // Lo que no se resuelve en un gesto sigue siendo solo enlace.
    expect(items[1]!.inline).toBeUndefined();
    expect(items[2]!.inline).toBeUndefined();
    expect(requested.detail).toContain('1 ago 2026');
    expect(requested.detail).toContain('1 h 30 min');
    expect(requested.detail).toContain('Plancha del sábado');

    const gasto = items[2]!;
    expect(gasto.href).toBe(
      `/h/${FIXTURE_HOUSEHOLD}/employment?empleada=${AGREEMENT}#gasto-g-1`
    );
    expect(gasto.detail).toContain('21,75');

    // Los huecos se agregan en un único item con la semana del primero.
    const menu = items[3]!;
    expect(menu.title).toBe('2 comidas del menú sin confirmar');
    expect(menu.href).toBe(`/h/${FIXTURE_HOUSEHOLD}/menu?week=2026-08-03`);

    // Solo la liquidación cerrada CON pendiente pide pago; la pagada no.
    const settlement = items[4]!;
    expect(settlement.title).toContain('julio');
    expect(settlement.detail).toContain('1.383,30');
    expect(settlement.href).toBe(`/h/${FIXTURE_HOUSEHOLD}/employment?empleada=${AGREEMENT}`);
  });

  it('un único hueco sin confirmar se describe con su comida y fecha', () => {
    const items = buildTodayDecisions(
      baseFacts({
        role: 'family_member',
        pendingExpenses: [],
        unconfirmedSlots: [{ id: 'slot-hoy', onDate: '2026-08-07', meal: 'comida' }]
      })
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('comida del 7 ago 2026');
  });

  it('family_member: gastos y huecos como el admin, pero sin jornadas ni liquidaciones', () => {
    const items = buildTodayDecisions(baseFacts({ role: 'family_member' }));
    expect(items.map((item) => item.key)).toEqual(['gasto-g-1', 'menu-unconfirmed']);
  });

  it('empleada: su jornada aceptada, el cobro confirmable y su rutina de hoy', () => {
    const items = buildTodayDecisions(
      baseFacts({ role: 'employee_live_in', membershipId: EMPLOYEE_MEMBERSHIP })
    );
    expect(items.map((item) => item.key)).toEqual(['extra-e-accepted', 'cobro-s-pagada', 'rutina-r-hoy']);
    expect(items[0]!.cta).toBe('Marcar realizada');
    // La rutina completada no vuelve a pedir decisión; la pendiente ancla en la propia página.
    expect(items[2]!.href).toBe('#rutinas-de-hoy');
  });

  it('la jornada aceptada de OTRA empleada no aparece en su bloque', () => {
    const items = buildTodayDecisions(
      baseFacts({ role: 'employee_live_in', membershipId: 'otra-membresia' })
    );
    expect(items.map((item) => item.key)).toEqual(['cobro-s-pagada', 'rutina-r-hoy']);
  });

  it('helper y viewer no tienen nada que decidir', () => {
    expect(buildTodayDecisions(baseFacts({ role: 'helper' }))).toEqual([]);
    expect(buildTodayDecisions(baseFacts({ role: 'viewer' }))).toEqual([]);
  });
});

describe('cabecera del día', () => {
  it('greetingFor sigue la convención española', () => {
    expect(greetingFor(8)).toBe('Buenos días');
    expect(greetingFor(15)).toBe('Buenas tardes');
    expect(greetingFor(22)).toBe('Buenas noches');
    expect(greetingFor(3)).toBe('Buenas noches');
  });

  it('headerDateLabel produce la fecha real capitalizada', () => {
    expect(headerDateLabel('2026-08-07')).toBe('Viernes, 7 de agosto');
  });
});

describe('triaje genérico del outbox', () => {
  function envelope(aggregateType: Parameters<typeof createCommandEnvelope>[0]['aggregateType'], payload: unknown) {
    return createCommandEnvelope({ householdId: FIXTURE_HOUSEHOLD, aggregateType, payload });
  }

  it('solo lista conflict/rejected, de cualquier agregado', () => {
    const pending = createOutboxRecord(envelope('wiki_page', { action: 'edit' }));
    const rejected = createOutboxRecord(envelope('routine_occurrence', {}), { status: 'rejected' });
    const conflict = createOutboxRecord(envelope('menu_slot', { action: 'confirm' }), { status: 'conflict' });
    expect(triageableRecords([pending, rejected, conflict]).map((record) => record.id)).toEqual([
      rejected.id,
      conflict.id
    ]);
  });

  it('describe comandos de todos los dominios y delega los laborales', () => {
    expect(describeCommand(envelope('extra_work', { action: 'accept' }))).toBe('Aceptación de jornada extra');
    expect(describeCommand(envelope('menu_slot', { action: 'confirm' }))).toBe('Confirmación de una comida del menú');
    expect(describeCommand(envelope('routine', { action: 'complete' }))).toBe('Rutina marcada como hecha');
    expect(describeCommand(envelope('routine_occurrence', {}))).toBe(
      'Marca de tarea de demostración (no se guarda en la casa)'
    );
    expect(describeCommand(envelope('wiki_page', { action: 'edit' }))).toBe('Edición de una nota de la guía');
    expect(describeCommand(envelope('membership', { action: 'revoke' }))).toBe('Retirada de un acceso');
    expect(describeCommand(envelope('food', { action: 'upsert', name: 'Leche' }))).toBe(
      'Alimento «Leche» del catálogo'
    );
    // Un agregado sin descriptor degrada a la etiqueta genérica, nunca lanza.
    expect(describeCommand(envelope('comment', {}))).toBe('Cambio pendiente');
  });

  it('traduce los códigos de error propios y los laborales, y calla ante los desconocidos', () => {
    expect(describeError('unsupported_aggregate')).toBe('La aplicación no reconoce este tipo de cambio');
    expect(describeError('wiki_revision_conflict')).toBe('Otra persona guardó la nota antes que tú');
    expect(describeError('week_already_reported')).toBe('La semana ya fue enviada');
    expect(describeError('codigo_inventado')).toBeNull();
    expect(describeError(undefined)).toBeNull();
  });

  it('retryableEnvelope conserva los hechos y estrena operationId', () => {
    const original = envelope('menu_slot', { action: 'clear', slotId: 's1' });
    const retry = retryableEnvelope(original);
    expect(retry.operationId).not.toBe(original.operationId);
    expect({ ...retry, operationId: original.operationId }).toEqual(original);
  });
});
