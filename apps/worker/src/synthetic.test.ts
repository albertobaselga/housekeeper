import { describe, expect, it } from "vitest";

import { applySyntheticEmailPolicy, isSyntheticOnly } from "./integrations.js";

const EMAIL = { to: "familia@casa-clara.test", subject: "Liquidación pendiente", text: "Aviso" };

describe("isSyntheticOnly", () => {
  it("solo el literal 'true' activa el modo sintético", () => {
    expect(isSyntheticOnly({ ALLOW_SYNTHETIC_DATA_ONLY: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSyntheticOnly({ ALLOW_SYNTHETIC_DATA_ONLY: "TRUE" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSyntheticOnly({ ALLOW_SYNTHETIC_DATA_ONLY: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSyntheticOnly({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("applySyntheticEmailPolicy", () => {
  it("con el flag apagado la entrada pasa intacta (incluso a dominios reales)", () => {
    const real = { ...EMAIL, to: "ana.real@gmail.com" };
    expect(applySyntheticEmailPolicy(real, false)).toEqual(real);
  });

  it("en sintético antepone [SINTÉTICO] al asunto y admite los TLD de prueba", () => {
    for (const to of [
      "familia@casa-clara.test",
      "empleada@hogar.demo",
      "apoyo@fixtures.example",
      "visor@nunca.invalid",
      "MAYUSCULAS@CASA.TEST",
    ]) {
      const result = applySyntheticEmailPolicy({ ...EMAIL, to }, true);
      expect(result.to).toBe(to);
      expect(result.subject).toBe("[SINTÉTICO] Liquidación pendiente");
      expect(result.text).toBe(EMAIL.text);
    }
  });

  it("rechaza destinatarios reales con un error claro que no filtra la dirección", () => {
    for (const to of ["ana.real@gmail.com", "familia@casaclara.es", "test@testing.com"]) {
      let caught: unknown;
      try {
        applySyntheticEmailPolicy({ ...EMAIL, to }, true);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("ALLOW_SYNTHETIC_DATA_ONLY");
      expect(message).toContain(".demo, .test, .example, .invalid");
      expect(message).not.toContain(to);
    }
  });

  it("rechaza direcciones sin dominio interpretable", () => {
    expect(() => applySyntheticEmailPolicy({ ...EMAIL, to: "sin-arroba" }, true)).toThrow(
      /destinatario rechazado/,
    );
    expect(() => applySyntheticEmailPolicy({ ...EMAIL, to: "vacio@" }, true)).toThrow(
      /destinatario rechazado/,
    );
  });

  it("no se deja engañar por un dominio real que contenga '.test' en medio", () => {
    expect(() => applySyntheticEmailPolicy({ ...EMAIL, to: "x@sub.test.gmail.com" }, true)).toThrow(
      /destinatario rechazado/,
    );
  });
});
