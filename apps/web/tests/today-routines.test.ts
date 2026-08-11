import { describe, expect, it } from 'vitest';

import {
  buildTodayRoutines,
  PENDING_ROWS_VISIBLE,
  WEEK_AHEAD_DAYS,
  type TodayRoutineFacts,
  type TodayViewer
} from '../src/lib/server/today.server';

/**
 * La tarjeta de rutinas de Hoy, sin base de datos y sin navegador: todo lo que
 * se ve se calcula en el servidor, así que todo lo que se ve se puede probar
 * aquí. Las fechas son fijas a propósito —2026-08-13 es un jueves— porque los
 * literales dependen del día de la semana y una prueba relativa a `new Date()`
 * habría fallado un día de cada siete.
 */

const JUEVES = '2026-08-13';

const ANA: TodayViewer = { membershipId: 'ana', role: 'employee_live_in' };
const ADMIN: TodayViewer = { membershipId: 'alberto', role: 'family_admin' };

function daily(overrides: Partial<TodayRoutineFacts> = {}): TodayRoutineFacts {
  return {
    id: 'r-diaria',
    title: 'Ventilación de la mañana',
    details: '',
    schedule: { pattern: 'every_n_days', anchorOn: '2026-08-01', repeatEvery: 1 },
    policy: 'skip',
    completedDueOns: [],
    markedToday: [],
    ...overrides
  };
}

/** Quincenal anclada el jueves 6: se quedó pendiente y la siguiente es el 20. */
function weekly(overrides: Partial<TodayRoutineFacts> = {}): TodayRoutineFacts {
  return {
    id: 'r-semanal',
    title: 'Cambio de sábanas',
    details: 'Las dos camas de arriba.',
    schedule: { pattern: 'every_n_days', anchorOn: '2026-08-06', repeatEvery: 14 },
    policy: 'carry',
    completedDueOns: [],
    markedToday: [],
    ...overrides
  };
}

