import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAPS_KEEP_DAYS,
  DEFAULT_READS_KEEP_DAYS,
  PRUNE_DISCOVERY_JOB,
  createPruneDiscoveryHandler,
  parsePrunePayload,
  type PruneEnqueueInput,
} from "./maintenance.js";
import { PermanentJobError, type ClaimedJob } from "./queue.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-07T10:00:00.000Z");

function job(payload: unknown): ClaimedJob {
  return { id: "job-prune", householdId: HOUSEHOLD, type: PRUNE_DISCOVERY_JOB, payload, attempts: 1 };
}

interface Recorded {
  pruneCalls: Array<{ readsKeepDays: number; gapsKeepDays: number }>;
  enqueued: PruneEnqueueInput[];
}

function makeHandler(
  prune?: (readsKeepDays: number, gapsKeepDays: number) => Promise<{ prunedReads: number; prunedGaps: number }>,
): { recorded: Recorded; run: (input: ClaimedJob) => Promise<void> } {
  const recorded: Recorded = { pruneCalls: [], enqueued: [] };
  const run = createPruneDiscoveryHandler({
    prune:
      prune ??
      (async (readsKeepDays, gapsKeepDays) => {
        recorded.pruneCalls.push({ readsKeepDays, gapsKeepDays });
        return { prunedReads: 0, prunedGaps: 0 };
      }),
    enqueue: async (input) => {
      recorded.enqueued.push(input);
    },
    now: () => NOW,
  });
  return { recorded, run };
}

describe("maintenance.prune_discovery (unidad)", () => {
  it("payload vacío usa los defaults de la 0012 y re-encola a +7 días con esos valores", async () => {
    const { recorded, run } = makeHandler();
    await run(job({}));

    expect(recorded.pruneCalls).toEqual([
      { readsKeepDays: DEFAULT_READS_KEEP_DAYS, gapsKeepDays: DEFAULT_GAPS_KEEP_DAYS },
    ]);
    expect(recorded.enqueued).toEqual([
      {
        householdId: HOUSEHOLD,
        type: PRUNE_DISCOVERY_JOB,
        payload: { readsKeepDays: 45, gapsKeepDays: 180 },
        runAt: new Date("2026-08-14T10:00:00.000Z"),
      },
    ]);
  });

  it("los días del payload viajan tal cual a la función y al re-encolado", async () => {
    const { recorded, run } = makeHandler();
    await run(job({ readsKeepDays: 60, gapsKeepDays: 365 }));
    expect(recorded.pruneCalls).toEqual([{ readsKeepDays: 60, gapsKeepDays: 365 }]);
    expect(recorded.enqueued[0]?.payload).toEqual({ readsKeepDays: 60, gapsKeepDays: 365 });
  });

  it("un payload no entero es fallo permanente sin tocar la base", async () => {
    const { recorded, run } = makeHandler();
    await expect(run(job({ readsKeepDays: "45" }))).rejects.toBeInstanceOf(PermanentJobError);
    await expect(run(job({ gapsKeepDays: 45.5 }))).rejects.toBeInstanceOf(PermanentJobError);
    expect(recorded.pruneCalls).toEqual([]);
    expect(recorded.enqueued).toEqual([]);
  });

  it("el rechazo 22023 de la base (mínimo 30 días) se convierte en fallo permanente y no re-encola", async () => {
    const { recorded, run } = makeHandler(async () => {
      const error = new Error("la retención mínima es de 30 días") as Error & { code: string };
      error.code = "22023";
      throw error;
    });
    await expect(run(job({ readsKeepDays: 29 }))).rejects.toBeInstanceOf(PermanentJobError);
    expect(recorded.enqueued).toEqual([]);
  });

  it("un fallo transitorio de la base NO es permanente (el job se reintenta) y no re-encola", async () => {
    const { recorded, run } = makeHandler(async () => {
      throw new Error("connection reset");
    });
    const failure = await run(job({})).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
    expect(recorded.enqueued).toEqual([]);
  });

  it("parsePrunePayload tolera null/undefined por campo y aplica defaults", () => {
    expect(parsePrunePayload(null)).toEqual({ readsKeepDays: 45, gapsKeepDays: 180 });
    expect(parsePrunePayload({ readsKeepDays: null })).toEqual({ readsKeepDays: 45, gapsKeepDays: 180 });
    expect(parsePrunePayload({ gapsKeepDays: 200 })).toEqual({ readsKeepDays: 45, gapsKeepDays: 200 });
  });
});
