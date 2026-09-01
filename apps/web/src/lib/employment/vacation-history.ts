import {
  contractYear,
  contractYearOn,
  vacationCalendarDays,
  vacationDaysInWindow,
  vacationYearBalance,
  type ContractYear
} from '@casa-clara/domain';

import { dateLabel, vacationRangeLabel } from './model';

/**
 * Vacaciones contadas como se cuentan en una casa.
 *
 * Este módulo escribe las FRASES; los números los calcula el motor puro del
 * dominio (`vacationYearBalance`), que es quien sabe dónde empieza y acaba cada
 * año de contrato, prorratear el último y repartir un periodo que cruza el
 * aniversario. Aquí no se vuelve a sumar nada: si esta capa hiciera su propia
 * aritmética, la sección de la empleada y la tarjeta del contrato podrían decir
 * dos cifras distintas del mismo año.
 *
 * Cuatro reglas de redacción, que vienen del encargo y no son decorativas:
 *
 *  · EL AÑO SE DICE CON SUS FECHAS. «Segundo año · 5 mar 2026 – 4 mar 2027». El
 *    año de vacaciones es el del contrato, no el del calendario, así que un
 *    ordinal a secas no le dice nada a quien lo lee: sin las fechas nadie sabe
 *    de qué doce meses se está hablando.
 *  · NADA DE PORCENTAJES NI DE INDICADORES. Esto es historia, no evaluación. No
 *    hay barras de progreso, ni «has usado el 50 % de tus días», ni nada que
 *    puntúe a nadie por descansar más o menos.
 *  · NADA DE JERGA CONTABLE. Ni «saldo», ni «disponible». Se dice «te quedan»,
 *    «has disfrutado», «te tocan», «llevas devengados».
 *  · LA VOZ CAMBIA SEGÚN QUIÉN MIRA. La empleada lee sobre sí misma («te
 *    quedan»); quien administra lee sobre otra persona («le quedan»). Es la
 *    misma verdad dicha a quien corresponde, no dos cálculos.
 */

/** Quién está leyendo: ella sobre sí misma, o la administración sobre ella. */
export type VacationVoice = 'own' | 'other';

/**
 * Un periodo tal y como sale de `app.vacation_periods`. NO trae el número de
 * días: la fila lo guarda, pero aquí se deriva de las fechas con el mismo
 * contador que usa el dominio. Si el número viniera de fuera y no cuadrara con
 * las fechas, esta capa escribiría «99 días» mientras el saldo dice 15, y la
 * pantalla se contradiría a sí misma en el mismo renglón.
 */
export interface VacationHistoryPeriodRow {
  id: string;
  startsOn: string;
  endsOn: string;
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
   * Cuando el periodo cruza el aniversario del contrato, cuántos de sus días
   * caen en ESTE año. Sin esto, «del 1 al 10 de marzo · 10 días» dentro del
   * bloque del segundo año parecería que gasta diez días de ese año, y gasta
   * cuatro.
   */
  splitLabel: string | null;
}

