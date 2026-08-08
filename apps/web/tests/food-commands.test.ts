import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código de `commands.ts` que llega al navegador no importa zod jamás.
import {
  commandEnvelopeSchema,
  dinerUpsertPayloadSchema,
  foodUpsertPayloadSchema,
  menuGroupUpsertPayloadSchema,
  menuSlotCommandPayloadSchema,
  recipeSetDetailsPayloadSchema,
  routineCompletePayloadSchema,
  routineUpsertPayloadSchema,
  shoppingAddPayloadSchema,
  shoppingSetCheckedPayloadSchema,
  shoppingSetLineCheckedPayloadSchema
} from '@casa-clara/contracts/schemas';

import {
  addShoppingItem,
  clearMenuSlot,
  completeRoutine,
  confirmMenuSlot,
  duplicateMenuWeek,
  queueFoodCommand,
  setMenuSlot,
  setRecipeDetails,
  setShoppingChecked,
  setShoppingLineChecked,
  upsertDiner,
  upsertFood,
  upsertMenuGroup,
  upsertRoutine
} from '../src/lib/food/commands';
import { listOutbox } from '../src/lib/offline/idb';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const FOOD = '41000000-0000-4000-8000-000000000001';
const DINER = '42000000-0000-4000-8000-000000000001';
const GROUP = '43000000-0000-4000-8000-000000000001';
const PAGE = '45000000-0000-4000-8000-000000000001';
const SLOT = '47000000-0000-4000-8000-000000000001';
const ITEM = '49000000-0000-4000-8000-000000000001';
const ROUTINE = '48000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000003',
  occurredAt: '2026-08-07T10:00:00.000Z'
};