describe('buildTodayRoutines: lo que la tarjeta enseña', () => {
  it('el chip cuenta, no puntúa: nunca porcentaje ni racha (AC-26 revisado)', () => {
    const view = buildTodayRoutines([daily(), weekly()], JUEVES, ANA);
    expect(view.countChip).toBe('2 por hacer');
    // La ausencia es el requisito: cualquier agregado que puntúe a alguien está
    // expresamente prohibido, en ninguna vista, API ni exportación.
    expect(JSON.stringify(view)).not.toMatch(/%|racha|media|cumplimiento/i);
  });

  it('una rutina diaria olvidada NO deja deuda; una semanal deja UNA sola línea', () => {
    // El corazón de §2.5. Antes, diez días sin marcar dejaban diez líneas
    // «Vencía el…» y diez toques; ahora la ocurrencia diaria caduca con su día.
    const view = buildTodayRoutines([daily(), weekly()], JUEVES, ANA);
    expect(view.overdue.map((row) => row.title)).toEqual(['Cambio de sábanas']);
    expect(view.overdue[0]!.dueOn).toBe('2026-08-06');
    expect(view.overdue[0]!.note).toBe('Tocaba el 6 ago 2026');
    expect(view.today.map((row) => row.title)).toEqual(['Ventilación de la mañana']);
    expect(view.overdueCount).toBe(1);
  });

  it('lo atrasado de esta semana se nombra por su día, y lo de ayer se dice «ayer»', () => {
    const anteayer = buildTodayRoutines(
      [
        weekly({
          schedule: { pattern: 'every_n_days', anchorOn: '2026-08-11', repeatEvery: 7 }
        })
      ],
      JUEVES,
      ANA
    );
    expect(anteayer.overdue[0]!.note).toBe('Tocaba el martes');

    const ayer = buildTodayRoutines(
      [
        weekly({
          schedule: { pattern: 'every_n_days', anchorOn: '2026-08-12', repeatEvery: 7 }
        })
      ],
      JUEVES,
      ANA
    );
    expect(ayer.overdue[0]!.note).toBe('Tocaba ayer');
  });

  it('el chip optimista dice la próxima ocurrencia REAL de esa fila', () => {
    const view = buildTodayRoutines([daily()], JUEVES, ANA);
    // Diaria: mañana, viernes 14. Se resuelve aquí para que el navegador no
    // tenga que importar la aritmética de recurrencia ni un formateador.
    expect(view.today[0]!.doneChip).toBe('Hecha ✓ · próxima el vie, 14 ago');
  });

  it('una rutina puede traer su atrasada Y la de hoy, cada una con su fila', () => {
    // El ancla del jueves con cadencia semanal hace coincidir las dos.
    const view = buildTodayRoutines(
      [
        weekly({
          schedule: { pattern: 'every_n_days', anchorOn: '2026-08-06', repeatEvery: 7 }
        })
      ],
      JUEVES,
      ANA
    );
    expect(view.overdue).toHaveLength(1);
    expect(view.today).toHaveLength(1);
    // Claves distintas: la fila es (rutina, ocurrencia), no la rutina.
    expect(view.overdue[0]!.key).not.toBe(view.today[0]!.key);
    // Y al marcar la atrasada lo siguiente pendiente es HOY, no dentro de una
    // semana: el chip de esa fila tiene que decir la verdad de esa fila.
    expect(view.overdue[0]!.doneChip).toBe('Hecha ✓ · próxima el jue, 13 ago');
  });

  it('lo hecho hoy se puede deshacer: quien lo marcó, y la administración', () => {
    const facts = [
      daily({
        completedDueOns: [JUEVES],
        markedToday: [{ dueOn: JUEVES, byMembershipId: 'ana' }]
      }),
      weekly({
        id: 'r-otra',
        title: 'Cristales',
        completedDueOns: ['2026-08-06'],
        markedToday: [{ dueOn: '2026-08-06', byMembershipId: 'alberto' }]
      })
    ];

    const suyo = buildTodayRoutines(facts, JUEVES, ANA);
    expect(suyo.done.map((row) => [row.title, row.canUndo])).toEqual([
      ['Ventilación de la mañana', true],
      // La empleada no desmarca lo que marcó otra persona.
      ['Cristales', false]
    ]);
    // Lo marcado tarde dice de qué día era, para que deshacerlo no sea a ciegas.
    expect(suyo.done[1]!.note).toBe('Tocaba el 6 ago 2026');
    // Y el chip es el MISMO que se pinta al marcar: la fila no cambia de
    // idioma cuando llegan los datos frescos y se mueve al bloque de hechas.
    expect(suyo.done[0]!.chip).toBe('Hecha ✓ · próxima el vie, 14 ago');
    expect(suyo.countChip).toBe('Todo hecho ✓');

    const admin = buildTodayRoutines(facts, JUEVES, ADMIN);
    expect(admin.done.every((row) => row.canUndo)).toBe(true);
  });

  it('sin nada pendiente ni hecho, la tarjeta lo dice en vez de fingir', () => {
    const view = buildTodayRoutines(
      [
        daily({
          schedule: { pattern: 'every_n_days', anchorOn: '2026-09-01', repeatEvery: 1 }
        })
      ],
      JUEVES,
      ANA
    );
    expect(view.anyToday).toBe(false);
    expect(view.countChip).toBe('');
  });

  it('el corte deja seis filas a la vista y pliega el resto', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      daily({ id: `r-${index}`, title: `Rutina ${index}` })
    );
    const view = buildTodayRoutines(many, JUEVES, ANA);
    expect(view.today).toHaveLength(PENDING_ROWS_VISIBLE);
    expect(view.more).toHaveLength(3);
    // Los bloques vienen armados del servidor, con su encabezado y su plegado.
    expect(view.blocks.map((block) => [block.key, block.heading, block.folded])).toEqual([
      ['today', '', false],
      ['more', 'Ver las 3 restantes', true]
    ]);

    // Lo atrasado se ve antes que lo de hoy: es lo que se pierde si no se dice,
    // y solo entonces el encabezado «Hoy» distingue algo.
    const conAtraso = buildTodayRoutines([weekly(), ...many], JUEVES, ANA);
    expect(conAtraso.overdue).toHaveLength(1);
    expect(conAtraso.today).toHaveLength(PENDING_ROWS_VISIBLE - 1);
    expect(conAtraso.more).toHaveLength(4);
    expect(conAtraso.blocks.map((block) => block.heading)).toEqual([
      'Se quedó pendiente',
      'Hoy',
      'Ver las 4 restantes'
    ]);
  });

  it('«Esta semana» agrupa por día, con el día nombrado y sin nada que marcar', () => {
    const view = buildTodayRoutines(
      [
        // Los lunes: dentro de la ventana cae el lunes 17.
        weekly({
          id: 'r-lunes',
          title: 'Colada',
          schedule: {
            pattern: 'days_of_week',
            anchorOn: '2026-08-03',
            repeatEvery: 1,
            weekdays: [1]
          },
          policy: 'skip'
        }),
        // Y algo mañana mismo.
        weekly({
          id: 'r-manana',
          title: 'Compra',
          schedule: { pattern: 'every_n_days', anchorOn: '2026-08-14', repeatEvery: 30 }
        })
      ],
      JUEVES,
      ANA
    );
    expect(view.week.map((group) => [group.label, group.items.map((item) => item.title)])).toEqual([
      ['Mañana', ['Compra']],
      ['El lunes', ['Colada']]
    ]);
  });

  it('las diarias no se repiten seis veces: se resumen con su cadencia', () => {
    // Sin esto, «Esta semana» sería la misma frase escrita una vez por día y no
    // ayudaría a planificar nada, que es justo para lo que existe el bloque.
    const view = buildTodayRoutines([daily()], JUEVES, ANA);
    expect(view.weekRepeats).toEqual([
      { key: 'r-diaria', title: 'Ventilación de la mañana', cadence: 'todos los días' }
    ]);
    expect(view.week).toEqual([]);
  });

  it('«los lunes y los jueves» sí merece ver sus dos días', () => {
    const view = buildTodayRoutines(
      [
        weekly({
          id: 'r-dos',
          title: 'Cocina a fondo',
          schedule: {
            pattern: 'days_of_week',
            anchorOn: '2026-08-03',
            repeatEvery: 1,
            weekdays: [1, 4]
          },
          policy: 'skip'
        })
      ],
      JUEVES,
      ANA
    );
    // Dentro de hoy+1…hoy+6 caen el lunes 17: el jueves 20 queda fuera de la
    // ventana precisamente para que ningún grupo se llame como hoy.
    expect(view.weekRepeats).toEqual([]);
    expect(view.week.map((group) => group.label)).toEqual(['El lunes']);
  });

  it('la ventana no llega al mismo día de la semana que hoy', () => {
    // Es la razón de que sean seis días y no siete: «el jueves» dicho un jueves
    // se lee como hoy.
    expect(WEEK_AHEAD_DAYS).toBe(6);
    const view = buildTodayRoutines(
      [
        weekly({
          id: 'r-dentro-de-siete',
          schedule: { pattern: 'every_n_days', anchorOn: '2026-08-20', repeatEvery: 7 }
        })
      ],
      JUEVES,
      ANA
    );
    expect(view.week).toEqual([]);
  });

  it('lo ya marcado no reaparece en «Esta semana»', () => {
    const view = buildTodayRoutines(
      [
        weekly({
          id: 'r-manana',
          title: 'Compra',
          schedule: { pattern: 'every_n_days', anchorOn: '2026-08-14', repeatEvery: 30 },
          completedDueOns: ['2026-08-14']
        })
      ],
      JUEVES,
      ANA
    );
    expect(view.week).toEqual([]);
  });
});
