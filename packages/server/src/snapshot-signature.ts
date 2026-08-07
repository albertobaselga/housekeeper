import { sign, verify } from "node:crypto";

import type { CriticalSnapshotV1 } from "@casa-clara/contracts";

import { canonicalJson } from "./canonical-json.js";

type UnsignedSnapshot = Omit<CriticalSnapshotV1, "signature">;

export function signCriticalSnapshot(
  snapshot: UnsignedSnapshot,
  privateKeyPem: string,
): CriticalSnapshotV1 {
  const signature = sign(null, Buffer.from(canonicalJson(snapshot)), privateKeyPem).toString("base64url");
  return { ...snapshot, signature };
}

export function verifyCriticalSnapshot(
  snapshot: CriticalSnapshotV1,
  publicKeyPem: string,
): boolean {
  const { signature, ...unsigned } = snapshot;
  return verify(
    null,
    Buffer.from(canonicalJson(unsigned)),
    publicKeyPem,
    Buffer.from(signature, "base64url"),
  );
}
