import { describe, expect, it } from "vitest";

import {
  API_VERSION,
  assertSnapshotFresh,
  hasCapability,
  isMoneyCents,
  isRole,
  type CriticalSnapshotV1,
} from "./index.js";

const snapshot = (generatedAt: string, expiresAt: string): CriticalSnapshotV1 => ({
  apiVersion: API_VERSION,
  schemaVersion: 1,
  householdId: "household",
  membershipId: "membership",
  version: "1",
  etag: "etag",
  cursor: "cursor",
  generatedAt,
  expiresAt,
  signature: "signature",
  payload: {
    emergency: [],
    contacts: [],
    dietaryFlags: [],
    today: {},
    wikiPages: [],
  },
});

describe("contratos públicos", () => {
  it("deniega roles desconocidos", () => {
    expect(isRole("family_admin")).toBe(true);
    expect(isRole("owner")).toBe(false);
  });

  it("aplica permisos mínimos a helper y viewer", () => {
    expect(hasCapability("helper", "content.read")).toBe(true);
    expect(hasCapability("helper", "settlement.read")).toBe(false);
    expect(hasCapability("viewer", "calendar.read")).toBe(true);
    expect(hasCapability("viewer", "menu.read")).toBe(false);
  });

  it("representa dinero como céntimos enteros serializables", () => {
    expect(isMoneyCents("145330")).toBe(true);
    expect(isMoneyCents("-10000")).toBe(true);
    expect(isMoneyCents("14.53")).toBe(false);
  });

  it("rechaza snapshots con concesiones superiores a 24 horas", () => {
    const now = Date.parse("2026-08-07T10:00:00.000Z");
    expect(() =>
      assertSnapshotFresh(
        snapshot("2026-08-07T09:00:00.000Z", "2026-08-08T09:00:01.000Z"),
        now,
      ),
    ).toThrow(/24 horas/);
  });
});
