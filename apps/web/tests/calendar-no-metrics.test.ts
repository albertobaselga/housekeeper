import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  buildCalendarDays,
  buildCalendarYear,
  type CalendarRoutineView
} from '../src/lib/calendar/view';

/**
 * El AC-26 revisado (enmienda E2 de `docs/rutinas-y-calendario.md`, 10/08/2026)
 * con una prueba que de verdad lo impide:
 *
 * > el historial de rutinas es consultable como hechos con su fecha y su
 * > autoría. No existe ningún indicador de cumplimiento —porcentaje, racha,
 * > media, comparativa ni codificación por color que califique—, en ninguna
 * > vista, API ni exportación.
 *
 * La diferencia que esta prueba defiende no es de matiz: enseñar QUÉ SE HIZO es
 * la memoria de la casa; enseñar CUÁNTO CUMPLE ALGUIEN es una evaluación de
 * desempeño sobre una trabajadora, y esta aplicación no la hace. Un agregado se
 * cuela en una tarde y sale de la aplicación en un año, así que se vigila el
 * código, no la buena intención.
 *
 * Cuatro cierres, cada uno por donde ha entrado esto en otros productos:
 *   1. el vocabulario (nadie escribe `donePercent` sin querer);
 *   2. la FORMA de lo que se devuelve (un campo nuevo rompe la prueba);
 *   3. el COLOR (nada del calendario se pinta con el rojo del peligro ni con el
 *      verde del acierto: un mapa de calor es una nota disfrazada);
 *   4. la GEOMETRÍA, y en TODAS las pantallas que enseñan rutinas, incluidas
 *      las maquetas. «En ninguna vista» se escribió sin excepciones y la
 *      maqueta es una vista: es la que ven las suites sin base de datos y
 *      quien entra a mirar la aplicación antes de tener datos. Una barra o un
 *      anillo rellenos en proporción a lo hecho son el mismo porcentaje sin
 *      escribir el signo.
 */

const SOURCES = [
  'src/lib/calendar/view.ts',
  'src/lib/server/calendar.server.ts',
  'src/routes/h/[householdId]/calendar/+page.svelte'
] as const;

/** Las tres pantallas que enseñan rutinas, en sus dos modos (con datos y sin). */
const ROUTINE_VIEWS = [
  'src/routes/h/[householdId]/calendar/+page.svelte',
  'src/routes/h/[householdId]/routines/+page.svelte',
  'src/routes/h/[householdId]/today/+page.svelte'
] as const;

/**
 * Fuera comentarios y prosa: lo que se vigila es el código. Los propios
 * comentarios de estos ficheros explican por qué no hay porcentajes y NOMBRAN
 * lo prohibido; castigarlos por explicarlo empujaría a borrar la explicación,
 * que es justo lo que hay que conservar.
 */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// `(?<!@)media` deja pasar `@media` de CSS y no «la media de cumplimiento»;
// `(?<![-\w])ratio` deja pasar `aspect-ratio` y no una razón de cumplidas.
const FORBIDDEN =
  /porcentaje|percent|(?<![-\w])ratio\b|racha|streak|promedio|\baverage\b|(?<!@)\bmedia\b|ranking|puntuaci|cumplimiento|compliance|\bscore\b/i;

describe('el calendario no puede puntuar a nadie (AC-26 revisado)', () => {
  it('el código no nombra ningún indicador de cumplimiento', async () => {
    for (const relative of SOURCES) {
      const source = code(await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'));
      const offending = source.split('\n').filter((line) => FORBIDDEN.test(line));
      expect(offending, `${relative} habla de cumplimiento en el código`).toEqual([]);
    }
  });

  it('ninguna vista de rutinas dibuja un porcentaje, ni con signo ni con geometría', async () => {
    for (const relative of ROUTINE_VIEWS) {
      const source = code(await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'));
      // El signo: calculado (`* 100`) o pegado a una interpolación (`}%`).
      expect(source, `${relative} calcula un porcentaje`).not.toMatch(/\*\s*100\b/);
      expect(source, `${relative} imprime un signo de porcentaje`).not.toMatch(/\}%/);
      // La geometría: `<progress>`/`<meter>` y el anillo de relleno proporcional.
      expect(source, `${relative} pinta una barra de progreso`).not.toMatch(/<(progress|meter)\b/);
      expect(source, `${relative} pinta un anillo de progreso`).not.toContain('progress-ring');
      expect(source, `${relative} rellena una forma en proporción`).not.toContain('conic-gradient');
    }
  });

  it('la hoja global tampoco conserva el estilo de esos indicadores', async () => {
    // Si el CSS sobrevive, el siguiente que necesite «algo de progreso» lo
    // reutiliza sin pensar y el criterio vuelve a caerse por la puerta de atrás.
    const css = code(await readFile(new URL('../src/app.css', import.meta.url), 'utf8'));
    // Se enseñan las LÍNEAS que sobran, no la hoja entera: el fallo de este
    // cierre tiene que caber en la pantalla de quien lo rompa.
    const offending = css
      .split('\n')
      .filter((line) => line.includes('.progress-ring') || line.includes('.routine-progress'));
    expect(offending, 'app.css conserva el estilo de un indicador de cumplimiento').toEqual([]);
  });

  it('la página no colorea el pasado por rendimiento', async () => {
    const page = await readFile(
      new URL('../src/routes/h/[householdId]/calendar/+page.svelte', import.meta.url),
      'utf8'
    );
    const styles = page.slice(page.indexOf('<style>'));
    // Ni el rojo del peligro ni el verde del acierto entran en el calendario:
    // «hecha» y «sin marcar» son hechos y van en tono neutro.
    expect(styles).not.toContain('--danger');
    expect(styles).not.toContain('--success');
    // Y los dos estados del pasado usan el mismo chip neutro.
    expect(page).toContain('<span class="status-chip neutral">Hecha</span>');
    expect(page).toContain('<span class="status-chip neutral">Sin marcar</span>');
  });

  it('una ocurrencia solo lleva hechos: qué, cuándo y quién', () => {
    const routine: CalendarRoutineView = {
      id: 'r1',
      title: 'Limpieza de baños',
      details: '',
      audience: 'employee',
      audienceLabel: 'Empleada',
      cadence: 'todos los días',
      rule: { pattern: 'every_n_days', anchorOn: '2026-08-01', repeatEvery: 1, endsOn: null },
      overduePolicy: 'skip'
    };
    const [day] = buildCalendarDays({
      routines: [routine],
      completions: [{ routineId: 'r1', dueOn: '2026-08-10', completedOn: '2026-08-10', byName: 'Ana' }],
      events: [],
      fromISO: '2026-08-10',
      toISO: '2026-08-10',
      todayISO: '2026-08-12',
      knownFromISO: '2026-08-01',
      knownToISO: '2026-08-31'
    });
    expect(Object.keys(day!.routines[0]!).sort()).toEqual([
      'audienceLabel',
      'cadence',
      'canComplete',
      'details',
      'doneBy',
      'doneLateDays',
      'dueOn',
      'routineId',
      'state',
      'title'
    ]);
  });

  it('el año enseña lo PREVISTO y no puede mirar lo hecho', () => {
    // La firma no admite finalizaciones: a escala de año, pintar hecho/no hecho
    // sería un mapa de calor del cumplimiento de una persona.
    expect(buildCalendarYear.length).toBe(3);
    const [january] = buildCalendarYear(2026, [], []);
    expect(Object.keys(january!).sort()).toEqual([
      'busyDays',
      'eventDays',
      'highlights',
      'label',
      'month',
      'routineDays'
    ]);
  });
});
