import { describe, expect, it } from "vitest";

import {
  DomainRuleError,
  agreementVersionForDate,
  appendAgreementVersion,
  validateAgreementTimeline,
  type AgreementVersion,
} from "./index.js";

const v1: AgreementVersion = {
  id: "agreement-v1",
  validFrom: "2026-01-01",
  validTo: "2026-05-31",
  monthlySalaryCents: 140_000n,
};

const v2: AgreementVersion = {
  id: "agreement-v2",
  validFrom: "2026-06-01",
  validTo: null,
  monthlySalaryCents: 150_000n,
};

function domainCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error.code;
    throw error;
  }
  throw new Error("Se esperaba un DomainRuleError");
}

describe("resolución temporal de versiones del acuerdo", () => {
  it("resuelve en los límites exactos de vigencia", () => {
    expect(agreementVersionForDate([v1, v2], "2026-01-01").id).toBe("agreement-v1");
    expect(agreementVersionForDate([v1, v2], "2026-05-31").id).toBe("agreement-v1");
    expect(agreementVersionForDate([v1, v2], "2026-06-01").id).toBe("agreement-v2");
  });

  it("falla si no hay versión vigente en la fecha", () => {
    expect(() => agreementVersionForDate([v1], "2026-06-15")).toThrow(RangeError);
    expect(() => agreementVersionForDate([v1, v2], "2025-12-31")).toThrow(RangeError);
    expect(() => agreementVersionForDate([v1, v2], "15/06/2026")).toThrow(TypeError);
  });
});

describe("línea temporal inmutable del acuerdo", () => {
  it("ordena y congela una línea temporal válida", () => {
    const timeline = validateAgreementTimeline([v2, v1]);
    expect(timeline.map((version) => version.id)).toEqual(["agreement-v1", "agreement-v2"]);
    expect(Object.isFrozen(timeline)).toBe(true);
  });

  it("rechaza solapes, ids duplicados y tramos abiertos intermedios", () => {
    expect(domainCode(() =>
      validateAgreementTimeline([v1, { ...v2, validFrom: "2026-05-15" }]),
    )).toBe("OVERLAPPING_AGREEMENT_VERSIONS");
    expect(domainCode(() =>
      validateAgreementTimeline([v1, { ...v2, id: "agreement-v1" }]),
    )).toBe("DUPLICATE_AGREEMENT_VERSION");
    expect(domainCode(() =>
      validateAgreementTimeline([{ ...v1, validTo: null }, v2]),
    )).toBe("OPEN_INTERVAL_NOT_LAST");
    expect(domainCode(() => validateAgreementTimeline([]))).toBe("AGREEMENT_VERSION_NOT_FOUND");
    expect(domainCode(() =>
      validateAgreementTimeline([{ ...v1, monthlySalaryCents: -1n }]),
    )).toBe("INVALID_AGREEMENT_RATE");
  });

  it("no admite versiones retroactivas: junio no reescribe marzo", () => {
    const v3: AgreementVersion = {
      id: "agreement-v3",
      validFrom: "2026-03-15",
      validTo: null,
      monthlySalaryCents: 160_000n,
    };
    // Autoría el 20/03: una vigencia que empieza el 15/03 sería retroactiva.
    expect(domainCode(() => appendAgreementVersion([v1], v3, "2026-03-20")))
      .toBe("RETROACTIVE_AGREEMENT_VERSION");
  });

  it("añade al final y cierra el tramo abierto el día anterior", () => {
    const v3: AgreementVersion = {
      id: "agreement-v3",
      validFrom: "2026-09-01",
      validTo: null,
      monthlySalaryCents: 160_000n,
    };
    const timeline = appendAgreementVersion([v1, v2], v3, "2026-08-01");
    expect(timeline.map((version) => version.id))
      .toEqual(["agreement-v1", "agreement-v2", "agreement-v3"]);
    expect(timeline[1]?.validTo).toBe("2026-08-31");
    // La resolución por fecha sigue siendo coherente tras el alta.
    expect(agreementVersionForDate([...timeline], "2026-08-31").id).toBe("agreement-v2");
    expect(agreementVersionForDate([...timeline], "2026-09-01").id).toBe("agreement-v3");
  });

  it("rechaza altas que no sean estrictamente posteriores al último tramo", () => {
    const duplicate: AgreementVersion = {
      id: "agreement-v3",
      validFrom: "2026-05-31",
      validTo: null,
      monthlySalaryCents: 160_000n,
    };
    expect(domainCode(() => appendAgreementVersion([v1], duplicate, "2026-01-01")))
      .toBe("NON_APPEND_AGREEMENT_VERSION");
  });
});