export interface VacationYearView {
  /** Año de contrato: 1 el primero, 2 el segundo… No es un año natural. */
  index: number;
  /** Primer día del año de contrato. */
  startsOn: string;
  /** Último día del año de contrato. */
  endsOn: string;
  /** «Segundo año · 5 mar 2026 – 4 mar 2027». */
  label: string;
  /** El año de contrato en curso, el que la gente mira primero. */
  current: boolean;
  /**
   * Días pactados de este año, ya prorrateados si el contrato termina dentro.
   * `null` cuando quien mira no puede ver los términos del contrato: la familia
   * no administradora ve los días disfrutados (son un hecho de la casa) pero no
   * el derecho anual, que es lo pactado. Un cero en su lugar sería una cifra
   * inventada.
   */
  entitledDays: number | null;
  takenDays: number;
  /** Lo que quedará al terminar el año. Negativo si se pasó de lo pactado. */
  remainingDays: number | null;
  /** Días ya ganados a día de hoy. `null` sin acceso a lo pactado. */
  accruedDays: number | null;
  /** Devengado menos disfrutado: lo que tiene ahora mismo. Puede ser negativo. */
  availableNowDays: number | null;
  /** La frase del año entera, en la voz de quien mira. */
  headline: string;
  /**
   * «A 1 sep 2026 llevas devengados 15 de los 30 días del año», sólo en el año
   * en curso. En uno ya cerrado el devengo es el derecho entero y repetirlo en
   * cada bloque del historial sería llenar la pantalla de números que no dicen
   * nada; en uno que aún no ha empezado sería un cero sin sentido.
   */
  accruedNote: string | null;
  /** Explicación del prorrateo del último año, o null. */
  prorationNote: string | null;
  /** Aviso de que se han apuntado más días de los pactados, o null. */
  excessNote: string | null;
  /** Días disfrutados por delante de lo devengado, sin dramatizarlo. O null. */
  advanceNote: string | null;
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
  /** Del año de contrato más reciente al primero. Todos, no solo el corriente. */
  years: VacationYearView[];
  /** true si no hay ni un solo periodo apuntado en ningún año. */
  empty: boolean;
  /**
   * Por qué no salen los días pactados, cuando no salen. null cuando sí salen.
   */
  entitlementNote: string | null;
}

function days(count: number): string {
  return `${count} ${Math.abs(count) === 1 ? 'día' : 'días'}`;
}

/**
 * Los años de contrato se dicen con el ordinal que usaría una persona hasta el
 * décimo; a partir de ahí «el año 11», porque «undécimo» suena a otra cosa y
 * nadie lo diría en voz alta.
 */
const ORDINALS = [
  'primer',
  'segundo',
  'tercer',
  'cuarto',
  'quinto',
  'sexto',
  'séptimo',
  'octavo',
  'noveno',
  'décimo'
] as const;

/** «segundo año» · «año 12». En minúscula: casi siempre va dentro de una frase. */
export function contractYearName(index: number): string {
  const ordinal = ORDINALS[index - 1];
  return ordinal ? `${ordinal} año` : `año ${index}`;
}

/** «Segundo año · 5 mar 2026 – 4 mar 2027». */
export function contractYearLabel(year: ContractYear): string {
  const name = contractYearName(year.index);
  return `${name[0]?.toLocaleUpperCase('es') ?? ''}${name.slice(1)} · ${dateLabel(
    year.startsOn
  )} – ${dateLabel(year.endsOn)}`;
}

/**
 * Derecho anual que rige un año de contrato concreto.
 *
 * Para un año ya cerrado se pregunta por su último día, no por hoy: si el
 * contrato subió de 30 a 32 días a mitad del segundo año, el historial del
 * primero tiene que seguir diciendo 30. Para el año en curso se pregunta por
 * hoy, que es lo que la migración 0020 y su ADR fijaron («se aplica el de la
 * última versión ya en vigor»). Sin ninguna versión en vigor todavía se toma la
 * primera, porque el derecho de un contrato recién firmado no es cero.
 */
export function annualVacationDaysForContractYear(
  versions: readonly VacationEntitlementRow[],
  year: ContractYear,
  today: string
): number {
  const onDate = year.endsOn < today ? year.endsOn : today;
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
  yearName: string,
  entitled: number | null,
  taken: number,
  remaining: number | null
): string {
  const you = voice === 'own';
  const has = you ? 'has disfrutado' : 'ha disfrutado';
  const left = you ? 'Te quedan' : 'Le quedan';
  const belong = you ? 'te tocan' : 'le tocan';

  // Sin acceso a lo pactado solo se puede afirmar lo que se apuntó, y eso es
  // exactamente lo que se dice. Ni un número redondo de relleno.
  if (entitled === null || remaining === null) {
    return taken === 0
      ? `En el ${yearName} no consta ningún día de vacaciones.`
      : `En el ${yearName} constan ${days(taken)} de vacaciones.`;
  }

  if (taken === 0) {
    return `De los ${days(entitled)} que ${belong} en el ${yearName}, todavía no ${has} ninguno.`;
  }
  if (remaining < 0) {
    return (
      `En el ${yearName} ${has} ${days(taken)} y el contrato reconoce ${days(entitled)}: ` +
      `hay ${days(-remaining)} de más.`
    );
  }
  if (remaining === 0) {
    return `De los ${days(entitled)} que ${belong} en el ${yearName}, ${has} todos.`;
  }
  return `De los ${days(entitled)} que ${belong} en el ${yearName}, ${has} ${taken}. ${left} ${remaining}.`;
}

