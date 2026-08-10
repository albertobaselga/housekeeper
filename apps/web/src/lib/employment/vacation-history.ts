import { vacationYearBalance } from '@casa-clara/domain';

import { dateLabel, vacationRangeLabel } from './model';

/**
 * Vacaciones contadas como se cuentan en una casa.
 *
 * Este módulo escribe las FRASES; los números los calcula el motor puro del
 * dominio (`vacationYearBalance`), que es quien sabe prorratear el primer año y
 * repartir un periodo que cruza el 31 de diciembre. Aquí no se vuelve a sumar
 * nada: si esta capa hiciera su propia aritmética, la sección de la empleada y
 * la tarjeta del contrato podrían decir dos cifras distintas del mismo año.
 *
 * Tres reglas de redacción, que vienen del encargo y no son decorativas:
 *
 *  · NADA DE PORCENTAJES NI DE INDICADORES. Esto es historia, no evaluación. No
 *    hay barras de progreso, ni «has usado el 50 % de tus días», ni nada que
 *    puntúe a nadie por descansar más o menos.
 *  · NADA DE JERGA CONTABLE. Ni «saldo», ni «devengo», ni «disponible». Se dice
 *    «te quedan», «has disfrutado», «te tocan».
 *  · LA VOZ CAMBIA SEGÚN QUIÉN MIRA. La empleada lee sobre sí misma («te
 *    quedan»); quien administra lee sobre otra persona («le quedan»). Es la
 *    misma verdad dicha a quien corresponde, no dos cálculos.
 */

/** Quién está leyendo: ella sobre sí misma, o la administración sobre ella. */
export type VacationVoice = 'own' | 'other';

export interface VacationHistoryPeriodRow {
  id: string;
  startsOn: string;
  endsOn: string;
  calendarDays: number;
  note: string;
  status: 'recorded' | 'voided';
  voidReason: string | null;
}

export interface VacationEntitlementRow {
  effectiveFrom: string;
  annualVacationDays: number;
}

/** Un periodo tal y como se lee en la lista de un año. */
export interface VacationHistoryPeriodView {
  id: string;
  startsOn: string;
  endsOn: string;
  /** «Del 1 al 15 de agosto de 2026». */
  rangeLabel: string;
  /** «15 días», o «—» si está anulado: lo anulado no cuenta. */
  daysLabel: string;
  /** Estado en tiempo de casa, no de contabilidad. */
  state: 'past' | 'current' | 'future' | 'voided';
  /** «Ya disfrutadas» · «En curso» · «Aún por llegar» · «Anuladas». */
  stateLabel: string;
  /** La nota que escribió quien lo apuntó, o el motivo de la anulación. */
  detail: string;
  /**
   * Cuando el periodo cruza el fin de año, cuántos de sus días caen en ESTE
   * año. Sin esto, «del 24 de diciembre al 5 de enero · 13 días» dentro del
   * bloque de 2026 parecería que gasta trece días de 2026, y gasta ocho.
   */
  splitLabel: string | null;
}

export interface VacationYearView {
  year: number;
  /** El año natural en curso, el que la gente mira primero. */
  current: boolean;
  entitledDays: number;
  takenDays: number;
  /** Negativo si se pasó de los días pactados; se enseña, no se esconde. */
  remainingDays: number;
  /** La frase del año entera, en la voz de quien mira. */
  headline: string;
  /** Explicación del prorrateo del primer o del último año, o null. */
  prorationNote: string | null;
  /** Aviso de que se han apuntado más días de los pactados, o null. */
  excessNote: string | null;
  periods: VacationHistoryPeriodView[];
}

export interface VacationPersonView {
  agreementId: string;
  /** Nombre de la persona, o una etiqueta neutra si la RLS no dejó verlo. */
  employeeLabel: string;
  /** true cuando quien mira es la propia persona del contrato. */
  own: boolean;
  agreementStartsOn: string;
  agreementEndsOn: string | null;
  /** «Desde el 3 feb 2025» / «Del 3 feb 2025 al 30 jun 2026». */
  agreementRangeLabel: string;
  /** Del año más reciente al más antiguo. Todos, no solo el corriente. */
  years: VacationYearView[];
  /** true si no hay ni un solo periodo apuntado en ningún año. */
  empty: boolean;
}

