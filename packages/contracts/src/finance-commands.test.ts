import { describe, expect, it } from "vitest";

import {
  financeEventCreatePayloadSchema,
  financeManualCreatePayloadSchema,
  financeRuleCreatePayloadSchema,
  financeTransactionUpdatePayloadSchema,
  financeTransactionsBulkPayloadSchema,
  financeTransfersLinkPayloadSchema,
  financeWritePayloadSchema,
} from "./schemas.js";

const TX = "ab300000-0000-4000-8000-000000000001";
const CAT = "ab200000-0000-4000-8000-000000000001";
const ACC = "ab100000-0000-4000-8000-000000000001";
const EVT = "ab400000-0000-4000-8000-000000000001";

const FINANCE_WRITE_KINDS = [
  "finance.account.update",
  "finance.category.create",
  "finance.category.update",
  "finance.category.delete",
  "finance.category.assignConcept",
  "finance.rule.create",
  "finance.rule.delete",
  "finance.transaction.update",
  "finance.transactions.bulk",
  "finance.transactions.assignConceptRecurrence",
  "finance.transaction.manual.create",
  "finance.transaction.manual.delete",
  "finance.transaction.invest",
  "finance.transfers.link",
  "finance.transfers.unlink",
  "finance.event.create",
  "finance.event.update",
  "finance.event.delete",
  "finance.event.assignTransactions",
  "finance.event.assignConcept",
  "finance.alias.update",
  "finance.import.undo",
];

describe("payloads de escritura de finanzas", () => {
  it("acepta una actualización parcial de transacción y conserva el kind", () => {
    const parsed = financeTransactionUpdatePayloadSchema.parse({
      kind: "finance.transaction.update",
      transactionId: TX,
      categoryId: CAT,
    });
    expect(parsed.kind).toBe("finance.transaction.update");
    expect(parsed.status).toBeUndefined();
  });

  it("acepta confirmar con creación de regla y recorta el concepto", () => {
    const parsed = financeTransactionUpdatePayloadSchema.parse({
      kind: "finance.transaction.update",
      transactionId: TX,
      status: "confirmada",
      createRule: { ruleType: "proveedor_exacto" },
      concept: "  Luz de julio  ",
    });
    expect(parsed.concept).toBe("Luz de julio");
  });

  it("la unión discrimina por kind y rechaza kinds desconocidos", () => {
    expect(
      financeWritePayloadSchema.safeParse({ kind: "finance.transaction.update", transactionId: TX }).success,
    ).toBe(true);
    expect(financeWritePayloadSchema.safeParse({ kind: "finance.inventado", transactionId: TX }).success).toBe(false);
  });

  it("vincular transferencias exige al menos 2 movimientos", () => {
    expect(
      financeTransfersLinkPayloadSchema.safeParse({ kind: "finance.transfers.link", transactionIds: [TX] }).success,
    ).toBe(false);
    expect(
      financeTransfersLinkPayloadSchema.safeParse({
        kind: "finance.transfers.link",
        transactionIds: [TX, "ab300000-0000-4000-8000-000000000002"],
      }).success,
    ).toBe(true);
  });

  it("el bloque acepta cambiar solo la categoría, con el estado ausente", () => {
    const parsed = financeTransactionsBulkPayloadSchema.parse({
      kind: "finance.transactions.bulk",
      transactionIds: [TX],
      categoryId: CAT,
    });
    expect(parsed.status).toBeUndefined();
    expect(
      financeTransactionsBulkPayloadSchema.safeParse({
        kind: "finance.transactions.bulk",
        transactionIds: [TX],
        status: "confirmada",
      }).success,
    ).toBe(true);
  });

  it("un manual no puede tener importe 0 y exige concepto de 3+ caracteres", () => {
    const base = {
      kind: "finance.transaction.manual.create",
      accountId: ACC,
      opDate: "2026-08-15",
      concept: "Fruta del mercado",
      amountCents: "-1500",
    };
    expect(financeManualCreatePayloadSchema.safeParse(base).success).toBe(true);
    expect(financeManualCreatePayloadSchema.safeParse({ ...base, amountCents: "0" }).success).toBe(false);
    expect(financeManualCreatePayloadSchema.safeParse({ ...base, concept: "ab" }).success).toBe(false);
  });

  it("el evento admite id opcional (la fase 6 lo asigna en cola) con y sin id", () => {
    expect(
      financeEventCreatePayloadSchema.safeParse({ kind: "finance.event.create", name: "Reforma cocina" }).success,
    ).toBe(true);
    expect(
      financeEventCreatePayloadSchema.safeParse({
        kind: "finance.event.create",
        name: "Reforma cocina",
        id: EVT,
      }).success,
    ).toBe(true);
    expect(
      financeEventCreatePayloadSchema.safeParse({
        kind: "finance.event.create",
        name: "Reforma cocina",
        id: "no-es-un-uuid",
      }).success,
    ).toBe(false);
  });

  it("una regla limita el patrón a 1..200 caracteres y acepta prioridad opcional", () => {
    expect(
      financeRuleCreatePayloadSchema.safeParse({
        kind: "finance.rule.create",
        ruleType: "proveedor_exacto",
        pattern: "Iberdrola",
        categoryId: CAT,
      }).success,
    ).toBe(true);
    expect(
      financeRuleCreatePayloadSchema.safeParse({
        kind: "finance.rule.create",
        ruleType: "proveedor_exacto",
        pattern: "",
        categoryId: CAT,
      }).success,
    ).toBe(false);
    expect(
      financeRuleCreatePayloadSchema.safeParse({
        kind: "finance.rule.create",
        ruleType: "proveedor_exacto",
        pattern: "x".repeat(201),
        categoryId: CAT,
      }).success,
    ).toBe(false);
    expect(
      financeRuleCreatePayloadSchema.safeParse({
        kind: "finance.rule.create",
        ruleType: "proveedor_exacto",
        pattern: "Iberdrola",
        categoryId: CAT,
        priority: 5,
      }).success,
    ).toBe(true);
  });

  it("financeWritePayloadSchema tiene exactamente 22 opciones y coincide con los kind del doc de interfaces", () => {
    expect(financeWritePayloadSchema.options.length).toBe(22);
    const kinds = financeWritePayloadSchema.options.map((option) => option.shape.kind.value);
    expect(kinds).toEqual(FINANCE_WRITE_KINDS);
  });
});
