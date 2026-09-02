import type { Pool } from 'pg';

import type { Role } from '@housekeeper/contracts';
import { createLogger, computeMenuSlotHash, withAuthorizedTransaction } from '@housekeeper/server';
import {
  cadenceClause,
  occurrencesBetween,
  pendingFor,
  weekdayName,
  PENDING_LOOKBACK_DAYS,
  type RoutineOverduePolicy,
  type RoutineSchedule
} from '@housekeeper/domain';

import {
  buildVacationCarryoverProposals,
  dateLabel,
  employmentTabHref,
  formatCents,
  formatMinutes,
  parseCents,
  periodLabel,
  type VacationCarryoverProposalView
} from '$lib/employment/model';
import { addDays, mondayOf } from '$lib/food/dates';
import type { MealSlot } from '$lib/food/commands';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';
import {
  ROUTINE_RULE_COLUMNS,
  routineScheduleFrom,
  type RoutineRuleRow
} from './routine-rules.server';
import { buildVacationNews, type VacationNewsView } from './vacations.server';

const log = createLogger('web:today');

/**
 * «Hoy» real (UX-P1-1): proyección ligera leída de Postgres bajo RLS con la
 * fecha real de Madrid, el menú del día, las rutinas que tocan y un bloque
 * «Necesita tu decisión» por rol con enlace directo (1 click) a la pantalla
 * —y ancla, si existe— donde se resuelve cada cosa. Todo corre dentro de UNA
 * withAuthorizedTransaction (patrón employment.server.ts): es la base de datos
 * quien decide qué filas ve cada rol. Devuelve null solo sin pool (demo sin
 * DATABASE_URL) o sin membresía autorizada; la página cae entonces a la
 * fixture de demostración.
 *
 * TODO lo que se ve —agrupación, orden, cortes, encabezados, contadores,
 * literales y hasta el chip optimista de «Hecha ✓»— se calcula AQUÍ y viaja
 * como marcado. No es purismo: el presupuesto que vigila
 * `apps/web/scripts/verify-today-bundle.mjs` mide el JavaScript de arranque de
 * esta ruta, y el HTML servido no cuenta. Cada cadena que se arma en el
 * servidor es un formateador que el móvil no descarga. Por el mismo motivo el
 * generador de recurrencia (`@housekeeper/domain`) se importa desde este módulo
 * `.server.ts` y no desde el componente.
 */

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
const MADRID_HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  hour: 'numeric',
  hourCycle: 'h23'
});
const AGENDA_TIME = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const HEADER_LABEL = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'Europe/Madrid'
});
/** «lun, 11 ago»: la fecha del titular de estado, que cabe en una línea. */
const STATE_LABEL = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Madrid'
});

export const MEAL_LABELS: Readonly<Record<MealSlot, string>> = {
  desayuno: 'Desayuno',
  almuerzo: 'Almuerzo',
  comida: 'Comida',
  merienda: 'Merienda',
  cena: 'Cena'
};

export interface TodayDecisionItem {
  /** Clave estable para keyed each y asserts (p. ej. `extra-<uuid>`). */
  key: string;
  title: string;
  detail: string;
  /** Destino que resuelve el asunto en 1 click (ancla incluida si existe). */
  href: string;
  /** Verbo del enlace («Revisar», «Confirmar»…). */
  cta: string;
  /**
   * `news` = hay algo que saber, no algo que decidir. El bloque de Hoy lleva
   * las dos cosas porque las dos son «pendientes de ti», pero el título de la
   * sección tiene que decir la verdad de lo que hay dentro: llamar «decisión»
   * a enterarse de que le han apuntado vacaciones sería insinuar que hay algo
   * que aprobar, y el propietario decidió que no lo hay.
   */
  kind?: 'news';
  /**
   * Asunto que además se resuelve AQUÍ, sin salir de Hoy (Ola D-5). El enlace
   * a la pantalla completa se mantiene: esto es un atajo, no un sustituto.
   */
  inline?: { kind: 'accept_extra'; id: string };
}

export interface TodayMenuSlotView {
  id: string;
  meal: MealSlot;
  mealLabel: string;
  groupName: string;
  /** Título de la receta o el texto libre del hueco. */
  dish: string;
  isRecipe: boolean;
  notes: string;
  /** Confirmación vigente (hash al día); null = hueco sin contenido que confirmar. */
  confirmed: boolean;
  /**
   * Hash canónico del contenido leído en ESTA carga. Es lo que permite
   * confirmar el hueco desde Hoy sin pasar por Menú: si el plato cambia entre
   * medias, el servidor responde conflicto en vez de confirmar otra cosa.
   */
  contentHash: string;
}

/** Cuántas filas pendientes se ven sin desplegar: a 390 px son una pantalla. */
export const PENDING_ROWS_VISIBLE = 6;

/**
 * Hasta dónde mira «Esta semana»: seis días, no siete. El séptimo cae en el
 * MISMO día de la semana que hoy, y «el jueves» dicho un jueves se lee como
 * hoy. Con seis, cada grupo lleva un nombre de día distinto y ninguno se
 * confunde con el de hoy, que es justo lo que E5.3 pide («el día nombrado, no
 * una lista plana de fechas»).
 */
export const WEEK_AHEAD_DAYS = 6;

/**
 * A partir de cuántas apariciones en esos días una rutina deja de repetirse día
 * a día y pasa a la línea de resumen. Tres es el corte honesto: con dos
 * apariciones («los lunes y los jueves») ver los dos días ayuda a planificar;
 * con tres o más la lista se convierte en la misma frase repetida.
 */
const WEEK_REPEAT_THRESHOLD = 3;

/** Fila accionable de «lo que toca hoy»: una rutina y UNA ocurrencia suya. */
export interface TodayRoutineRow {
  /** Clave de la FILA, no de la rutina: una rutina puede traer atrasada y de hoy. */
  key: string;
  routineId: string;
  title: string;
  details: string;
  /** La ocurrencia concreta que se marcaría al pulsar. */
  dueOn: string;
  /** Segunda línea: «Tocaba el jueves». Vacía en las de hoy: es hoy, siempre. */
  note: string;
  /**
   * Chip optimista ya escrito: «Hecha ✓ · próxima el mar, 18 ago». Viene del
   * servidor porque predecirlo en el navegador costaba importar la aritmética
   * de recurrencia y un `Intl.DateTimeFormat` al arranque de Hoy.
   */
  doneChip: string;
}

