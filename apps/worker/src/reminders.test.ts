import { describe, expect, it } from "vitest";

import { PermanentJobError, type ClaimedJob } from "./queue.js";
import {
  AUTOCONFIRM_JOB,
  SETTLEMENT_DUE_JOB,
  createAutoconfirmHandler,
  createSettlementDueHandler,
  type ReminderEmail,
  type ReminderEnqueueInput,
  type SettlementReminderState,
} from "./reminders.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const SETTLEMENT = "12b00000-0000-4000-8000-0000000000aa";
const REPORT = "12200000-0000-4000-8000-0000000000bb";
const NOW = new Date("2025-05-02T10:00:00.000Z");

function dueJob(payload: unknown): ClaimedJob {
  return { id: "job-due", householdId: HOUSEHOLD, type: SETTLEMENT_DUE_JOB, payload, attempts: 1 };
}

function autoconfirmJob(payload: unknown): ClaimedJob {
  return { id: "job-auto", householdId: HOUSEHOLD, type: AUTOCONFIRM_JOB, payload, attempts: 1 };
}

function pendingState(overrides: Partial<SettlementReminderState> = {}): SettlementReminderState {
  return {
    dueOn: "2025-05-05",
    periodStart: "2025-04-01",
    periodEnd: "2025-04-30",
    status: "closed",
    pendingCents: "54450",
    receiptConfirmed: false,
    adminEmails: ["admin.roble@example.com", "otra.admin@example.com", null],
    ...overrides,
  };
}

interface Recorded {
  emails: ReminderEmail[];
  enqueued: ReminderEnqueueInput[];
}

function makeHandler(state: SettlementReminderState | null): { recorded: Recorded; run: (job: ClaimedJob) => Promise<void> } {
  const recorded: Recorded = { emails: [], enqueued: [] };
  const handler = createSettlementDueHandler({
    readState: async () => state,
    sendEmail: async (input) => {
      recorded.emails.push(input);
    },
    enqueue: async (input) => {
      recorded.enqueued.push(input);
    },
    now: () => NOW,
  });
  return { recorded, run: handler };
}

describe("aviso de liquidación pendiente", () => {
  it("con pendiente > 0 envía SOLO a quien administra (nulls filtrados) y se re-encola a +3 días", async () => {
    const { recorded, run } = makeHandler(pendingState());
    await run(dueJob({ settlementId: SETTLEMENT }));

    expect(recorded.emails.map((email) => email.to)).toEqual([
      "admin.roble@example.com",
      "otra.admin@example.com",
    ]);
    for (const email of recorded.emails) {
      expect(email.subject).toContain("05/05/2025");
      expect(email.text).toContain("544,50 EUR");
      expect(email.text).toContain("05/05/2025");
      // Sin desglose por línea: solo el pendiente total.
      expect(email.text).not.toMatch(/salario|línea|concepto/i);
    }

    expect(recorded.enqueued).toEqual([
      {
        householdId: HOUSEHOLD,
        type: SETTLEMENT_DUE_JOB,
        payload: { settlementId: SETTLEMENT },
        runAt: new Date("2025-05-05T10:00:00.000Z"),
      },
    ]);
  });

  it("pagada y con cobro confirmado completa sin enviar ni re-encolar", async () => {
    const { recorded, run } = makeHandler(
      pendingState({ pendingCents: "0", receiptConfirmed: true }),
    );
    await run(dueJob({ settlementId: SETTLEMENT }));
    expect(recorded.emails).toEqual([]);
    expect(recorded.enqueued).toEqual([]);
  });

  it("una liquidación anulada tampoco avisa", async () => {
    const { recorded, run } = makeHandler(pendingState({ status: "void" }));
    await run(dueJob({ settlementId: SETTLEMENT }));
    expect(recorded.emails).toEqual([]);
    expect(recorded.enqueued).toEqual([]);
  });

  it("sin correos utilizables no envía nada pero mantiene la escalada", async () => {
    const { recorded, run } = makeHandler(pendingState({ adminEmails: [null, "  "] }));
    await run(dueJob({ settlementId: SETTLEMENT }));
    expect(recorded.emails).toEqual([]);
    expect(recorded.enqueued).toHaveLength(1);
  });

  it("un hogar sin ningún administrador no manda el aviso a la empleada por defecto", async () => {
    // El defecto que corrige esta versión: el recordatorio de una deuda que ella
    // no puede saldar llegaba a su bandeja cada tres días. Aunque no quede nadie
    // a quien avisar, el aviso NO se redirige.
    const { recorded, run } = makeHandler(pendingState({ adminEmails: [] }));
    await run(dueJob({ settlementId: SETTLEMENT }));
    expect(recorded.emails).toEqual([]);
    expect(recorded.enqueued).toHaveLength(1);
  });

  it("payload inválido o liquidación inexistente son fallos permanentes", async () => {
    const { run } = makeHandler(pendingState());
    await expect(run(dueJob({}))).rejects.toBeInstanceOf(PermanentJobError);
    await expect(run(dueJob({ settlementId: "  " }))).rejects.toBeInstanceOf(PermanentJobError);

    const missing = makeHandler(null);
    await expect(missing.run(dueJob({ settlementId: SETTLEMENT }))).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    expect(missing.recorded.emails).toEqual([]);
    expect(missing.recorded.enqueued).toEqual([]);
  });
});

describe("auto-confirmación del parte semanal", () => {
  it("delega en la función idempotente y completa tanto con true como con false", async () => {
    const calls: Array<{ householdId: string; reportId: string }> = [];
    for (const outcome of [true, false]) {
      const handler = createAutoconfirmHandler({
        autoconfirm: async (householdId, reportId) => {
          calls.push({ householdId, reportId });
          return outcome;
        },
      });
      await expect(handler(autoconfirmJob({ reportId: REPORT }))).resolves.toBeUndefined();
    }
    expect(calls).toEqual([
      { householdId: HOUSEHOLD, reportId: REPORT },
      { householdId: HOUSEHOLD, reportId: REPORT },
    ]);
  });

  it("payload inválido es fallo permanente sin tocar la base", async () => {
    const handler = createAutoconfirmHandler({
      autoconfirm: async () => {
        throw new Error("no debe llamarse");
      },
    });
    await expect(handler(autoconfirmJob({}))).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handler(autoconfirmJob({ reportId: 7 }))).rejects.toBeInstanceOf(PermanentJobError);
  });
});
