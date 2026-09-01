import { createHash } from "node:crypto";

import { canonicalJson } from "@housekeeper/contracts";

export { canonicalJson };

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
