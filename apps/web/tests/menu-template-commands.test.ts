import { describe, expect, it } from 'vitest';

// La validación zod de los payloads congelados vive AQUÍ, en el test: el
// código de `commands.ts` que llega al navegador no importa zod jamás.
import {
  commandEnvelopeSchema,
  menuSlotCommandPayloadSchema,
  menuTemplateCommandPayloadSchema
} from '@casa-clara/contracts/schemas';

import {
  applyMenuTemplate,
  deleteMenuTemplate,
  saveMenuTemplate,
  setMenuSlotNewRecipe
} from '../src/lib/food/commands';

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const GROUP = '43000000-0000-4000-8000-000000000001';
const TEMPLATE = '4a000000-0000-4000-8000-000000000001';
const OPTIONS = {
  operationId: '99999999-0000-4000-8000-000000000007',
  occurredAt: '2026-08-08T10:00:00.000Z'
};

describe('constructores de plantillas de semana y nueva receta desde el hueco', () => {
  it('saveMenuTemplate congela nombre limpio y lunes origen', () => {
    const envelope = saveMenuTemplate(
      { householdId: HOUSEHOLD, name: '  Semana de cole ', fromWeekStartsOn: '2026-10-05' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('menu_template');
    expect(menuTemplateCommandPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'save',
      name: 'Semana de cole',
      fromWeekStartsOn: '2026-10-05'
    });
  });

  it('applyMenuTemplate ancla la plantilla y lleva el lunes destino', () => {
    const envelope = applyMenuTemplate(
      { householdId: HOUSEHOLD, templateId: TEMPLATE, toWeekStartsOn: '2026-10-12' },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateId).toBe(TEMPLATE);
    expect(menuTemplateCommandPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'apply',
      templateId: TEMPLATE,
      toWeekStartsOn: '2026-10-12'
    });
  });

  it('deleteMenuTemplate produce el payload congelado', () => {
    const envelope = deleteMenuTemplate({ householdId: HOUSEHOLD, templateId: TEMPLATE }, OPTIONS);
    expect(envelope.aggregateType).toBe('menu_template');
    expect(menuTemplateCommandPayloadSchema.parse(envelope.payload)).toEqual({
      action: 'delete',
      templateId: TEMPLATE
    });
  });

  it('setMenuSlotNewRecipe entra en la unión de menu_slot y limpia los opcionales vacíos', () => {
    const envelope = setMenuSlotNewRecipe(
      {
        householdId: HOUSEHOLD,
        groupId: GROUP,
        onDate: '2026-10-05',
        meal: 'cena',
        recipeTitle: ' Tortilla de la casa ',
        recipeBody: '  ',
        notes: ' Poco cuajada ',
        servingsOverride: 3
      },
      OPTIONS
    );
    expect(commandEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.aggregateType).toBe('menu_slot');
    const payload = menuSlotCommandPayloadSchema.parse(envelope.payload);
    expect(payload).toEqual({
      action: 'set_new_recipe',
      groupId: GROUP,
      onDate: '2026-10-05',
      meal: 'cena',
      recipeTitle: 'Tortilla de la casa',
      notes: 'Poco cuajada',
      servingsOverride: 3
    });
    expect(payload).not.toHaveProperty('recipeBody');

    // El nombre de la receta es obligatorio: sin él, el contrato rechaza.
    expect(
      menuSlotCommandPayloadSchema.safeParse({
        action: 'set_new_recipe',
        groupId: GROUP,
        onDate: '2026-10-05',
        meal: 'cena',
        recipeTitle: '   '
      }).success
    ).toBe(false);
  });
});
