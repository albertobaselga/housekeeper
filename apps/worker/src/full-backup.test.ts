import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { S3Client } from "@aws-sdk/client-s3";

// @ts-expect-error el comando de copia es JavaScript puro (script de operación).
import { downloadBucket, safeTarget } from "../scripts/full-backup.mjs";

/**
 * `pnpm backup:full` es la única copia de seguridad que el propietario ha
 * pedido: manual, completa y a demanda. La mitad de base la cubre `pg_dump` +
 * `pg_restore --list`; la mitad de adjuntos es esta, y usa el MISMO SDK de S3
 * que la app, así que sirve igual para MinIO que para el endpoint S3 de
 * Supabase Storage. Aquí se ejercita contra un S3 falso: paginación incluida,
 * porque un bucket con más de una página que se copie a medias sería el peor
 * fallo posible en una herramienta de copias.
 */

const OBJECTS: Record<string, string> = {
  "hogar/attachments/aaaa1111.jpg": "primer justificante",
  "hogar/attachments/bbbb2222.pdf": "segundo justificante",
  "hogar/attachments/cccc3333.png": "tercer justificante",
};

function listXml(keys: string[], nextToken: string | null): string {
  const contents = keys
    .map((key) => `<Contents><Key>${key}</Key><Size>${OBJECTS[key]!.length}</Size></Contents>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>housekeeper</Name>
  <IsTruncated>${nextToken ? "true" : "false"}</IsTruncated>
  ${nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ""}
  ${contents}
</ListBucketResult>`;
}

/** S3 falso: dos páginas de listado y GET de cada objeto. No valida firmas. */
function startFakeS3(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const keys = Object.keys(OBJECTS);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.searchParams.get("list-type") === "2") {
        const second = url.searchParams.get("continuation-token") === "pagina-2";
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(second ? listXml(keys.slice(2), null) : listXml(keys.slice(0, 2), "pagina-2"));
        return;
      }
      // /<bucket>/<clave>
      const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
      const body = OBJECTS[key];
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

describe("copia manual de adjuntos (pnpm backup:full)", () => {
  let server: Server;
  let client: S3Client;

  beforeAll(async () => {
    const started = await startFakeS3();
    server = started.server;
    client = new S3Client({
      endpoint: `http://127.0.0.1:${started.port}`,
      region: "eu-central-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "prueba", secretAccessKey: "prueba" },
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("descarga TODAS las páginas del bucket con su contenido intacto", async () => {
    const directory = mkdtempSync(join(tmpdir(), "housekeeper-backup-"));
    const result = await downloadBucket(client, "housekeeper", directory);

    expect(result).toEqual({ objects: 3, bytes: Object.values(OBJECTS).join("").length });
    for (const [key, body] of Object.entries(OBJECTS)) {
      expect(readFileSync(join(directory, key), "utf8")).toBe(body);
    }
  });

  it("una clave con ../ no puede escribir fuera del destino", () => {
    const base = "/tmp/housekeeper-copia";
    expect(safeTarget(base, "hogar/attachments/x.jpg")).toBe("/tmp/housekeeper-copia/hogar/attachments/x.jpg");
    expect(() => safeTarget(base, "../../etc/passwd")).toThrow(/fuera del destino/);
  });
});
