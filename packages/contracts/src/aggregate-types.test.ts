import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import type { AggregateType } from "./index.js";
import { commandEnvelopeSchema } from "./schemas.js";

/**
 * Los tipos de agregado viven en DOS listas: la unión `AggregateType` de
 * `index.ts` y el `z.enum` de `commandEnvelopeSchema`. No se pueden fundir en
 * una constante compartida sin romper la regla de `index.ts` —de la raíz solo
 * salen tipos y funciones pequeñas, nunca tablas: la carga toda pantalla del
 * cliente—, así que se vigila que digan lo mismo.
 *
 * Dos guardas, porque cada una cubre lo que la otra no ve:
 *
 * · `expectTypeOf` compara los tipos y lo comprueba `pnpm typecheck` (los
 *   ficheros de prueba entran en el `tsconfig` del paquete). Falla en
 *   cualquiera de los dos sentidos.
 * · `AGGREGATE_TYPES` es un `Record<AggregateType, true>`: el compilador exige
 *   una clave por miembro de la unión, ni una más ni una menos, y en tiempo de
 *   ejecución se compara con las opciones del `z.enum`. Así `pnpm test` también
 *   lo nota cuando alguien añade una entrada al `z.enum` y se deja la unión.
 */
const AGGREGATE_TYPES = {
  agreement: true,
  comment: true,
  contact: true,
  coupon: true,
  diner: true,
  expense: true,
  extra_work: true,
  finance: true,
  food: true,
  ics_feed: true,
  leave_request: true,
  manual_adjustment: true,
  membership: true,
  menu_group: true,
  menu_slot: true,
  menu_template: true,
  payment: true,
  recipe: true,
  routine: true,
  routine_occurrence: true,
  settlement: true,
  shopping_item: true,
  wiki_page: true,
  wiki_space: true,
} as const satisfies Record<AggregateType, true>;

describe("tipos de agregado: la unión de index.ts y el z.enum del sobre", () => {
  it("son la misma lista en tiempo de compilación", () => {
    expectTypeOf<z.output<typeof commandEnvelopeSchema>["aggregateType"]>().toEqualTypeOf<AggregateType>();
  });

  it("son la misma lista en tiempo de ejecución", () => {
    expect([...commandEnvelopeSchema.shape.aggregateType.options].sort()).toEqual(
      Object.keys(AGGREGATE_TYPES).sort(),
    );
  });

  it("incluyen coupon (spec de cupones §5)", () => {
    expect(commandEnvelopeSchema.shape.aggregateType.options).toContain("coupon");
  });
});
