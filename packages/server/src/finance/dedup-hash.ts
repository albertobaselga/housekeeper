import { createHash } from "node:crypto";

import { dedupKey } from "@housekeeper/domain/finance";

/** sha256 hex de la cadena canónica del dominio (compatible con los hashes migrados). */
export function computeDedupHash(row: Parameters<typeof dedupKey>[0]): string {
  return createHash("sha256").update(dedupKey(row), "utf8").digest("hex");
}