/** Lo marcado HOY, que es la ventana en la que un toque por error se deshace. */
export interface TodayDoneRoutineRow {
  key: string;
  routineId: string;
  title: string;
  details: string;
  dueOn: string;
  /**
   * El MISMO chip que se pinta al marcar: «Hecha ✓ · próxima el mar, 18 ago».
   * Idéntico a propósito —la aplicación habla una vez—, de modo que la fila no
   * cambia de idioma cuando pasa de recién marcada a marcada.
   */
  chip: string;
  /** «Tocaba el jueves» si se marcó una atrasada; vacío si era la de hoy. */
  note: string;
  /** Quien la marcó puede deshacerla; la administración, cualquiera (E5.1). */
  canUndo: boolean;
}

/**
 * Un bloque de filas pendientes con su encabezado. La agrupación se decide
 * AQUÍ y no en la plantilla: cada `{#each}` y cada `{#if}` de un componente
 * Svelte son bytes en el móvil, y el presupuesto de arranque de Hoy se mide.
 */
export interface TodayRoutineBlock {
  key: string;
  /** «Se quedó pendiente», «Hoy», «Ver las 4 restantes»; vacío si no lleva. */
  heading: string;
  /** Va tras un `<details>` plegado: es el corte de seis filas. */
  folded: boolean;
  rows: TodayRoutineRow[];
}

/** Un día de «Esta semana», con el día NOMBRADO y sin nada que pulsar. */
export interface TodayWeekGroup {
  key: string;
  /** «Mañana», «El jueves». */
  label: string;
  items: { key: string; title: string; details: string }[];
}

/**
 * Todo lo que la tarjeta de rutinas pinta, ya resuelto. Los tres bloques van en
 * este orden y significan cosas distintas: lo atrasado es deuda, lo de hoy es
 * el trabajo y lo de la semana es información para decidir si da tiempo hoy o
 * se planifica (E5.3) — por eso lo último no es accionable.
 */
export interface TodayRoutinesView {
  /** «5 por hacer» / «Todo hecho ✓» / '' cuando no toca nada. */
  countChip: string;
  /** Lo pendiente, ya agrupado y cortado, en el orden en que se pinta. */
  blocks: TodayRoutineBlock[];
  /** Solo cadencias semanales o mayores (`carry`), UNA línea por rutina. */
  overdue: TodayRoutineRow[];
  /** Las de hoy que caben sin desplegar. */
  today: TodayRoutineRow[];
  /** Las pendientes por encima del corte, tras un `<details>` nativo. */
  more: TodayRoutineRow[];
  done: TodayDoneRoutineRow[];
  /** «3 hechas hoy»; vacío si no hay ninguna. */
  doneLabel: string;
  /** Agrupado por día y con el día nombrado. Vacío si no viene nada. */
  week: TodayWeekGroup[];
  /** Las de casi todos los días, dichas una vez en lugar de siete. */
  weekRepeats: { key: string; title: string; cadence: string }[];
  /** Cuántas atrasadas hay: lo único de rutinas que sigue siendo una decisión. */
  overdueCount: number;
  /** ¿Hay algo, pendiente o hecho? Si no, la tarjeta dice que hoy no toca nada. */
  anyToday: boolean;
  /** «Ninguna rutina toca hoy.» o ''. Cadena y no bandera: la plantilla la
   *  pinta siempre y `:empty` esconde la vacía, que es un bloque condicional
   *  menos en el arranque de Hoy. */
  emptyNote: string;
}

export interface TodayAgendaItem {
  id: string;
  /** «16:45», o «Todo el día» para eventos de día completo. */
  timeLabel: string;
  allDay: boolean;
  title: string;
  /** Nombre del calendario enlazado del que viene el evento. */
  sourceLabel: string;
}

export interface TodayOverview {
  householdId: string;
  role: Role;
  todayISO: string;
  /** «Viernes, 7 de agosto», calculado con la fecha real (Europe/Madrid). */
  dateLabel: string;
  /** «Lun, 11 ago · 3 por hacer»: el h1 de la pantalla, una línea, el estado. */
  stateLabel: string;
  greeting: string;
  decisions: TodayDecisionItem[];
  /**
   * Título del bloque, escrito aquí y no en la plantilla porque depende de lo
   * que haya dentro (decisiones, novedades o las dos cosas). De paso el grafo
   * de JavaScript inicial de Hoy se queda con una expresión en vez de con tres
   * literales y un ternario, que en esa pantalla es presupuesto.
   */
  decisionsTitle: string;
  /** «3 asuntos» / «1 asunto», ya con su plural resuelto. */
  decisionsCount: string;
  menu: TodayMenuSlotView[];
  routines: TodayRoutinesView;
  /** Eventos de hoy de los calendarios enlazados (Ola E); RLS deja fuera al apoyo. */
  agenda: TodayAgendaItem[];
}

// ─── Filas crudas que alimentan el mapeo puro (unit-testeable) ───────────────

export type TodayExtraStatus = 'requested' | 'accepted' | 'performed' | 'performed_pending_resolution';

export interface TodayExtraRow {
  id: string;
  /** Acuerdo del que cuelga: con varias personas empleadas, quién es. */
  agreementId: string;
  workedOn: string;
  durationMinutes: number;
  note: string;
  status: TodayExtraStatus;
  employeeMembershipId: string;
}

export interface TodayExpenseRow {
  id: string;
  agreementId: string;
  incurredOn: string;
  description: string;
  amountCents: string;
}

export interface TodaySettlementRow {
  id: string;
  agreementId: string;
  periodStart: string;
  dueOn: string;
  status: string;
  paidCents: string;
  pendingCents: string;
  receiptConfirmed: boolean;
}

export interface UnconfirmedSlotRow {
  id: string;
  onDate: string;
  meal: MealSlot;
}

