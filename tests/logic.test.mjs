import test from "node:test";
import assert from "node:assert/strict";

import { getSearchCorpus, recipes, settlementLines } from "../data.js";
import {
  calculateSettlement,
  canAccess,
  formatCurrency,
  paymentSummary,
  roundMoney,
  scaleIngredients,
  searchItems,
} from "../logic.js";

test("calcula exactamente el ejemplo de aceptación de marzo", () => {
  assert.deepEqual(calculateSettlement(settlementLines), {
    salaryTotal: 1406,
    reimbursementTotal: 47.3,
    transferTotal: 1453.3,
  });
});

test("un pago parcial mantiene la liquidación cerrada", () => {
  assert.deepEqual(paymentSummary(1453.3, [{ amount: 800 }]), {
    paid: 800,
    pending: 653.3,
    state: "closed",
  });
});

test("los descuentos conservan siempre el signo negativo", () => {
  assert.equal(formatCurrency(-100), "−100,00 €");
  assert.equal(formatCurrency(70, { showSign: true }), "+70,00 €");
  assert.equal(formatCurrency(1453.3), "1.453,30 €");
});

test("redondea importes positivos y negativos de forma simétrica", () => {
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(-1.005), -1.01);
  assert.equal(roundMoney(10.075), 10.08);
  assert.equal(roundMoney(-10.075), -10.08);
});

test("cubrir el total requiere todavía confirmación de cobro", () => {
  assert.equal(paymentSummary(1453.3, [{ amount: 800 }, { amount: 653.3 }]).state, "paid");
  assert.equal(paymentSummary(1453.3, [{ amount: 1453.3 }], "2026-03-31T18:42:00Z").state, "confirmed");
});

test("la búsqueda tolera erratas y alias domésticos", () => {
  const corpus = getSearchCorpus();
  assert.equal(searchItems("lavadra", corpus)[0].slug, "lavadora-programa-corto");
  assert.equal(searchItems("vitro", corpus)[0].slug, "placa-induccion");
});

test("la búsqueda indexa el cuerpo de la wiki y los ingredientes", () => {
  const corpus = getSearchCorpus();
  assert.equal(searchItems("interruptores pequeños", corpus)[0].slug, "se-ha-ido-la-luz");
  assert.equal(searchItems("lomos merluza", corpus)[0].id, "merluza");
});

test("escala cantidades lineales y conserva unidades no lineales", () => {
  const recipe = recipes.find((item) => item.id === "merluza");
  const ingredients = scaleIngredients(recipe, 6);
  assert.equal(ingredients.find((item) => item.food === "Patata").scaledAmount, 900);
  assert.equal(ingredients.find((item) => item.food === "Lomos de merluza").scaledAmount, 6);
  assert.equal(ingredients.find((item) => item.food === "Perejil").scaledAmount, 1);
});

test("helper no puede acceder al módulo laboral", () => {
  assert.equal(canAccess("helper", "employment"), false);
  assert.equal(canAccess("helper", "calendar"), false);
  assert.equal(canAccess("employee_live_in", "employment"), true);
  assert.equal(canAccess("family_admin", "employment"), true);
});

test("family_member puede leer empleo y editar contenido, pero no administrar", () => {
  assert.equal(canAccess("family_member", "employment"), true);
  assert.equal(canAccess("family_member", "content_edit"), true);
  assert.equal(canAccess("family_member", "admin"), false);
});

test("viewer queda limitado a hoy, emergencias, contactos y calendario", () => {
  assert.equal(canAccess("viewer", "today"), true);
  assert.equal(canAccess("viewer", "emergency"), true);
  assert.equal(canAccess("viewer", "contacts"), true);
  assert.equal(canAccess("viewer", "calendar"), true);
  assert.equal(canAccess("viewer", "employment"), false);
  assert.equal(canAccess("viewer", "menu"), false);
  assert.equal(canAccess("viewer", "wiki"), false);
  assert.equal(canAccess("viewer", "search"), false);
});

test("un rol desconocido no recibe permisos por defecto", () => {
  assert.equal(canAccess("unknown", "today"), false);
  assert.equal(canAccess("unknown", "employment"), false);
  assert.equal(canAccess("family_admin", "unknown"), false);
});
