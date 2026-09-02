import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "../database.js";
import { runPostImportPipeline, type PipelineReport } from "./pipeline.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";
const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };

// Piezas de la fixture 002_finance.sql que esta suite reutiliza tal cual.
const ACCOUNT_SHARED = "f1a00000-0000-4000-8000-000000000001";
const ACCOUNT_INVESTMENT = "f1a00000-0000-4000-8000-000000000002"; // transfer_refs: ["FIXTURE FONDO"]
const CATEGORY_SUPERMARKET = "f1c00000-0000-4000-8000-000000000002";
const BATCH = "f1800000-0000-4000-8000-000000000001";
const TX_PAYROLL_FIXTURE = "f1e00000-0000-4000-8000-000000000002";

const CHARGE_1 = randomUUID();
const CHARGE_2 = randomUUID();
const EXPENSE_WITH_RULE = randomUUID();

/** Sale de la transacción autorizada abortándola: todo lo que esta suite siembra
 * se deshace. El paquete corre con `fileParallelism: false` y esta base la
 * heredan las suites siguientes, que hacen conteos absolutos sobre el roble. */
class AbortarParaDeshacer extends Error {
  constructor(readonly resultado: Recogido) {
    super("aborta la transacción para dejar la fixture como estaba");
  }
}

interface Recogido {
  report: PipelineReport;
  mirrors: FilaLeida[];
  rows: Map<string, FilaLeida>;
}

interface FilaLeida {
  id: string;
  account_id: string;
  batch_id: string | null;
  amount_cents: string;
  status: string;
  category_id: string | null;
  transfer_group_id: string | null;
  recurrence: string | null;
  dedup_hash: string;
}

describe.runIf(Boolean(adminUrl))(
  "runPostImportPipeline sobre Postgres real: escrituras por conjuntos",
  () => {
    let appPool: pg.Pool;

    beforeAll(() => {
      const appUrl = new URL(adminUrl as string);
      appUrl.username = APP_LOGIN;
      appUrl.password = "integration-only";
      appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });
    });

    afterAll(async () => {
      await appPool?.end();
    });

    it("una sola pasada actualiza 3+ filas e inserta 2 espejos con el batch heredado", async () => {
      const seed = async (client: pg.PoolClient): Promise<void> => {
        // Datos ENTERAMENTE inventados, en la línea de la fixture.
        const rows: [string, string, string, string, string | null, string | null, string, string | null, string][] = [
          [CHARGE_1, BATCH, "2026-06-11", "TRASPASO A FIXTURE FONDO MAYO", null, null, "-12000", null, "it-f2-cargo-1"],
          [CHARGE_2, BATCH, "2026-06-12", "TRASPASO A FIXTURE FONDO JUNIO", null, null, "-13000", null, "it-f2-cargo-2"],
          [EXPENSE_WITH_RULE, BATCH, "2026-06-13", "COMPRA MERCADO EJEMPLO OTRA VEZ", "Mercado Ejemplo", "mercado ejemplo", "-2350", null, "it-f2-regla"],
        ];
        for (const [id, batch, opDate, concept, provider, providerNorm, amount, categoryId, hash] of rows) {
          await client.query(
            `insert into app.finance_transactions
               (id, household_id, account_id, batch_id, op_date, concept, provider,
                provider_norm, amount_cents, category_id, status, dedup_hash)
             values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::bigint, $10, 'pendiente', $11)`,
            [id, ROBLE, ACCOUNT_SHARED, batch, opDate, concept, provider, providerNorm, amount, categoryId, hash],
          );
        }
      };

      const read = async (client: pg.PoolClient, ids: string[]): Promise<Map<string, FilaLeida>> => {
        const res = await client.query<FilaLeida>(
          `select id, account_id, batch_id, amount_cents::text as amount_cents, status,
                  category_id, transfer_group_id, recurrence, dedup_hash
             from app.finance_transactions
            where household_id = $1 and id = any($2::uuid[])`,
          [ROBLE, ids],
        );
        return new Map(res.rows.map((r) => [r.id, r]));
      };

      const collected: Recogido = await withAuthorizedTransaction<Recogido>(appPool, ADMIN, ROBLE, async (client): Promise<Recogido> => {
        await seed(client);
        const report = await runPostImportPipeline(client, ROBLE);
        const mirrors = await client.query<FilaLeida>(
          `select id, account_id, batch_id, amount_cents::text as amount_cents, status,
                  category_id, transfer_group_id, recurrence, dedup_hash
             from app.finance_transactions
            where household_id = $1 and dedup_hash like 'invmirror-it-f2-%'
            order by dedup_hash`,
          [ROBLE],
        );
        const rows = await read(client, [CHARGE_1, CHARGE_2, EXPENSE_WITH_RULE, TX_PAYROLL_FIXTURE]);
        throw new AbortarParaDeshacer({ report, mirrors: mirrors.rows, rows });
      }).catch((error: unknown): Recogido => {
        if (error instanceof AbortarParaDeshacer) return error.resultado;
        throw error;
      });

      const { report, mirrors, rows } = collected;

      // 2 espejos en la misma pasada, en la cuenta de inversión, con el signo
      // invertido y heredando el batch_id del cargo que los origina.
      expect(report.steps.find((s) => s.name === "inversiones")?.affected).toBe(2);
      expect(mirrors).toHaveLength(2);
      for (const mirror of mirrors) {
        expect(mirror.account_id).toBe(ACCOUNT_INVESTMENT);
        expect(mirror.status).toBe("confirmada");
        expect(mirror.batch_id).toBe(BATCH);
        expect(mirror.transfer_group_id).not.toBeNull();
      }
      expect(mirrors.map((e) => e.amount_cents)).toEqual(["12000", "13000"]);

      // 3+ filas actualizadas por la ÚNICA sentencia de UPDATE: los dos cargos
      // quedan agrupados con su espejo y el tercero recategorizado por la regla.
      const charge1 = rows.get(CHARGE_1);
      const charge2 = rows.get(CHARGE_2);
      expect(charge1?.status).toBe("confirmada");
      expect(charge2?.status).toBe("confirmada");
      expect(charge1?.transfer_group_id).toBe(mirrors[0]?.transfer_group_id);
      expect(charge2?.transfer_group_id).toBe(mirrors[1]?.transfer_group_id);
      expect(charge1?.transfer_group_id).not.toBe(charge2?.transfer_group_id);
      expect(rows.get(EXPENSE_WITH_RULE)).toMatchObject({
        status: "sugerida_regla",
        category_id: CATEGORY_SUPERMARKET,
      });
      // Y el paso 7 escribió veredicto sobre una fila que ya estaba en la fixture:
      // la sentencia por conjuntos alcanza a todo el hogar, no solo al lote nuevo.
      expect(rows.get(TX_PAYROLL_FIXTURE)?.recurrence).not.toBeNull();
    });

    it("la suite no deja rastro en la fixture", async () => {
      const res = await withAuthorizedTransaction(appPool, ADMIN, ROBLE, async (client) =>
        client.query<{ n: string }>(
          `select count(*)::text as n
             from app.finance_transactions
            where household_id = $1
              and (dedup_hash like 'it-f2-%' or dedup_hash like 'invmirror-it-f2-%')`,
          [ROBLE],
        ),
      );
      expect(res.rows[0]?.n).toBe("0");
    });
  },
);
