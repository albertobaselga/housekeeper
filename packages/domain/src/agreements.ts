import { addCalendarDays, isIsoDateString, localDate } from "./dates.js";
import { invariant } from "./errors.js";

export interface AgreementVersion {
  id: string;
  validFrom: string;
  validTo: string | null;
  monthlySalaryCents: bigint;
}

/**
 * Resuelve la versión del acuerdo vigente en una fecha. Se mantiene la firma y
 * los errores históricos (TypeError/RangeError) porque server y web dependen de ella.
 */
export function agreementVersionForDate(
  versions: readonly AgreementVersion[],
  onDate: string,
): AgreementVersion {
  if (!isIsoDateString(onDate)) throw new TypeError("La fecha debe usar el formato YYYY-MM-DD");
  const matches = versions
    .filter(
      (version) =>
        version.validFrom <= onDate && (version.validTo === null || version.validTo >= onDate),
    )
    .sort((left, right) => right.validFrom.localeCompare(left.validFrom));
  const selected = matches[0];
  if (!selected) throw new RangeError(`No hay una versión laboral vigente el ${onDate}`);
  return selected;
}

function assertAgreementVersion(version: AgreementVersion): void {
  invariant(version.id.trim().length > 0, "INVALID_AGREEMENT_VERSION", "La versión necesita un id.");
  invariant(
    isIsoDateString(version.validFrom),
    "INVALID_AGREEMENT_DATE",
    `validFrom no es una fecha válida: ${version.validFrom}`,
  );
  invariant(
    version.validTo === null || isIsoDateString(version.validTo),
    "INVALID_AGREEMENT_DATE",
    `validTo no es una fecha válida: ${String(version.validTo)}`,
  );
  invariant(
    version.validTo === null || version.validTo >= version.validFrom,
    "INVALID_AGREEMENT_INTERVAL",
    "validTo no puede ser anterior a validFrom.",
  );
  invariant(
    version.monthlySalaryCents >= 0n,
    "INVALID_AGREEMENT_RATE",
    "El salario mensual no puede ser negativo.",
  );
}

/**
 * Valida la línea temporal inmutable de versiones: intervalos cerrados
 * [validFrom, validTo] sin solapes ni huecos ambiguos, y como mucho un tramo
 * abierto (validTo null) que debe ser el último. Devuelve la línea ordenada.
 */
export function validateAgreementTimeline(
  versions: readonly AgreementVersion[],
): readonly AgreementVersion[] {
  invariant(versions.length > 0, "AGREEMENT_VERSION_NOT_FOUND", "No se aportaron versiones del acuerdo.");
  const sorted = [...versions].sort((left, right) => left.validFrom.localeCompare(right.validFrom));
  const ids = new Set<string>();

  for (let index = 0; index < sorted.length; index += 1) {
    const version = sorted[index] as AgreementVersion;
    assertAgreementVersion(version);
    invariant(!ids.has(version.id), "DUPLICATE_AGREEMENT_VERSION", `Id de versión duplicado: ${version.id}`);
    ids.add(version.id);

    const previous = sorted[index - 1];
    if (previous) {
      invariant(
        version.validFrom > previous.validFrom,
        "DUPLICATE_EFFECTIVE_DATE",
        "Dos versiones no pueden compartir fecha de inicio de vigencia.",
      );
      invariant(
        previous.validTo !== null,
        "OPEN_INTERVAL_NOT_LAST",
        "Solo la última versión puede tener vigencia abierta.",
      );
      invariant(
        previous.validTo < version.validFrom,
        "OVERLAPPING_AGREEMENT_VERSIONS",
        "Las vigencias de dos versiones no pueden solaparse.",
      );
    }
  }

  return Object.freeze(sorted);
}

/**
 * Alta append-only de una versión futura, nunca retroactiva: la nueva versión
 * no puede empezar antes de `earliestAllowedValidFrom` (normalmente hoy) ni
 * reescribir tramos ya vigentes. Si el último tramo estaba abierto, se cierra
 * el día anterior al inicio de la nueva versión.
 */
export function appendAgreementVersion(
  versions: readonly AgreementVersion[],
  next: AgreementVersion,
  earliestAllowedValidFrom: string,
): readonly AgreementVersion[] {
  const timeline = validateAgreementTimeline(versions);
  const latest = timeline.at(-1) as AgreementVersion;
  assertAgreementVersion(next);
  invariant(
    isIsoDateString(earliestAllowedValidFrom),
    "INVALID_AGREEMENT_DATE",
    `La fecha mínima permitida no es válida: ${earliestAllowedValidFrom}`,
  );
  invariant(
    next.validFrom >= earliestAllowedValidFrom,
    "RETROACTIVE_AGREEMENT_VERSION",
    "Una nueva versión del acuerdo no puede entrar en vigor antes de la fecha permitida.",
  );
  invariant(
    next.validFrom > latest.validFrom && (latest.validTo === null || next.validFrom > latest.validTo),
    "NON_APPEND_AGREEMENT_VERSION",
    "Una nueva versión debe añadirse al final de la línea temporal, sin reescribir tramos.",
  );

  const closedLatest: AgreementVersion =
    latest.validTo === null
      ? { ...latest, validTo: addCalendarDays(localDate(next.validFrom), -1) }
      : latest;

  return validateAgreementTimeline([...timeline.slice(0, -1), closedLatest, next]);
}