export interface TodayDecisionFacts {
  householdId: string;
  role: Role;
  membershipId: string;
  todayISO: string;
  extras: TodayExtraRow[];
  pendingExpenses: TodayExpenseRow[];
  settlements: TodaySettlementRow[];
  /** Huecos de hoy±3 días sin confirmación vigente. */
  unconfirmedSlots: UnconfirmedSlotRow[];
  /**
   * Cuántas rutinas visibles se quedaron sin hacer (atraso real). No la lista:
   * una rutina de HOY no es una decisión, es el trabajo, y listarlas una a una
   * convertía este bloque en una copia de la tarjeta que hay justo debajo.
   */
  overdueRoutineCount: number;
  /**
   * Vacaciones apuntadas o anuladas que ella todavía no ha visto, ya resueltas
   * por el motor del dominio. null = no es empleada, o no hay nada que contar.
   */
  vacationNews: VacationNewsView | null;
  /**
   * Años de contrato cerrados con días sin disfrutar y sin decisión, con el
   * texto YA ESCRITO por el servidor. Vacío para quien no administra.
   *
   * Que venga escrito no es comodidad: el presupuesto de bytes del arranque de
   * Hoy deja poco margen y una rama nueva en la plantilla se lo come, así que
   * esto tiene que ser un elemento más de la lista de decisiones y nada más.
   */
  vacationCarryovers: readonly VacationCarryoverProposalView[];
}

function extraDetail(extra: TodayExtraRow): string {
  const base = `${dateLabel(extra.workedOn)} · ${formatMinutes(extra.durationMinutes)}`;
  return extra.note ? `${base} · ${extra.note}` : base;
}

/**
 * Bloque «Necesita tu decisión» por rol. Puro y determinista: recibe filas ya
 * filtradas por RLS y devuelve items ordenados con su href de resolución.
 *
 * - family_admin: jornadas extra requested/performed_pending_resolution,
 *   gastos pendientes, huecos de menú (hoy±3d) sin confirmar y liquidaciones
 *   cerradas con importe pendiente de pago.
 * - family_member: gastos y huecos, sin jornadas ni liquidaciones.
 * - employee_live_in: sus jornadas aceptadas por marcar realizadas, el cobro
 *   confirmable (cerrada, pagada del todo y sin confirmación) y su rutina de hoy.
 * - helper/viewer: nada que decidir (solo menú y rutinas visibles).
 */
export function buildTodayDecisions(facts: TodayDecisionFacts): TodayDecisionItem[] {
  // Cada asunto enlaza al expediente de SU persona y a la pestaña que lo
  // resuelve: las jornadas y los gastos en Conceptos, las cuentas en Pagos. El
  // hogar puede emplear a varias y el expediente enseña el de una: sin decir
  // cuál, el enlace de una decisión de la segunda aterrizaría en el de la
  // primera, donde su ancla no existe. La cadena la escribe el constructor
  // único de `model.ts`, que es el que sabe escaparla.
  const base = `/h/${facts.householdId}`;
  const items: TodayDecisionItem[] = [];
  const isAdmin = facts.role === 'family_admin';
  const isMember = facts.role === 'family_member';
  const isEmployee = facts.role === 'employee_live_in';

  if (isAdmin) {
    for (const extra of facts.extras) {
      if (extra.status === 'requested') {
        items.push({
          key: `extra-${extra.id}`,
          title: 'Jornada extra solicitada',
          detail: extraDetail(extra),
          href: employmentTabHref(facts.householdId, 'conceptos', extra.agreementId, `extra-${extra.id}`),
          cta: 'Revisar',
          inline: { kind: 'accept_extra', id: extra.id }
        });
      } else if (extra.status === 'performed_pending_resolution') {
        items.push({
          key: `extra-${extra.id}`,
          title: 'Jornada extra hecha: falta decidir la compensación',
          detail: extraDetail(extra),
          href: employmentTabHref(facts.householdId, 'conceptos', extra.agreementId, `extra-${extra.id}`),
          cta: 'Decidir'
        });
      }
    }
  }

  /*
   * Los gastos, SOLO a quien administra. Este bloque decía `isAdmin || isMember`
   * y el detalle pinta el importe con `formatCents`: la portada le enseñaba a la
   * familia no administradora la descripción, la fecha y los euros de lo que la
   * empleada se había adelantado —y encima con un «Revisar» que esa persona no
   * puede ejecutar, porque aprobar un gasto no está entre sus capacidades—.
   *
   * Quien corta el dato de verdad es la RLS (migración 0038: `expenses_read`
   * pasó a `include_family_member => false`, así que `facts.pendingExpenses`
   * llega vacío). Esto es la defensa de arriba, para que la pantalla no vuelva a
   * afirmar un derecho que la base ya no concede.
   */
  if (isAdmin) {
    for (const expense of facts.pendingExpenses) {
      items.push({
        key: `gasto-${expense.id}`,
        title: 'Gasto pendiente de aprobar',
        detail: `${expense.description} · ${formatCents(expense.amountCents)} · ${dateLabel(expense.incurredOn)}`,
        href: employmentTabHref(facts.householdId, 'conceptos', expense.agreementId, `gasto-${expense.id}`),
        cta: 'Revisar'
      });
    }
  }

  if (isAdmin || isMember) {
    if (facts.unconfirmedSlots.length > 0) {
      const sorted = [...facts.unconfirmedSlots].sort((a, b) => a.onDate.localeCompare(b.onDate));
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      items.push({
        key: 'menu-unconfirmed',
        title:
          sorted.length === 1
            ? `Comida del menú sin confirmar (${MEAL_LABELS[first.meal].toLocaleLowerCase('es')} del ${dateLabel(first.onDate)})`
            : `${sorted.length} comidas del menú sin confirmar`,
        detail:
          sorted.length === 1
            ? 'La cocina espera la confirmación.'
            : `Entre el ${dateLabel(first.onDate)} y el ${dateLabel(last.onDate)}.`,
        href: `${base}/menu?week=${mondayOf(first.onDate)}`,
        cta: 'Confirmar'
      });
    }
  }

  if (isAdmin) {
    // Los días de un año de contrato que ya se cerró: es una decisión, no una
    // novedad, y por eso va sin `kind: 'news'`. El texto lo escribe el servidor
    // entero —titular y detalle— para que aquí no haga falta ninguna rama nueva.
    for (const carryover of facts.vacationCarryovers) {
      items.push({
        key: `vacaciones-arrastre-${carryover.agreementId}-${carryover.sourceYearIndex}`,
        title: carryover.headline,
        detail: carryover.detail,
        href: employmentTabHref(facts.householdId, 'vacaciones', carryover.agreementId),
        cta: 'Decidir'
      });
    }
    for (const settlement of facts.settlements) {
      if (settlement.status === 'closed' && parseCents(settlement.pendingCents) > 0n) {
        items.push({
          key: `liquidacion-${settlement.id}`,
          title: `Cuenta de ${periodLabel(settlement.periodStart.slice(0, 7)).toLocaleLowerCase('es')} pendiente de pago`,
          detail: `Pendiente ${formatCents(settlement.pendingCents)} · vence el ${dateLabel(settlement.dueOn)}`,
          href: employmentTabHref(facts.householdId, 'pagos', settlement.agreementId),
          cta: 'Registrar pago'
        });
      }
    }
  }

  if (isEmployee) {
    // Lo primero de la lista, y con razón: es lo único que ella no puede
    // descubrir haciendo su trabajo. Una jornada por marcar o un cobro por
    // confirmar los tiene delante en su pantalla; unas vacaciones apuntadas
    // por otra persona, no. El aviso se apaga solo en cuanto las mira, así que
    // ni es un cartel permanente ni hay nada que descartar a mano.
    if (facts.vacationNews) {
      items.push({
        key: 'vacaciones-nuevas',
        title: facts.vacationNews.headline,
        detail: facts.vacationNews.detail ?? 'Míralas cuando quieras: quedan apuntadas en tu contrato.',
        href: `${base}/employment/vacaciones`,
        cta: 'Verlas',
        kind: 'news'
      });
    }
    for (const extra of facts.extras) {
      if (extra.status === 'accepted' && extra.employeeMembershipId === facts.membershipId) {
        items.push({
          key: `extra-${extra.id}`,
          title: 'Jornada aceptada: márcala cuando la realices',
          detail: extraDetail(extra),
          href: employmentTabHref(facts.householdId, 'conceptos', extra.agreementId, `extra-${extra.id}`),
          cta: 'Marcar realizada'
        });
      }
    }
    for (const settlement of facts.settlements) {
      if (
        settlement.status === 'closed' &&
        parseCents(settlement.pendingCents) === 0n &&
        parseCents(settlement.paidCents) > 0n &&
        !settlement.receiptConfirmed
      ) {
        items.push({
          key: `cobro-${settlement.id}`,
          title: `Cobro de ${periodLabel(settlement.periodStart.slice(0, 7)).toLocaleLowerCase('es')} por confirmar`,
          detail: `${formatCents(settlement.paidCents)} pagados · confirma que lo has recibido`,
          href: employmentTabHref(facts.householdId, 'pagos', settlement.agreementId),
          cta: 'Confirmar cobro'
        });
      }
    }
    // Una sola fila cuando hay atraso real, y ninguna cuando todo está al día
    // (§4.2). Antes se empujaba una fila por rutina que vencía: con diez
    // rutinas diarias esta sección era la tarjeta de rutinas otra vez.
    if (facts.overdueRoutineCount > 0) {
      items.push({
        key: 'rutinas-atrasadas',
        title:
          facts.overdueRoutineCount === 1
            ? 'Se quedó 1 rutina sin hacer'
            : `Se quedaron ${facts.overdueRoutineCount} rutinas sin hacer`,
        detail: 'Siguen pendientes del día que tocaban.',
        // La acción vive en esta misma página: ancla a la sección de rutinas.
        href: '#rutinas-de-hoy',
        cta: 'Ver'
      });
    }
  }

  return items;
}

