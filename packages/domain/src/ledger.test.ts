import { describe, expect, it } from "vitest";

import {
  DomainRuleError,
  appendLedgerEntry,
  emptyLedgerProjection,
  projectLedger,
  type LedgerEntry,
} from "./index.js";

function minuteEntry(overrides: Partial<LedgerEntry<"minute">>): LedgerEntry<"minute"> {
  return {
    id: "L-1",
    accountId: "descanso-ana",
    sequence: 1,
    unit: "minute",
    kind: "credit",
    delta: 480n,
    effectiveOn: "2026-03-23",
    recordedAt: "2026-03-24T09:00:00Z",
    sourceType: "extra_work_event",
    sourceId: "EW-109",
    reversesEntryId: null,
    ...overrides,
  };
}

function domainCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error.code;
    throw error;
  }
  throw new Error("Se esperaba un DomainRuleError");
}

describe("libro append-only de saldos permanentes", () => {
  it("proyecta saldo, totales y orden a partir de las anotaciones", () => {
    const projected = projectLedger("descanso-ana", "minute", [
      minuteEntry({ id: "L-1", sequence: 1, delta: 1440n }),
      minuteEntry({
        id: "L-2",
        sequence: 2,
        kind: "debit",
        delta: -480n,
        sourceType: "time_off_request",
        sourceId: "TO-1",
      }),
    ]);
    expect(projected.balance).toBe(960n);
    expect(projected.totalCredits).toBe(1440n);
    expect(projected.totalDebits).toBe(480n);
    expect(projected.entryIds).toEqual(["L-1", "L-2"]);
    expect(projected.lastSequence).toBe(2);
  });

  it("cada anotación produce una proyección nueva; la anterior no cambia", () => {
    const first = appendLedgerEntry(
      emptyLedgerProjection("descanso-ana", "minute"),
      minuteEntry({}),
    );
    const second = appendLedgerEntry(
      first,
      minuteEntry({ id: "L-2", sequence: 2, kind: "debit", delta: -100n }),
    );
    expect(first.balance).toBe(480n);
    expect(second.balance).toBe(380n);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second.entries["L-1"])).toBe(true);
  });

  it("rechaza huecos de secuencia, duplicados y deltas cero", () => {
    const projection = projectLedger("descanso-ana", "minute", [minuteEntry({})]);
    expect(domainCode(() => appendLedgerEntry(projection, minuteEntry({ id: "L-3", sequence: 3 }))))
      .toBe("LEDGER_SEQUENCE_GAP");
    expect(domainCode(() => appendLedgerEntry(projection, minuteEntry({ sequence: 2 }))))
      .toBe("DUPLICATE_LEDGER_ENTRY");
    expect(domainCode(() => appendLedgerEntry(projection, minuteEntry({ id: "L-2", sequence: 2, delta: 0n }))))
      .toBe("ZERO_LEDGER_ENTRY");
  });

  it("obliga a que el signo case con el tipo de anotación", () => {
    const empty = emptyLedgerProjection("descanso-ana", "minute");
    expect(domainCode(() => appendLedgerEntry(empty, minuteEntry({ kind: "credit", delta: -1n }))))
      .toBe("INVALID_LEDGER_SIGN");
    expect(domainCode(() => appendLedgerEntry(empty, minuteEntry({ kind: "debit", delta: 1n }))))
      .toBe("INVALID_LEDGER_SIGN");
    // Un ajuste puede ir en cualquier sentido, pero sigue exigiendo origen trazable.
    const adjusted = appendLedgerEntry(empty, minuteEntry({ kind: "adjustment", delta: -30n }));
    expect(adjusted.balance).toBe(-30n);
  });

  it("una corrección es una reversa exacta y solo puede aplicarse una vez", () => {
    const projection = projectLedger("descanso-ana", "minute", [
      minuteEntry({ id: "L-1", sequence: 1, delta: 1440n }),
      minuteEntry({ id: "L-2", sequence: 2, kind: "debit", delta: -480n }),
    ]);
    const reversal = minuteEntry({
      id: "L-3",
      sequence: 3,
      kind: "reversal",
      delta: 480n,
      sourceType: "correction",
      sourceId: "COR-1",
      reversesEntryId: "L-2",
    });
    const reversed = appendLedgerEntry(projection, reversal);
    expect(reversed.balance).toBe(1440n);
    expect(projection.balance).toBe(960n);

    expect(domainCode(() => appendLedgerEntry(projection, { ...reversal, delta: 400n })))
      .toBe("REVERSAL_AMOUNT_MISMATCH");
    expect(domainCode(() =>
      appendLedgerEntry(reversed, { ...reversal, id: "L-4", sequence: 4 }),
    )).toBe("LEDGER_ENTRY_ALREADY_REVERSED");
    expect(domainCode(() =>
      appendLedgerEntry(reversed, {
        ...reversal,
        id: "L-4",
        sequence: 4,
        delta: -480n,
        reversesEntryId: "L-3",
      }),
    )).toBe("REVERSAL_OF_REVERSAL");
  });

  it("AC-03: el crédito de descanso no caduca; el saldo persiste años después", () => {
    const projected = projectLedger("descanso-ana", "minute", [
      minuteEntry({ id: "L-1", sequence: 1, delta: 1440n, effectiveOn: "2025-03-23" }),
      minuteEntry({
        id: "L-2",
        sequence: 2,
        kind: "debit",
        delta: -480n,
        effectiveOn: "2031-06-01",
        recordedAt: "2031-06-01T10:00:00Z",
        sourceType: "time_off_request",
        sourceId: "TO-99",
      }),
    ]);
    // Seis años después el resto del crédito sigue disponible: no existe expiración.
    expect(projected.balance).toBe(960n);
    expect("expiresOn" in minuteEntry({})).toBe(false);
  });
});
