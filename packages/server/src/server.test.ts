import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { API_VERSION, type CriticalSnapshotV1 } from "@housekeeper/contracts";

import {
  canonicalJson,
  canonicalSha256,
  signCriticalSnapshot,
  verifyCriticalSnapshot,
} from "./index.js";

describe("primitivas del servidor", () => {
  it("canoniza objetos sin depender del orden de propiedades", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalSha256({ a: 1, b: 2 })).toBe(canonicalSha256({ b: 2, a: 1 }));
  });

  it("firma snapshots y detecta cualquier alteración", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const unsigned: Omit<CriticalSnapshotV1, "signature"> = {
      apiVersion: API_VERSION,
      schemaVersion: 1,
      householdId: "household",
      membershipId: "membership",
      version: "1",
      etag: "etag",
      cursor: "cursor",
      generatedAt: "2026-08-07T08:00:00.000Z",
      expiresAt: "2026-08-08T08:00:00.000Z",
      payload: { emergency: [], contacts: [], dietaryFlags: [], today: {}, wikiPages: [] },
    };
    const signed = signCriticalSnapshot(
      unsigned,
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(verifyCriticalSnapshot(signed, publicPem)).toBe(true);
    expect(verifyCriticalSnapshot({ ...signed, cursor: "tampered" }, publicPem)).toBe(false);
  });
});