// ─── Rutinas: de reglas a lo que la tarjeta pinta ───────────────────────────

/** Una rutina con su regla y sus hechos, tal y como sale de la base. */
export interface TodayRoutineFacts {
  id: string;
  title: string;
  details: string;
  /** `null` = «se hace, falta decidir cuándo»: nunca llega hasta aquí. */
  schedule: RoutineSchedule;
  policy: RoutineOverduePolicy;
  /** `due_on` de las finalizaciones VIVAS; las anuladas no cuentan (0031). */
  completedDueOns: string[];
  /** Lo marcado HOY, con quién lo marcó: la ventana en que se puede deshacer. */
  markedToday: { dueOn: string; byMembershipId: string }[];
}

export interface TodayViewer {
  membershipId: string;
  role: Role;
}

/** ISO 1=lunes … 7=domingo, sin tocar la zona del proceso. */
function isoWeekdayOf(dateISO: string): number {
  const weekday = new Date(`${dateISO}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000
  );
}

/**
 * Cómo se nombra un día pasado cercano. Dentro de la última semana el nombre
 * del día es lo que una persona reconoce («el jueves»); más allá deja de
 * identificar nada y hace falta la fecha.
 */
function pastDayLabel(dueOn: string, todayISO: string): string {
  const gap = daysBetween(dueOn, todayISO);
  if (gap === 1) return 'ayer';
  if (gap <= 6) return `el ${weekdayName(isoWeekdayOf(dueOn))}`;
  return `el ${dateLabel(dueOn)}`;
}

/** «Mañana» para el día siguiente; «El jueves» para el resto de la semana. */
function aheadDayLabel(dueOn: string, todayISO: string): string {
  if (daysBetween(todayISO, dueOn) === 1) return 'Mañana';
  const name = weekdayName(isoWeekdayOf(dueOn));
  return `El ${name}`;
}

const CHIP_DATE = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC'
});

/** El chip que se pinta al instante al marcar, ya resuelto en el servidor. */
function doneChipFor(next: string | null): string {
  if (!next) return 'Hecha ✓';
  return `Hecha ✓ · próxima el ${CHIP_DATE.format(new Date(`${next}T00:00:00Z`))}`;
}

/**
 * Lo que la tarjeta de rutinas enseña, y —tan importante— lo que no.
 *
 * Puro y determinista: recibe reglas y hechos ya filtrados por RLS y devuelve
 * cadenas listas para pintar. Se prueba sin base de datos y sin navegador.
 *
 * Tres reglas gobiernan el resultado y conviene tenerlas a la vista:
 *
 *   · UNA rutina diaria no hecha ayer NO es una deuda. Con `skip` la ocurrencia
 *     caduca al acabar su día; el atraso solo existe de semanal para arriba, y
 *     entonces se enseña UNA línea, la más antigua, nunca noventa.
 *   · «Esta semana» es información, no deberes: no se marca nada desde ahí. Y
 *     lo que se repite casi a diario se dice UNA vez con su cadencia, porque
 *     repetir «Ventilación» siete veces no ayuda a planificar nada.
 *   · Ni porcentajes, ni rachas, ni medias, ni colores que califiquen: el chip
 *     es CUENTA, no nota (AC-26 revisado). Aquí no se calcula ningún agregado
 *     que puntúe a nadie, y esa ausencia es deliberada.
 */
export function buildTodayRoutines(
  facts: readonly TodayRoutineFacts[],
  todayISO: string,
  viewer: TodayViewer
): TodayRoutinesView {
  const overdue: TodayRoutineRow[] = [];
  const dueToday: TodayRoutineRow[] = [];
  const done: TodayDoneRoutineRow[] = [];
  const weekRepeats: TodayRoutinesView['weekRepeats'] = [];
  const byDay = new Map<string, TodayWeekGroup['items']>();
  const isAdmin = viewer.role === 'family_admin';

  const weekFrom = addDays(todayISO, 1);
  const weekTo = addDays(todayISO, WEEK_AHEAD_DAYS);

  for (const fact of facts) {
    const completed = new Set(fact.completedDueOns);
    const pending = pendingFor(fact.schedule, fact.policy, completed, todayISO);

    if (pending.overdue) {
      // Al marcar la atrasada lo siguiente pendiente es la de hoy si la hay;
      // si no, la próxima futura. El chip tiene que decir la verdad de ESA fila.
      overdue.push({
        key: `${fact.id}:${pending.overdue}`,
        routineId: fact.id,
        title: fact.title,
        details: fact.details,
        dueOn: pending.overdue,
        note: `Tocaba ${pastDayLabel(pending.overdue, todayISO)}`,
        doneChip: doneChipFor(pending.due[0] ?? pending.upcoming[0] ?? null)
      });
    }
    if (pending.due.length > 0) {
      dueToday.push({
        key: `${fact.id}:${todayISO}`,
        routineId: fact.id,
        title: fact.title,
        details: fact.details,
        dueOn: todayISO,
        note: '',
        doneChip: doneChipFor(pending.upcoming[0] ?? null)
      });
    }

    for (const mark of fact.markedToday) {
      done.push({
        key: `${fact.id}:${mark.dueOn}`,
        routineId: fact.id,
        title: fact.title,
        details: fact.details,
        dueOn: mark.dueOn,
        // Mismo chip que el optimista: la fila no cambia de idioma al llegar
        // los datos frescos, y la prueba de extremo a extremo no tiene que
        // saber en cuál de los dos estados la pilló.
        chip: doneChipFor(pending.overdue ?? pending.due[0] ?? pending.upcoming[0] ?? null),
        note: mark.dueOn === todayISO ? '' : `Tocaba ${pastDayLabel(mark.dueOn, todayISO)}`,
        canUndo: isAdmin || mark.byMembershipId === viewer.membershipId
      });
    }

    // «Esta semana»: lo que viene DESPUÉS de hoy, para decidir si da tiempo hoy
    // o se planifica. Nada de esto es accionable.
    const ahead = occurrencesBetween(fact.schedule, weekFrom, weekTo).filter(
      (dueOn) => !completed.has(dueOn)
    );
    if (ahead.length >= WEEK_REPEAT_THRESHOLD) {
      weekRepeats.push({
        key: fact.id,
        title: fact.title,
        cadence: cadenceClause(fact.schedule)
      });
      continue;
    }
    for (const dueOn of ahead) {
      const items = byDay.get(dueOn) ?? [];
      items.push({ key: `${fact.id}:${dueOn}`, title: fact.title, details: fact.details });
      byDay.set(dueOn, items);
    }
  }

  const week: TodayWeekGroup[] = [...byDay.keys()]
    .sort()
    .map((dueOn) => ({
      key: dueOn,
      label: aheadDayLabel(dueOn, todayISO),
      items: byDay.get(dueOn) as TodayWeekGroup['items']
    }));

  // Corte a seis filas pendientes, atrasadas primero: el resto va tras un
  // `<details>` nativo, que cuesta cero bytes de JavaScript.
  const overdueVisible = overdue.slice(0, PENDING_ROWS_VISIBLE);
  const todayVisible = dueToday.slice(0, Math.max(0, PENDING_ROWS_VISIBLE - overdue.length));
  const more = [...overdue.slice(overdueVisible.length), ...dueToday.slice(todayVisible.length)];
  const pendingCount = overdue.length + dueToday.length;

  const blocks: TodayRoutineBlock[] = [];
  if (overdueVisible.length > 0) {
    blocks.push({ key: 'overdue', heading: 'Se quedó pendiente', folded: false, rows: overdueVisible });
  }
  if (todayVisible.length > 0) {
    // El encabezado «Hoy» solo tiene sentido si hay algo por encima de lo que
    // distinguirlo: en una tarjeta que ya se titula «Lo que toca hoy», decir
    // «Hoy» sin nada más sobra.
    blocks.push({
      key: 'today',
      heading: overdueVisible.length > 0 ? 'Hoy' : '',
      folded: false,
      rows: todayVisible
    });
  }
  if (more.length > 0) {
    blocks.push({
      key: 'more',
      heading: `Ver ${more.length === 1 ? 'la restante' : `las ${more.length} restantes`}`,
      folded: true,
      rows: more
    });
  }

  return {
    countChip:
      pendingCount > 0 ? `${pendingCount} por hacer` : done.length > 0 ? 'Todo hecho ✓' : '',
    blocks,
    overdue: overdueVisible,
    today: todayVisible,
    more,
    done,
    doneLabel: done.length > 0 ? `${done.length} ${done.length === 1 ? 'hecha' : 'hechas'} hoy` : '',
    week,
    weekRepeats,
    overdueCount: overdue.length,
    anyToday: pendingCount > 0 || done.length > 0,
    emptyNote: pendingCount > 0 || done.length > 0 ? '' : 'Ninguna rutina toca hoy.'
  };
}

/**
 * Cómo se llama el bloque según lo que haya caído dentro.
 *
 * Es una función y no un literal en la plantilla porque el bloque ya no
 * contiene solo decisiones. Titular «Necesita tu decisión» encima de «te han
 * apuntado vacaciones» le pediría a la empleada una aprobación que este hogar
 * no le pide; titular todo como «novedades» escondería que hay cosas
 * pendientes de verdad. Cada mezcla tiene su nombre.
 */
export function decisionsTitleFor(items: readonly TodayDecisionItem[]): string {
  const news = items.filter((item) => item.kind === 'news').length;
  if (news === 0) return 'Necesita tu decisión';
  if (news === items.length) return news === 1 ? 'Una novedad para ti' : 'Novedades para ti';
  return 'Novedades y decisiones';
}

/** «Buenos días» / «Buenas tardes» / «Buenas noches» según la hora de Madrid. */
export function greetingFor(hour: number): string {
  if (hour >= 6 && hour < 14) return 'Buenos días';
  if (hour >= 14 && hour < 21) return 'Buenas tardes';
  return 'Buenas noches';
}

/** «viernes, 7 de agosto» → «Viernes, 7 de agosto». */
export function headerDateLabel(todayISO: string): string {
  const raw = HEADER_LABEL.format(new Date(`${todayISO}T12:00:00Z`));
  return raw.charAt(0).toLocaleUpperCase('es') + raw.slice(1);
}

/**
 * El titular de Hoy: «Lun, 11 ago · 3 por hacer».
 *
 * Se escribe aquí y no en la plantilla por dos razones. La primera es de
 * diseño: el `h1` de esta pantalla decía «Buenas noches, Ana» a 32 px en dos
 * líneas —74 px de saludo a alguien que abre la aplicación todos los días— y
 * ahora dice en una línea de 24 px qué día es y cuánto queda, que es lo que se
 * ha venido a saber. La segunda es de presupuesto: montar la frase en el
 * cliente costaría un `Intl.DateTimeFormat` y un ternario en el grafo de
 * arranque de Hoy, que es exactamente lo que vigila verify-today-bundle.
 */
export function todayStateLabel(todayISO: string, countChip: string): string {
  const raw = STATE_LABEL.format(new Date(`${todayISO}T12:00:00Z`)).replace(/\.$/, '');
  const date = raw.charAt(0).toLocaleUpperCase('es') + raw.slice(1);
  return countChip ? `${date} · ${countChip}` : `${date} · nada pendiente`;
}

export async function loadTodayOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<TodayOverview | null> {
  if (!pool) return null;
  const todayISO = MADRID_DATE.format(now);
  const windowStart = addDays(todayISO, -3);
  const windowEnd = addDays(todayISO, 3);

  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      // Rutinas del rol (la RLS filtra por audiencia) con su REGLA, no con una
      // fecha ya resuelta. El prefiltro llega hasta el final de «Esta semana»,
      // y `next_due_hint` sirve para eso justamente porque es una cota INFERIOR:
      // si se queda anticuada solo puede quedarse atrás, así que selecciona de
      // más y el generador descarta; nunca puede esconder una rutina.
      //
      // El segundo brazo del OR rescata lo MARCADO HOY aunque su próxima fecha
      // ya esté lejos (una mensual recién hecha salta a dentro de un mes): sin
      // él, marcar una rutina la haría desaparecer de la pantalla en el acto y
      // no habría dónde deshacer el toque.
      const routineResult = await client.query<
        RoutineRuleRow & { id: string; title: string; details: string }
      >(
        `select routine.id,
                routine.title,
                routine.details,
                ${ROUTINE_RULE_COLUMNS}
           from app.routines as routine
          where routine.household_id = $1
            and routine.archived_at is null
            and routine.pattern is not null
            and (
              routine.next_due_hint <= $2::date
              or exists (
                select 1 from app.routine_completions as marked
                 where marked.household_id = routine.household_id
                   and marked.routine_id = routine.id
                   and marked.voided_at is null
                   and (marked.completed_at at time zone 'Europe/Madrid')::date = $3::date
              )
            )
          order by routine.title`,
        [householdId, addDays(todayISO, WEEK_AHEAD_DAYS), todayISO]
      );

      // Las finalizaciones VIVAS de la ventana que mira el generador, en una
      // sola consulta para todas las rutinas visibles. Las anuladas (0031) no
      // viajan: para el cálculo no existen, que es lo que hace que deshacer
      // devuelva la rutina al día que le tocaba.
      const completionResult = await client.query<{
        routineId: string;
        dueOn: string;
        byMembershipId: string;
        markedToday: boolean;
      }>(
        `select completion.routine_id as "routineId",
                completion.due_on::text as "dueOn",
                completion.completed_by_membership_id as "byMembershipId",
                (completion.completed_at at time zone 'Europe/Madrid')::date = $3::date as "markedToday"
           from app.routine_completions as completion
          where completion.household_id = $1
            and completion.voided_at is null
            and completion.due_on >= $2::date
          order by completion.due_on`,
        [householdId, addDays(todayISO, -PENDING_LOOKBACK_DAYS), todayISO]
      );

      const factsById = new Map<string, TodayRoutineFacts>();
      for (const row of routineResult.rows) {
        const schedule = routineScheduleFrom(row);
        if (!schedule) continue;
        factsById.set(row.id, {
          id: row.id,
          title: row.title,
          details: row.details,
          schedule,
          policy: row.overduePolicy,
          completedDueOns: [],
          markedToday: []
        });
      }
      for (const completion of completionResult.rows) {
        const fact = factsById.get(completion.routineId);
        if (!fact) continue;
        fact.completedDueOns.push(completion.dueOn);
        if (completion.markedToday) {
          fact.markedToday.push({
            dueOn: completion.dueOn,
            byMembershipId: completion.byMembershipId
          });
        }
      }
      const routines = buildTodayRoutines([...factsById.values()], todayISO, {
        membershipId: membership.id,
        role: membership.role
      });

      // Huecos de menú de hoy±3 días con su receta, grupo y confirmación. El
      // hash canónico se calcula en esta misma transacción (computeMenuSlotHash,
      // la función contra la que compara menu_slot.confirm): una confirmación
      // con hash antiguo cuenta como «sin confirmar».
      const slotResult = await client.query<{
        id: string;
        onDate: string;
        meal: MealSlot;
        groupName: string;
        freeText: string;
        notes: string;
        recipeTitle: string | null;
        confirmedHash: string | null;
      }>(
        `select slot.id,
                slot.on_date::text as "onDate",
                slot.meal::text as "meal",
                menu_group.name as "groupName",
                slot.free_text as "freeText",
                slot.notes,
                coalesce(revision.title, page.current_slug) as "recipeTitle",
                confirmation.content_hash as "confirmedHash"
           from app.menu_slots as slot
           join app.menu_groups as menu_group
             on menu_group.household_id = slot.household_id and menu_group.id = slot.group_id
           left join app.wiki_pages as page
             on page.household_id = slot.household_id and page.id = slot.recipe_page_id
           left join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
           left join app.menu_confirmations as confirmation
             on confirmation.household_id = slot.household_id and confirmation.slot_id = slot.id
          where slot.household_id = $1 and slot.on_date between $2 and $3
          order by slot.on_date, menu_group.name, slot.meal`,
        [householdId, windowStart, windowEnd]
      );

      const unconfirmedSlots: UnconfirmedSlotRow[] = [];
      const menu: TodayMenuSlotView[] = [];
      for (const slot of slotResult.rows) {
        const contentHash = await computeMenuSlotHash(client, householdId, slot.id);
        const hasContent = Boolean(slot.recipeTitle || slot.freeText);
        const confirmed = Boolean(contentHash && slot.confirmedHash === contentHash);
        if (hasContent && !confirmed) {
          unconfirmedSlots.push({ id: slot.id, onDate: slot.onDate, meal: slot.meal });
        }
        if (slot.onDate === todayISO) {
          menu.push({
            id: slot.id,
            meal: slot.meal,
            mealLabel: MEAL_LABELS[slot.meal] ?? slot.meal,
            groupName: slot.groupName,
            dish: slot.recipeTitle ?? slot.freeText,
            isRecipe: slot.recipeTitle !== null,
            notes: slot.notes,
            confirmed,
            contentHash: contentHash ?? ''
          });
        }
      }

      // Agenda del día desde los calendarios enlazados (Ola E). RLS aplica la
      // matriz calendar.read: al apoyo esta consulta le devuelve cero filas y
      // el bloque no aparece.
      const agendaResult = await client.query<{
        id: string;
        startsAt: Date;
        allDay: boolean;
        summary: string;
        sourceLabel: string;
      }>(
        `select id,
                starts_at as "startsAt",
                all_day as "allDay",
                summary,
                source_label as "sourceLabel"
           from app.ics_source_events
          where household_id = $1
            and (starts_at at time zone 'Europe/Madrid')::date = $2::date
          order by all_day desc, starts_at, summary`,
        [householdId, todayISO]
      );
      const agenda: TodayAgendaItem[] = agendaResult.rows.map((row) => ({
        id: row.id,
        timeLabel: row.allDay ? 'Todo el día' : AGENDA_TIME.format(row.startsAt),
        allDay: row.allDay,
        title: row.summary,
        sourceLabel: row.sourceLabel
      }));

      // Hechos laborales pendientes de TODOS los acuerdos visibles, no del
      // primero: un hogar puede emplear a varias personas y una decisión que no
      // se enseña es una decisión que no se toma. Para roles sin acceso laboral
      // (helper/viewer) la RLS devuelve cero filas y el bloque queda vacío; a
      // la empleada le devuelve el suyo y solo el suyo.
      const agreementResult = await client.query<{
        id: string;
        startsOn: string;
        endsOn: string | null;
        employeeName: string | null;
      }>(
        `select agreement.id,
                agreement.starts_on::text as "startsOn",
                agreement.ends_on::text as "endsOn",
                profile.display_name as "employeeName"
           from app.employment_agreements as agreement
           left join app.household_memberships as employee
             on employee.household_id = agreement.household_id
            and employee.id = agreement.employee_membership_id
           left join app.user_profiles as profile
             on profile.user_id = employee.user_id
          where agreement.household_id = $1
          order by (agreement.status = 'active') desc, agreement.starts_on desc`,
        [householdId]
      );
      const agreementIds = agreementResult.rows.map((row) => row.id);

      let extras: TodayExtraRow[] = [];
      let pendingExpenses: TodayExpenseRow[] = [];
      let settlements: TodaySettlementRow[] = [];
      if (agreementIds.length > 0) {
        const extrasResult = await client.query<TodayExtraRow>(
          `select id,
                  agreement_id as "agreementId",
                  worked_on::text as "workedOn",
                  duration_minutes as "durationMinutes",
                  note,
                  status::text as "status",
                  employee_membership_id as "employeeMembershipId"
             from app.extra_work_events
            where household_id = $1 and agreement_id = any($2::uuid[])
              and status in ('requested', 'accepted', 'performed', 'performed_pending_resolution')
            order by worked_on, requested_at`,
          [householdId, agreementIds]
        );
        extras = extrasResult.rows;

        const expensesResult = await client.query<TodayExpenseRow>(
          `select id,
                  agreement_id as "agreementId",
                  incurred_on::text as "incurredOn",
                  description,
                  amount_cents as "amountCents"
             from app.expenses
            where household_id = $1 and agreement_id = any($2::uuid[]) and status = 'pending'
            order by incurred_on, submitted_at`,
          [householdId, agreementIds]
        );
        pendingExpenses = expensesResult.rows;

        const settlementsResult = await client.query<{
          id: string;
          agreementId: string;
          periodStart: string;
          dueOn: string;
          status: string;
          paidCents: string;
          pendingCents: string;
          receiptConfirmedAt: string | null;
        }>(
          `select settlement.id,
                  settlement.agreement_id as "agreementId",
                  settlement.period_start::text as "periodStart",
                  settlement.due_on::text as "dueOn",
                  settlement.status::text as "status",
                  totals.paid_cents as "paidCents",
                  totals.pending_cents as "pendingCents",
                  confirmation.confirmed_at::text as "receiptConfirmedAt"
             from app.settlements as settlement
             join app.settlement_payment_totals as totals
               on totals.household_id = settlement.household_id
              and totals.settlement_id = settlement.id
             left join app.settlement_receipt_confirmations as confirmation
               on confirmation.household_id = settlement.household_id
              and confirmation.settlement_id = settlement.id
            where settlement.household_id = $1 and settlement.agreement_id = any($2::uuid[])
              and settlement.status = 'closed'
            order by settlement.period_start desc`,
          [householdId, agreementIds]
        );
        settlements = settlementsResult.rows.map((row) => ({
          id: row.id,
          agreementId: row.agreementId,
          periodStart: row.periodStart,
          dueOn: row.dueOn,
          status: row.status,
          paidCents: row.paidCents,
          pendingCents: row.pendingCents,
          receiptConfirmed: row.receiptConfirmedAt !== null
        }));
      }

      // Vacaciones que le han apuntado (o anulado) sin que ella lo sepa. Solo
      // se pregunta cuando quien mira es la empleada: para el resto del hogar
      // esto no es una novedad suya, es algo que acaba de hacer.
      //
      // El hecho es EL MISMO que pinta su sección de vacaciones —las filas de
      // `app.vacation_periods` con sus sellos de tiempo— comparado con la marca
      // de agua de `app.vacation_notice_marks`. No hay una tabla de avisos que
      // pueda desincronizarse del expediente, y la notificación al móvil que
      // vendrá después leerá esto mismo (docs/notificaciones.md).
      let vacationNews: VacationNewsView | null = null;
      if (membership.role === 'employee_live_in') {
        const vacationRows = await client.query<{
          startsOn: string;
          endsOn: string;
          status: 'recorded' | 'voided';
          recordedAt: Date;
          voidedAt: Date | null;
        }>(
          `select starts_on::text as "startsOn",
                  ends_on::text as "endsOn",
                  status::text as "status",
                  recorded_at as "recordedAt",
                  voided_at as "voidedAt"
             from app.vacation_periods
            where household_id = $1 and employee_membership_id = $2`,
          [householdId, membership.id]
        );
        if (vacationRows.rows.length > 0) {
          const mark = await client.query<{ seenThrough: Date }>(
            `select seen_through as "seenThrough"
               from app.vacation_notice_marks
              where household_id = $1 and membership_id = $2`,
            [householdId, membership.id]
          );
          vacationNews = buildVacationNews(
            vacationRows.rows.map((row) => ({
              startsOn: row.startsOn,
              endsOn: row.endsOn,
              status: row.status,
              recordedAt: row.recordedAt.toISOString(),
              voidedAt: row.voidedAt?.toISOString() ?? null
            })),
            mark.rows[0]?.seenThrough.toISOString() ?? null
          );
        }
      }

      // Años de contrato ya cerrados con días sin disfrutar y sin decisión.
      // Sólo para quien administra: es una decisión suya, y para el resto del
      // hogar la RLS no devuelve ni las versiones ni los arrastres.
      //
      // Se calcula al leer, como en la pestaña de Vacaciones: no hay fila hasta
      // que alguien decide, y por tanto no hace falta ni trabajo periódico ni
      // disparador por calendario, que aquí no existen.
      let vacationCarryovers: VacationCarryoverProposalView[] = [];
      if (membership.role === 'family_admin' && agreementIds.length > 0) {
        const [versions, vacationPeriods, decided] = await Promise.all([
          client.query<{
            agreementId: string;
            effectiveFrom: string;
            annualVacationDays: number;
            unusedVacationDayRateCents: string | null;
            terms: unknown;
          }>(
            `select agreement_id as "agreementId",
                    effective_from::text as "effectiveFrom",
                    annual_vacation_days as "annualVacationDays",
                    unused_vacation_day_rate_cents::text as "unusedVacationDayRateCents",
                    terms
               from app.agreement_versions
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by agreement_id, version_number`,
            [householdId, agreementIds]
          ),
          client.query<{ agreementId: string; startsOn: string; endsOn: string }>(
            `select agreement_id as "agreementId",
                    starts_on::text as "startsOn",
                    ends_on::text as "endsOn"
               from app.vacation_periods
              where household_id = $1 and agreement_id = any($2::uuid[])
                and status = 'recorded'`,
            [householdId, agreementIds]
          ),
          client.query<{ agreementId: string; sourceYearIndex: number }>(
            `select agreement_id as "agreementId", source_year_index as "sourceYearIndex"
               from app.vacation_carryovers
              where household_id = $1 and agreement_id = any($2::uuid[])`,
            [householdId, agreementIds]
          )
        ]);
        vacationCarryovers = agreementResult.rows.flatMap((agreement) =>
          buildVacationCarryoverProposals({
            agreementId: agreement.id,
            employeeLabel: agreement.employeeName?.trim() || 'Empleada del hogar',
            today: todayISO,
            agreementStartsOn: agreement.startsOn,
            agreementEndsOn: agreement.endsOn,
            versions: versions.rows.filter((row) => row.agreementId === agreement.id),
            periods: vacationPeriods.rows.filter((row) => row.agreementId === agreement.id),
            decidedYearIndexes: decided.rows
              .filter((row) => row.agreementId === agreement.id)
              .map((row) => row.sourceYearIndex)
          })
        );
      }

      const decisions = buildTodayDecisions({
        householdId,
        role: membership.role,
        membershipId: membership.id,
        todayISO,
        extras,
        pendingExpenses,
        settlements,
        unconfirmedSlots,
        overdueRoutineCount: routines.overdueCount,
        vacationNews,
        vacationCarryovers
      });

      const hour = Number(MADRID_HOUR.format(now));
      return {
        householdId,
        role: membership.role,
        todayISO,
        dateLabel: headerDateLabel(todayISO),
        stateLabel: todayStateLabel(todayISO, routines.countChip),
        greeting: greetingFor(hour),
        decisions,
        decisionsTitle: decisionsTitleFor(decisions),
        decisionsCount: `${decisions.length} ${decisions.length === 1 ? 'asunto' : 'asuntos'}`,
        menu,
        routines,
        agenda
      } satisfies TodayOverview;
    });
  } catch (cause) {
    return unreadable(log, 'today overview', cause);
  }
}
