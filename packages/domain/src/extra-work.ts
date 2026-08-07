export type ExtraWorkStatus =
  | "requested"
  | "accepted"
  | "performed"
  | "performed_pending_resolution"
  | "resolved"
  | "rejected"
  | "cancelled";

export type ExtraWorkResolution = "money" | "time_off";

export interface ExtraWorkEvent {
  id: string;
  status: ExtraWorkStatus;
  durationMinutes: number;
  requestedBy: string;
  approvedBy: string | null;
  performedAt: string | null;
  resolution: ExtraWorkResolution | null;
  frozenUnitRateCents: bigint | null;
  frozenAmountCents: bigint | null;
  permanentCreditMinutes: number;
}

export type ExtraWorkAction =
  | { type: "accept"; approvedBy: string }
  | { type: "reject" }
  | { type: "cancel" }
  | { type: "mark_performed"; performedAt: string }
  | { type: "report_unapproved_work"; performedAt: string }
  | {
      type: "resolve";
      approvedBy: string;
      resolution: ExtraWorkResolution;
      unitRateCents: bigint;
      amountCents: bigint;
      creditMinutes?: number;
    };

export class InvalidExtraWorkTransition extends Error {
  constructor(status: ExtraWorkStatus, action: ExtraWorkAction["type"]) {
    super(`Transición de jornada extra no permitida: ${status} -> ${action}`);
    this.name = "InvalidExtraWorkTransition";
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} debe ser un entero positivo`);
  }
}

export function transitionExtraWork(
  event: Readonly<ExtraWorkEvent>,
  action: ExtraWorkAction,
): ExtraWorkEvent {
  const next: ExtraWorkEvent = { ...event };

  if (action.type === "accept" && event.status === "requested") {
    next.status = "accepted";
    next.approvedBy = action.approvedBy;
    return next;
  }

  if (action.type === "reject" && event.status === "requested") {
    next.status = "rejected";
    return next;
  }

  if (action.type === "cancel" && event.status === "accepted") {
    next.status = "cancelled";
    return next;
  }

  if (action.type === "mark_performed" && event.status === "accepted") {
    next.status = "performed";
    next.performedAt = action.performedAt;
    return next;
  }

  if (
    action.type === "report_unapproved_work" &&
    event.status === "requested"
  ) {
    next.status = "performed_pending_resolution";
    next.performedAt = action.performedAt;
    return next;
  }

  if (
    action.type === "resolve" &&
    (event.status === "performed" ||
      event.status === "performed_pending_resolution")
  ) {
    if (action.unitRateCents < 0n || action.amountCents < 0n) {
      throw new RangeError("Las tarifas congeladas no pueden ser negativas");
    }
    const creditMinutes = action.creditMinutes ?? event.durationMinutes;
    if (action.resolution === "time_off") {
      assertPositiveInteger(creditMinutes, "creditMinutes");
      if (action.amountCents !== 0n) {
        throw new RangeError("Una compensación en descanso debe valer 0 céntimos");
      }
    } else if (creditMinutes !== 0) {
      throw new RangeError("Una resolución en dinero no genera saldo de descanso");
    }

    next.status = "resolved";
    next.approvedBy = action.approvedBy;
    next.resolution = action.resolution;
    next.frozenUnitRateCents = action.unitRateCents;
    next.frozenAmountCents = action.amountCents;
    // Decisión adaptada del brief: el crédito no tiene fecha de caducidad.
    next.permanentCreditMinutes = creditMinutes;
    return next;
  }

  throw new InvalidExtraWorkTransition(event.status, action.type);
}