function days(count: number): string {
  return `${count} ${Math.abs(count) === 1 ? 'día' : 'días'}`;
}

/**
 * Derecho anual que rige un año concreto.
 *
 * Para un año ya cerrado se pregunta por su 31 de diciembre, no por hoy: si el
 * contrato subió de 30 a 32 días en 2026, el historial de 2025 tiene que seguir
 * diciendo 30. Para el año en curso se pregunta por hoy, que es lo que la
 * migración 0020 y su ADR fijaron («se aplica el de la última versión ya en
 * vigor»). Sin ninguna versión en vigor todavía se toma la primera, porque el
 * derecho de un contrato recién firmado no es cero.
 */
export function annualVacationDaysForYear(
  versions: readonly VacationEntitlementRow[],
  year: number,
  today: string
): number {
  const onDate = `${year}-12-31` < today ? `${year}-12-31` : today;
  const ordered = [...versions].sort((left, right) =>
    left.effectiveFrom.localeCompare(right.effectiveFrom)
  );
  const inForce = ordered.filter((version) => version.effectiveFrom <= onDate).at(-1);
  return (inForce ?? ordered[0])?.annualVacationDays ?? 0;
}

function periodState(
  row: VacationHistoryPeriodRow,
  today: string
): VacationHistoryPeriodView['state'] {
  if (row.status === 'voided') return 'voided';
  if (row.endsOn < today) return 'past';
  if (row.startsOn > today) return 'future';
  return 'current';
}

const STATE_LABELS: Readonly<Record<VacationHistoryPeriodView['state'], string>> = {
  past: 'Ya disfrutadas',
  current: 'En curso',
  future: 'Aún por llegar',
  voided: 'Anuladas'
};

/**
 * La frase del año. Cambia entera según lo que haya pasado, porque una plantilla
 * con huecos («X de Y días») obliga a leer números para saber si la cosa va bien;
 * una frase escrita se entiende de un vistazo.
 */
function yearHeadline(
  voice: VacationVoice,
  year: number,
  entitled: number,
  taken: number,
  remaining: number
): string {
  const you = voice === 'own';
  const has = you ? 'has disfrutado' : 'ha disfrutado';
  const left = you ? 'Te quedan' : 'Le quedan';
  const belong = you ? 'te tocan' : 'le tocan';

  if (taken === 0) {
    return `De los ${days(entitled)} que ${belong} en ${year}, todavía no ${has} ninguno.`;
  }
  if (remaining < 0) {
    return (
      `En ${year} ${has} ${days(taken)} y el contrato reconoce ${days(entitled)}: ` +
      `hay ${days(-remaining)} de más.`
    );
  }
  if (remaining === 0) {
    return `De los ${days(entitled)} que ${belong} en ${year}, ${has} todos.`;
  }
  return `De los ${days(entitled)} que ${belong} en ${year}, ${has} ${taken}. ${left} ${remaining}.`;
}

function periodView(
  row: VacationHistoryPeriodRow,
  year: number,
  today: string,
  daysThisYear: number
): VacationHistoryPeriodView {
  const state = periodState(row, today);
  const crossesYear = row.startsOn.slice(0, 4) !== row.endsOn.slice(0, 4);
  return {
    id: row.id,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    rangeLabel: vacationRangeLabel(row.startsOn, row.endsOn),
    // Lo anulado no suma, y la lista no debe insinuar que sí con un número al
    // lado. El número original se conserva en el detalle, que es donde se
    // explica qué pasó.
    daysLabel: state === 'voided' ? '—' : days(row.calendarDays),
    state,
    stateLabel: STATE_LABELS[state],
    detail:
      state === 'voided'
        ? `Eran ${days(row.calendarDays)}. Anuladas${row.voidReason ? `: ${row.voidReason}` : ''}`
        : row.note || 'Vacaciones',
    splitLabel:
      state !== 'voided' && crossesYear
        ? `${days(daysThisYear)} de estas caen en ${year}`
        : null
  };
}