function periodView(
  row: VacationHistoryPeriodRow,
  yearName: string,
  today: string,
  daysThisYear: number
): VacationHistoryPeriodView {
  const state = periodState(row, today);
  // Los días salen de las fechas, con el contador del dominio. Es el mismo que
  // reparte el periodo entre años, así que la coletilla del reparto y el número
  // grande no pueden decir cosas distintas.
  const calendarDays = vacationCalendarDays(row.startsOn, row.endsOn);
  return {
    id: row.id,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    rangeLabel: vacationRangeLabel(row.startsOn, row.endsOn),
    // Lo anulado no suma, y la lista no debe insinuar que sí con un número al
    // lado. El número original se conserva en el detalle, que es donde se
    // explica qué pasó.
    daysLabel: state === 'voided' ? '—' : days(calendarDays),
    state,
    stateLabel: STATE_LABELS[state],
    detail:
      state === 'voided'
        ? `Eran ${days(calendarDays)}. Anuladas${row.voidReason ? `: ${row.voidReason}` : ''}`
        : row.note || 'Vacaciones',
    splitLabel:
      state !== 'voided' && daysThisYear < calendarDays
        ? `${days(daysThisYear)} de estas caen en el ${yearName}`
        : null
  };
}

/**
 * El historial de una persona: todos los años de contrato, del más reciente al
 * primero, con lo anulado a la vista como anulado.
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
  const currentYear = contractYearOn(input.agreementStartsOn, input.today);

  // El último año con algo que decir: el que corre hoy, o más allá si ya hay
  // días apuntados para el siguiente. Un contrato terminado no llega más lejos
  // del año en el que terminó, aunque el calendario siga.
  let lastIndex = currentYear?.index ?? 1;
  // …salvo que haya días apuntados más allá de ese final. El comando no deja
  // apuntar fuera del acuerdo, pero mira los límites en el momento de apuntar y
  // nada en la base lo sostiene después: el día que una baja fije el fin del
  // contrato hacia atrás, los periodos ya apuntados caerían fuera de todos los
  // años y desaparecerían de la pantalla sin que nadie se enterara. Un periodo
  // apuntado se enseña siempre; el año en el que cae ya dirá que el contrato no
  // reconoce esos días, que es la conversación que hay que tener.
  let lastPeriodIndex = 0;
  for (const period of input.periods) {
    const year = contractYearOn(input.agreementStartsOn, period.endsOn);
    if (year !== null && year.index > lastPeriodIndex) lastPeriodIndex = year.index;
  }
  lastIndex = Math.max(lastIndex, lastPeriodIndex);
  if (input.agreementEndsOn !== null) {
    const closing = contractYearOn(input.agreementStartsOn, input.agreementEndsOn);
    lastIndex = Math.max(Math.min(lastIndex, closing?.index ?? 1), lastPeriodIndex);
  }

  // Sin ninguna versión visible no se puede decir cuántos días le tocan. Es el
  // caso de la familia no administradora: la RLS le enseña los periodos —lo que
  // pasó en la casa— pero no los términos del contrato.
  const entitlementKnown = input.versions.length > 0;
  const you = input.own;

  const years: VacationYearView[] = [];
  for (let index = lastIndex; index >= 1; index -= 1) {
    const year = contractYear(input.agreementStartsOn, index);
    const yearName = contractYearName(index);
    // El primer año recoge además lo anterior al contrato, por la misma razón
    // que el último recoge lo posterior: sin ese suelo, un periodo apuntado
    // antes del inicio no saldría en ninguna parte. Se lista con sus fechas y
    // con la coletilla diciendo que ninguno de esos días cae dentro del año.
    const touching = input.periods.filter(
      (period) =>
        period.startsOn <= year.endsOn && (index === 1 || period.endsOn >= year.startsOn)
    );
    const balance = vacationYearBalance({
      contractYearIndex: index,
      annualVacationDays: annualVacationDaysForContractYear(input.versions, year, input.today),
      agreementStartsOn: input.agreementStartsOn,
      agreementEndsOn: input.agreementEndsOn,
      periods: touching
        .filter((period) => period.status === 'recorded')
        .map((period) => ({ startsOn: period.startsOn, endsOn: period.endsOn })),
      asOf: input.today
    });
    const entitledDays = entitlementKnown ? balance.entitledDays : null;
    const remainingDays = entitlementKnown ? balance.remainingDays : null;
    const accruedDays = entitlementKnown ? balance.accruedDays : null;
    const availableNowDays = entitlementKnown ? balance.availableNowDays : null;
    const current = currentYear !== null && currentYear.index === index;

    years.push({
      index,
      startsOn: year.startsOn,
      endsOn: year.endsOn,
      label: contractYearLabel(year),
      current,
      entitledDays,
      takenDays: balance.takenDays,
      remainingDays,
      accruedDays,
      availableNowDays,
      headline: yearHeadline(voice, yearName, entitledDays, balance.takenDays, remainingDays),
      // El devengo lleva la fecha dicha porque sin ella no significa nada: «15
      // de 30 días» sólo se entiende sabiendo a qué día se ha mirado.
      accruedNote:
        current && accruedDays !== null && entitledDays !== null
          ? `A ${dateLabel(input.today)} ${you ? 'llevas' : 'lleva'} devengados ` +
            `${accruedDays} de los ${days(entitledDays)} del año.`
          : null,
      prorationNote:
        entitlementKnown && balance.prorated
          ? `El contrato termina dentro del ${yearName}: cubre ${days(balance.coveredDays)} de ` +
            `los ${balance.daysInContractYear}, así que de los ` +
            `${days(balance.annualVacationDays)} del año ${you ? 'te tocan' : 'le tocan'} ` +
            `${balance.entitledDays}.`
          : null,
      excessNote:
        remainingDays !== null && remainingDays < 0
          ? 'Se han apuntado más días de los que reconoce el contrato. Casa Clara no lo corrige ' +
            'sola: lo enseña para que lo habléis y decidáis qué hacer.'
          : null,
      // Sólo cuando ha gastado por delante de lo devengado y AÚN le quedan días
      // del año: si ya se pasó de lo pactado, lo que hay que decir es el exceso
      // y no dos avisos que se pisan. No es una alarma, es una explicación: dar
      // las vacaciones en agosto de un año de contrato que acaba en marzo es lo
      // normal, no un descuadre.
      advanceNote:
        current && availableNowDays !== null && availableNowDays < 0 && (remainingDays ?? 0) >= 0
          ? `${you ? 'Has' : 'Ha'} disfrutado ${days(-availableNowDays)} por delante de lo ` +
            'devengado a día de hoy. Es lo corriente cuando las vacaciones se cogen antes de ' +
            'que acabe el año de contrato; no hay nada que corregir.'
          : null,
      periods: touching
        .slice()
        .sort((left, right) => right.startsOn.localeCompare(left.startsOn))
        .map((period) =>
          periodView(
            period,
            yearName,
            input.today,
            vacationDaysInWindow(period, year.startsOn, year.endsOn)
          )
        )
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
    // Vacío es «no hay nada QUE VER», no «no hay nada guardado». Contando las
    // filas de entrada, un periodo que no cupiera en ningún año dejaría la
    // pantalla sin él y sin el aviso de que no hay nada: mentiría dos veces.
    empty: years.every((year) => year.periods.length === 0),
    entitlementNote: entitlementKnown
      ? null
      : 'Los días de vacaciones que le corresponden al año son parte de lo pactado, y eso solo lo ' +
        'ven quien administra el hogar y la propia persona. Aquí constan los días apuntados.'
  };
}
