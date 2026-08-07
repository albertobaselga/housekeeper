import { describe, expect, it } from "vitest";

import { REDACTED, createLogger, errorCode, type LogLevel } from "./logging.js";

function capture(): { lines: string[]; levels: LogLevel[]; sink: (line: string, level: LogLevel) => void } {
  const lines: string[] = [];
  const levels: LogLevel[] = [];
  return { lines, levels, sink: (line, level) => (lines.push(line), levels.push(level), undefined) };
}

const NOW = () => new Date("2026-08-07T10:00:00.000Z");

describe("createLogger: JSON de una línea con redacción por allowlist", () => {
  it("redacta todo campo fuera de la allowlist (email, nota, importe)", () => {
    const { lines, sink } = capture();
    const log = createLogger("test", { sink, now: NOW });

    log.error("payment failed", {
      email: "ana.real@gmail.com",
      nota: "pagó en efectivo en el portal 3",
      importeCents: 145330,
      userId: "8f14e45f-ceea-4e17-a8f1-0e4b7a2d9c01",
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      time: "2026-08-07T10:00:00.000Z",
      level: "error",
      scope: "test",
      msg: "payment failed",
      email: REDACTED,
      nota: REDACTED,
      importeCents: REDACTED,
      userId: REDACTED,
    });
  });

  it("deja pasar las claves permitidas con valores técnicos", () => {
    const { lines, sink } = capture();
    const log = createLogger("worker", { sink, now: NOW });

    log.info("job completed", {
      householdId: "10000000-0000-4000-8000-000000000001",
      operationId: "3d2f8a10-1111-4222-8333-444455556666",
      jobId: "9a000000-0000-4000-8000-000000000009",
      jobType: "notification.settlement_due",
      count: 3,
      counts: { created: 2, updated: 1 },
      ms: 42,
      code: "42501",
      status: 403,
    });

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["householdId"]).toBe("10000000-0000-4000-8000-000000000001");
    expect(entry["operationId"]).toBe("3d2f8a10-1111-4222-8333-444455556666");
    expect(entry["jobId"]).toBe("9a000000-0000-4000-8000-000000000009");
    expect(entry["jobType"]).toBe("notification.settlement_due");
    expect(entry["count"]).toBe(3);
    expect(entry["counts"]).toEqual({ created: 2, updated: 1 });
    expect(entry["ms"]).toBe(42);
    expect(entry["code"]).toBe("42501");
    expect(entry["status"]).toBe(403);
  });

  it("incluso en claves permitidas, emails y UUIDs no técnicos JAMÁS pasan", () => {
    const { lines, sink } = capture();
    const log = createLogger("web", { sink, now: NOW });

    log.warn("suspicious", {
      code: "ana.real@gmail.com",
      status: "8f14e45f-ceea-4e17-a8f1-0e4b7a2d9c01",
      counts: { detalle: "texto libre" as unknown as number },
    });

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["code"]).toBe(REDACTED);
    expect(entry["status"]).toBe(REDACTED);
    expect(entry["counts"]).toEqual({ detalle: REDACTED });
  });

  it("la salida es exactamente una línea aunque el contenido traiga saltos", () => {
    const { lines, sink } = capture();
    const log = createLogger("web", { sink, now: NOW });
    log.info("línea 1\nlínea 2", { nota: "a\nb" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "línea 1\nlínea 2", nota: REDACTED });
  });

  it("los campos no pueden pisar la envolvente (time/level/scope/msg)", () => {
    const { lines, sink } = capture();
    const log = createLogger("web", { sink, now: NOW });
    log.info("real", { msg: "falso", level: "debug", scope: "otro", time: "1999" });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["msg"]).toBe("real");
    expect(entry["level"]).toBe("info");
    expect(entry["scope"]).toBe("web");
    expect(entry["time"]).toBe("2026-08-07T10:00:00.000Z");
  });

  it("cada nivel emite con su etiqueta y nivel de sink", () => {
    const { lines, levels, sink } = capture();
    const log = createLogger("web", { sink, now: NOW });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });
});

describe("errorCode", () => {
  it("prefiere el code estable del error (estilo Postgres) y nunca el mensaje", () => {
    expect(errorCode({ code: "42501", message: "permission denied for ana.real@gmail.com" })).toBe("42501");
  });

  it("cae al nombre de la clase de error y a unknown para valores opacos", () => {
    expect(errorCode(new TypeError("Teléfono inválido"))).toBe("TypeError");
    expect(errorCode("cadena")).toBe("unknown");
    expect(errorCode(null)).toBe("unknown");
  });

  it("descarta codes que no parecen códigos (emails o textos larguísimos)", () => {
    expect(errorCode({ code: "ana.real@gmail.com" })).toBe("unknown");
    expect(errorCode({ code: "x".repeat(80) })).toBe("unknown");
  });
});