/**
 * El historial de una persona: todos los años que cubre su contrato, del más
 * reciente al más antiguo, con lo anulado a la vista como anulado.
 *
 * Se enseñan también los años SIN nada apuntado. Un año en blanco es
 * información («ese año no se apuntó ni un día»), y saltárselo dejaría un
 * historial con agujeros que parecen datos perdidos.
 */
export function buildVacationPersonView(input: {
  agreementId: string;
  employeeLabel: string;
  own: boolean;
  agreementStartsOn: string;
  agreementEndsOn: string | null;
  versions: readonly VacationEntitlementRow[];
  periods: readonly VacationHistoryPeriodRow[];
  /** Hoy en la zona del hogar, `YYYY-MM-DD`. */
  today: string;
}): VacationPersonView {
  const voice: VacationVoice = input.own ? 'own' : 'other';
  const currentYear = Number(input.today.slice(0, 4));
  const startYear = Number(input.agreementStartsOn.slice(0, 4));
  const periodYears = input.periods.flatMap((period) => [
    Number(period.startsOn.slice(0, 4)),
    Number(period.endsOn.slice(0, 4))
  ]);
  const endYear = input.agreementEndsOn === null ? null : Number(input.agreementEndsOn.slice(0, 4));
  // El último año con algo que decir: el corriente, o más allá si ya hay días
  // apuntados para el que viene. Un contrato terminado no llega más lejos de su
  // último día, aunque el calendario siga.
  let lastYear = Math.max(currentYear, startYear, ...periodYears);
  if (endYear !== null) lastYear = Math.min(lastYear, Math.max(endYear, startYear));

  const years: VacationYearView[] = [];
  for (let year = lastYear; year >= startYear; year -= 1) {
    const touching = input.periods.filter(
      (period) => period.startsOn <= `${year}-12-31` && period.endsOn >= `${year}-01-01`
    );
    const balance = vacationYearBalance({
      year,
      annualVacationDays: annualVacationDaysForYear(input.versions, year, input.today),
      agreementStartsOn: input.agreementStartsOn,
      agreementEndsOn: input.agreementEndsOn,
      periods: touching
        .filter((period) => period.status === 'recorded')
        .map((period) => ({ startsOn: period.startsOn, endsOn: period.endsOn }))
    });

    years.push({
      year,
      current: year === currentYear,
      entitledDays: balance.entitledDays,
      takenDays: balance.takenDays,
      remainingDays: balance.remainingDays,
      headline: yearHeadline(
        voice,
        year,
        balance.entitledDays,
        balance.takenDays,
        balance.remainingDays
      ),
      prorationNote: balance.prorated
        ? `El contrato cubre ${days(balance.coveredDays)} de ${year}, así que de los ` +
          `${days(balance.annualVacationDays)} del año ${voice === 'own' ? 'te tocan' : 'le tocan'} ` +
          `${balance.entitledDays}.`
        : null,
      excessNote:
        balance.remainingDays < 0
          ? 'Se han apuntado más días de los que reconoce el contrato. Casa Clara no lo corrige ' +
            'sola: lo enseña para que lo habléis y decidáis qué hacer.'
          : null,
      periods: touching
        .slice()
        .sort((left, right) => right.startsOn.localeCompare(left.startsOn))
        .map((period) => {
          const from = period.startsOn > `${year}-01-01` ? period.startsOn : `${year}-01-01`;
          const through = period.endsOn < `${year}-12-31` ? period.endsOn : `${year}-12-31`;
          const inYear =
            Math.round(
              (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
            ) + 1;
          return periodView(period, year, input.today, inYear);
        })
    });
  }

  return {
    agreementId: input.agreementId,
    employeeLabel: input.employeeLabel,
    own: input.own,
    agreementStartsOn: input.agreementStartsOn,
    agreementEndsOn: input.agreementEndsOn,
    agreementRangeLabel:
      input.agreementEndsOn === null
        ? `Desde el ${dateLabel(input.agreementStartsOn)}`
        : `Del ${dateLabel(input.agreementStartsOn)} al ${dateLabel(input.agreementEndsOn)}`,
    years,
    empty: input.periods.length === 0
  };
}
