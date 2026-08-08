import { describe, expect, it } from 'vitest';

import { weeklyReportSubmitPayloadSchema } from '@casa-clara/contracts/schemas';

import { submitWeek } from '../src/lib/employment/commands';
import { buildWeeklyReportViews } from '../src/lib/employment/model';
import {
  MAX_WEEK_ROWS,
  addDaysIso,
  buildWeekEntries,
  currentWeekMonday,
  localIsoDate,
  mondayOf,
  weekDays
} from '../src/lib/employment/week';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const AGREEMENT = '12000000-0000-4000-8000-000000000001';

describe('semana en curso calculada en cliente', () => {
  it('encuentra el lunes de cualquier día de la semana', () => {
    expect(mondayOf('2026-08-03')).toBe('2026-08-03'); // lunes
    expect(mondayOf('2026-08-07')).toBe('2026-08-03'); // viernes
    expect(mondayOf('2026-08-09')).toBe('2026-08-03'); // domingo
    expect(mondayOf('2026-01-01')).toBe('2025-12-29'); // cruza el año
  });

  it('usa la zona horaria del hogar, no la del proceso', () => {
    // 2026-08-09T22:30Z es lunes 00:30 en Madrid (CEST): la semana ya es la nueva.
    expect(localIsoDate(new Date('2026-08-09T22:30:00Z'), 'Europe/Madrid')).toBe('2026-08-10');
    expect(currentWeekMonday(new Date('2026-08-09T22:30:00Z'), 'Europe/Madrid')).toBe('2026-08-10');
    // Ese mismo instante en UTC sigue siendo domingo de la semana anterior.
    expect(currentWeekMonday(new Date('2026-08-09T22:30:00Z'), 'UTC')).toBe('2026-08-03');
  });

  it('genera los siete días de la semana', () => {
    const days = weekDays('2026-08-03');
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-08-03');
    expect(days[6]).toBe('2026-08-09');
    expect(addDaysIso('2026-08-03', 6)).toBe('2026-08-09');
  });
});

describe('construcción de las entradas del parte semanal', () => {
  const WEEK = '2026-08-03';

  it('acepta filas válidas, ordena por fecha y omite la nota vacía', () => {
    const result = buildWeekEntries(WEEK, [
      { workedOn: '2026-08-05', minutes: '480', note: '  ' },
      { workedOn: '2026-08-03', minutes: 300, note: ' Turno partido ' }
    ]);
    expect(result).toEqual({
      ok: true,
      entries: [
        { workedOn: '2026-08-03', regularMinutes: 300, note: 'Turno partido' },
        { workedOn: '2026-08-05', regularMinutes: 480 }
      ]
    });
  });

  it('rechaza cero filas y más de siete', () => {
    expect(buildWeekEntries(WEEK, [])).toMatchObject({ ok: false });
    const eight = Array.from({ length: MAX_WEEK_ROWS + 1 }, (_, index) => ({
      workedOn: addDaysIso(WEEK, index % 7),
      minutes: 60,
      note: ''
    }));
    expect(buildWeekEntries(WEEK, eight)).toMatchObject({ ok: false });
  });

  it('rechaza días fuera de la semana, duplicados y minutos inválidos', () => {
    expect(
      buildWeekEntries(WEEK, [{ workedOn: '2026-08-10', minutes: 60, note: '' }])
    ).toMatchObject({ ok: false, error: expect.stringContaining('semana') });
    expect(
      buildWeekEntries(WEEK, [
        { workedOn: '2026-08-03', minutes: 60, note: '' },
        { workedOn: '2026-08-03', minutes: 90, note: '' }
      ])
    ).toMatchObject({ ok: false, error: expect.stringContaining('mismo día') });
    expect(buildWeekEntries(WEEK, [{ workedOn: '2026-08-03', minutes: '7,5', note: '' }])).toMatchObject({ ok: false });
    expect(buildWeekEntries(WEEK, [{ workedOn: '2026-08-03', minutes: -1, note: '' }])).toMatchObject({ ok: false });
    expect(buildWeekEntries(WEEK, [{ workedOn: '2026-08-03', minutes: 1441, note: '' }])).toMatchObject({ ok: false });
    expect(buildWeekEntries(WEEK, [{ workedOn: '', minutes: 60, note: '' }])).toMatchObject({ ok: false });
  });

  it('las entradas construidas validan contra el payload congelado del contrato', () => {
    const result = buildWeekEntries(WEEK, [
      { workedOn: '2026-08-03', minutes: 480, note: 'Turno completo' },
      { workedOn: '2026-08-04', minutes: 0, note: '' }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const envelope = submitWeek({
      householdId: HOUSEHOLD,
      agreementId: AGREEMENT,
      weekStartsOn: WEEK,
      entries: result.entries
    });
    expect(weeklyReportSubmitPayloadSchema.parse(envelope.payload)).toBeTruthy();
  });
});

describe('vista de partes semanales recientes', () => {
  it('etiqueta enviado/confirmado/auto-confirmado/disputado y ordena del más nuevo al más viejo', () => {
    const views = buildWeeklyReportViews([
      {
        id: 'a',
        weekStartsOn: '2026-07-20',
        weekEndsOn: '2026-07-26',
        status: 'confirmed',
        autoConfirmed: false,
        disputeReason: null
      },
      {
        id: 'b',
        weekStartsOn: '2026-08-03',
        weekEndsOn: '2026-08-09',
        status: 'submitted',
        autoConfirmed: false,
        disputeReason: null
      },
      {
        id: 'c',
        weekStartsOn: '2026-07-27',
        weekEndsOn: '2026-08-02',
        status: 'confirmed',
        autoConfirmed: true,
        disputeReason: null
      },
      {
        id: 'd',
        weekStartsOn: '2026-07-13',
        weekEndsOn: '2026-07-19',
        status: 'disputed',
        autoConfirmed: false,
        disputeReason: 'Faltan horas del martes'
      }
    ]);
    expect(views.map((view) => view.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(views.map((view) => view.statusLabel)).toEqual([
      'Enviado · pendiente de confirmación',
      'Auto-confirmado',
      'Confirmado',
      'Con reparos de la familia'
    ]);
    expect(views[0]!.weekLabel).toBe('Semana del 3 ago 2026');
    expect(views[3]!.disputeReason).toBe('Faltan horas del martes');
  });
});