describe('constructores de envelopes de comida y rutinas', () => {
  it('upsertFood valida contra el contrato y ordena los alérgenos', () => {
    const envelope = upsertFood(
      {
        householdId: HOUSEHOLD,
        foodId: FOOD,
        name: '  Leche entera ',
        shoppingSection: ' frescos ',
        allergenCodes: ['lacteos'],
        reviewed: true
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('food');
    expect(envelope.aggregateId).toBe(FOOD);
    expect(foodUpsertPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'upsert',
      foodId: FOOD,
      name: 'Leche entera',
      shoppingSection: 'frescos',
      allergenCodes: ['lacteos'],
      reviewed: true
    });
    // Alta sin foodId: aggregateId null y payload sin la clave.
    const created = upsertFood(
      { householdId: HOUSEHOLD, name: 'Arroz', shoppingSection: 'despensa', allergenCodes: [], reviewed: false },
      OPTIONS
    );
    expect(created.aggregateId).toBeNull();
    expect(foodUpsertPayloadSchema.parse(created.payload)).not.toHaveProperty('foodId');
  });

  it('upsertDiner limpia notas vacías y conserva los flags con severidad', () => {
    const envelope = upsertDiner(
      {
        householdId: HOUSEHOLD,
        dinerId: DINER,
        name: ' Leo ',
        notes: '  ',
        flags: [{ allergenCode: 'lacteos', severity: 'high', note: ' evitar trazas ' }]
      },
      OPTIONS
    );
    expect(envelope.aggregateType).toBe('diner');
    expect(dinerUpsertPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'upsert',
      dinerId: DINER,
      name: 'Leo',
      flags: [{ allergenCode: 'lacteos', severity: 'high', note: 'evitar trazas' }]
    });
  });

  it('setRecipeDetails ancla la página y admite cantidades con coma', () => {
    const envelope = setRecipeDetails(
      {
        householdId: HOUSEHOLD,
        pageId: PAGE,
        baseServings: 4,
        timeMinutes: 35,
        ingredients: [
          { foodId: FOOD, quantity: ' 1,5 ', unit: ' l ', scaling: 'linear' },
          { foodId: DINER, quantity: '0.10', unit: 'l', scaling: 'fixed' }
        ]
      },
      OPTIONS
    );
    expect(envelope.aggregateType).toBe('recipe');
    expect(envelope.aggregateId).toBe(PAGE);
    const payload = recipeSetDetailsPayloadSchema.parse(envelope.payload);
    expect(payload.ingredients[0]).toEqual({ foodId: FOOD, quantity: '1,5', unit: 'l', scaling: 'linear' });
    expect(payload.ingredients[1]!.scaling).toBe('fixed');
  });

  it('upsertMenuGroup produce el payload congelado', () => {
    const envelope = upsertMenuGroup(
      { householdId: HOUSEHOLD, name: ' Familia ', dinerIds: [DINER] },
      OPTIONS
    );
    expect(envelope.aggregateType).toBe('menu_group');
    expect(menuGroupUpsertPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'upsert',
      name: 'Familia',
      dinerIds: [DINER]
    });
  });

  it('setMenuSlot con receta y acknowledgeAllergens entra en la unión discriminada (AC-21)', () => {
    const envelope = setMenuSlot(
      {
        householdId: HOUSEHOLD,
        groupId: GROUP,
        onDate: '2026-08-03',
        meal: 'comida',
        recipePageId: PAGE,
        notes: ' triturar para Leo ',
        servingsOverride: 6,
        acknowledgeAllergens: true
      },
      OPTIONS
    );
    expect(envelope.aggregateType).toBe('menu_slot');
    expect(menuSlotCommandPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'set',
      groupId: GROUP,
      onDate: '2026-08-03',
      meal: 'comida',
      recipePageId: PAGE,
      notes: 'triturar para Leo',
      servingsOverride: 6,
      acknowledgeAllergens: true
    });
    // Texto libre sin receta, sin reconocimiento.
    const text = setMenuSlot(
      { householdId: HOUSEHOLD, groupId: GROUP, onDate: '2026-08-03', meal: 'cena', freeText: 'Sopa y sándwiches' },
      OPTIONS
    );
    const parsed = menuSlotCommandPayloadSchema.parse(text.payload);
    expect(parsed).not.toHaveProperty('recipePageId');
    expect(parsed).not.toHaveProperty('acknowledgeAllergens');
  });

  it('clearMenuSlot y duplicateMenuWeek (AC-23) validan contra el contrato', () => {
    const clear = clearMenuSlot({ householdId: HOUSEHOLD, slotId: SLOT }, OPTIONS);
    expect(clear.aggregateId).toBe(SLOT);
    expect(menuSlotCommandPayloadSchema.parse(clear.payload)).toEqual({ action: 'clear', slotId: SLOT });

    const duplicate = duplicateMenuWeek(
      { householdId: HOUSEHOLD, fromWeekStartsOn: '2026-08-03', toWeekStartsOn: '2026-08-10' },
      OPTIONS
    );
    expect(menuSlotCommandPayloadSchema.parse(duplicate.payload)).toEqual({
      action: 'duplicate_week',
      fromWeekStartsOn: '2026-08-03',
      toWeekStartsOn: '2026-08-10'
    });
  });

  it('confirmMenuSlot viaja con el contentHash del load', () => {
    const hash = 'a'.repeat(64);
    const envelope = confirmMenuSlot({ householdId: HOUSEHOLD, slotId: SLOT, contentHash: hash }, OPTIONS);
    expect(envelope.aggregateId).toBe(SLOT);
    expect(menuSlotCommandPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'confirm',
      slotId: SLOT,
      contentHash: hash
    });
    // Un hash que no es sha-256 hex viola el contrato.
    expect(() =>
      menuSlotCommandPayloadSchema.parse({ action: 'confirm', slotId: SLOT, contentHash: 'corto' })
    ).toThrow();
  });

  it('addShoppingItem exige alimento o nombre libre (AC-24)', () => {
    const withFood = addShoppingItem(
      { householdId: HOUSEHOLD, foodId: FOOD, quantity: '1,5', unit: 'l', weekStartsOn: '2026-08-03' },
      OPTIONS
    );
    expect(withFood.aggregateType).toBe('shopping_item');
    expect(shoppingAddPayloadSchema.parse(withFood.payload)).toEqual({
      action: 'add',
      foodId: FOOD,
      quantity: '1,5',
      unit: 'l',
      weekStartsOn: '2026-08-03'
    });

    const custom = addShoppingItem(
      { householdId: HOUSEHOLD, customName: ' Papel de cocina ', section: 'hogar' },
      OPTIONS
    );
    expect(shoppingAddPayloadSchema.parse(custom.payload)).toEqual({
      action: 'add',
      customName: 'Papel de cocina',
      section: 'hogar'
    });

    // Sin alimento ni nombre: el schema lo rechaza.
    expect(() => shoppingAddPayloadSchema.parse({ action: 'add' })).toThrow();
  });

  it('setShoppingChecked marca y desmarca por id', () => {
    const envelope = setShoppingChecked({ householdId: HOUSEHOLD, itemId: ITEM, checked: true }, OPTIONS);
    expect(envelope.aggregateId).toBe(ITEM);
    expect(shoppingSetCheckedPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'set_checked',
      itemId: ITEM,
      checked: true
    });
  });

  it('upsertFood lleva el tamaño de paquete entero o no lo lleva (P2-4)', () => {
    const withPackage = upsertFood(
      {
        householdId: HOUSEHOLD,
        name: 'Arroz',
        shoppingSection: 'despensa',
        allergenCodes: [],
        reviewed: true,
        packaging: { size: ' 500 ', unit: ' g ' }
      },
      OPTIONS
    );
    expect(foodUpsertPayloadSchema.parse(withPackage.payload)).toMatchObject({
      packaging: { size: '500', unit: 'g' }
    });

    // Media medida (cantidad sin unidad) no viaja: no sirve para redondear.
    const halfMeasure = upsertFood(
      {
        householdId: HOUSEHOLD,
        name: 'Arroz',
        shoppingSection: 'despensa',
        allergenCodes: [],
        reviewed: true,
        packaging: { size: '500', unit: '  ' }
      },
      OPTIONS
    );
    expect(foodUpsertPayloadSchema.parse(halfMeasure.payload)).not.toHaveProperty('packaging');
  });

  it('setShoppingLineChecked marca la línea entera, también la que viene del menú', () => {
    const derived = setShoppingLineChecked(
      { householdId: HOUSEHOLD, weekStartsOn: '2026-08-03', lineKey: `food:${FOOD}`, checked: true },
      OPTIONS
    );
    expect(derived.aggregateType).toBe('shopping_item');
    expect(shoppingSetLineCheckedPayloadSchema.parse(derived.payload)).toEqual({
      action: 'set_line_checked',
      weekStartsOn: '2026-08-03',
      lineKey: `food:${FOOD}`,
      checked: true
    });

    // La lista personal viaja explícita; la de casa es el valor por defecto.
    const personal = setShoppingLineChecked(
      {
        householdId: HOUSEHOLD,
        weekStartsOn: '2026-08-03',
        lineKey: 'name:champú',
        listKind: 'personal',
        checked: false
      },
      OPTIONS
    );
    expect(shoppingSetLineCheckedPayloadSchema.parse(personal.payload)).toMatchObject({
      listKind: 'personal',
      checked: false
    });

    // Una clave que no es ni alimento ni nombre se rechaza en el contrato.
    expect(() =>
      shoppingSetLineCheckedPayloadSchema.parse({
        action: 'set_line_checked',
        weekStartsOn: '2026-08-03',
        lineKey: 'otra-cosa',
        checked: true
      })
    ).toThrow();
  });

  it('addShoppingItem a la lista personal se escribe a mano, sin catálogo', () => {
    const personal = addShoppingItem(
      { householdId: HOUSEHOLD, customName: ' Champú ', listKind: 'personal', weekStartsOn: '2026-08-03' },
      OPTIONS
    );
    expect(shoppingAddPayloadSchema.parse(personal.payload)).toEqual({
      action: 'add',
      customName: 'Champú',
      weekStartsOn: '2026-08-03',
      listKind: 'personal'
    });

    // El contrato impide colar un alimento del catálogo en la lista personal.
    expect(() =>
      shoppingAddPayloadSchema.parse({ action: 'add', foodId: FOOD, listKind: 'personal' })
    ).toThrow();
  });

  it('upsertRoutine y completeRoutine validan contra el contrato', () => {
    const routine = upsertRoutine(
      {
        householdId: HOUSEHOLD,
        title: ' Regar plantas ',
        details: ' ',
        audience: 'all',
        frequency: 'weekly',
        intervalCount: 2,
        nextDueOn: '2026-08-10'
      },
      OPTIONS
    );
    expect(routine.aggregateType).toBe('routine');
    expect(routineUpsertPayloadSchema.parse(routine.payload)).toEqual({
      action: 'upsert',
      title: 'Regar plantas',
      audience: 'all',
      frequency: 'weekly',
      intervalCount: 2,
      nextDueOn: '2026-08-10'
    });

    const completion = completeRoutine(
      { householdId: HOUSEHOLD, routineId: ROUTINE, dueOn: '2026-08-10' },
      OPTIONS
    );
    // 'routine', no 'routine_occurrence': el servidor solo registra el
    // agregado 'routine' (el fix de 03dfe24; 'routine_occurrence' provocaba
    // rejected/unsupported_aggregate).
    expect(completion.aggregateType).toBe('routine');
    expect(completion.aggregateId).toBe(ROUTINE);
    expect(routineCompletePayloadSchema.parse(completion.payload)).toEqual({
      action: 'complete',
      routineId: ROUTINE,
      dueOn: '2026-08-10'
    });
  });

  it('genera operationId y occurredAt válidos cuando no se inyectan', () => {
    const envelope = upsertFood({
      householdId: HOUSEHOLD,
      name: 'Garbanzos',
      shoppingSection: 'despensa',
      allergenCodes: [],
      reviewed: true
    });
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
  });
});

describe('queueFoodCommand', () => {
  it('persiste primero en el outbox y queda pendiente sin navegador', async () => {
    // En node `browser` es false: flushOutbox no envía nada y el comando debe
    // quedarse en el outbox (offline-first) esperando al flush del navegador.
    const householdId = crypto.randomUUID();
    const envelope = setShoppingChecked({ householdId, itemId: ITEM, checked: true });
    const outcome = await queueFoodCommand(envelope);
    expect(outcome).toBe('queued');
    const records = await listOutbox(householdId);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(envelope.operationId);
    expect(records[0]!.status).toBe('pending');
    expect(records[0]!.envelope).toEqual(envelope);
  });
});
