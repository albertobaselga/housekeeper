import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { categoryOptionGroups } from '../src/lib/finance/category-options';

describe('categoryOptionGroups', () => {
  const cats = [
    { id: 'r1', name: 'Casa', parentId: null, kind: 'gasto' },
    { id: 'r1a', name: 'Luz', parentId: 'r1', kind: 'gasto' },
    { id: 'r2', name: 'Nómina', parentId: null, kind: 'ingreso' },
    { id: 'rt', name: 'Transferencias', parentId: null, kind: 'transferencia' }
  ];
  it('agrupa dos niveles, con (general) y sin transferencia', () => {
    const groups = categoryOptionGroups(cats);
    expect(groups.map((group) => group.label)).toEqual(['Casa', 'Nómina']);
    expect(groups[0]!.options).toEqual([
      { id: 'r1', label: 'Casa / (general)' },
      { id: 'r1a', label: 'Casa / Luz' }
    ]);
    expect(groups[1]!.options).toEqual([{ id: 'r2', label: 'Nómina' }]);
  });
});

/**
 * Los dbe2e de las tareas 10 y 12 buscan estos controles por su etiqueta
 * accesible (`getByRole('combobox', { name: 'Categoría' })`, `'Tipo de gasto'`).
 * La casa no monta componentes en vitest: se afirma sobre el fuente, como en
 * `calendar-no-metrics.test.ts`.
 */
describe('etiquetas accesibles de los componentes de edición', () => {
  const base = new URL('../src/lib/components/finance/', import.meta.url);

  it('CategorySelect declara sus props y etiqueta por defecto «Categoría»', async () => {
    const source = await readFile(new URL('CategorySelect.svelte', base), 'utf8');
    expect(source).toContain("label = 'Categoría'");
    expect(source).toContain('aria-label={label}');
    for (const prop of ['categories', 'value', 'onchange']) expect(source).toContain(prop);
  });

  // [FASE 5, T13 · Ruling R25] RecurrenceChip gana el mismo `label` opcional
  // que CategorySelect (arriba): ManualForm.svelte lo reutiliza envuelto en su
  // propio `<label>Recurrencia>` en vez de duplicar el `<select>`, y necesita
  // poder pasar un rótulo propio para no duplicar el nombre accesible con el
  // de las tablas (Movimientos, Revisión), que siguen viendo «Tipo de gasto».
  it('RecurrenceChip declara sus props y etiqueta por defecto «Tipo de gasto»', async () => {
    const source = await readFile(new URL('RecurrenceChip.svelte', base), 'utf8');
    expect(source).toContain("label = 'Tipo de gasto'");
    expect(source).toContain('aria-label={label}');
    expect(source).toContain('<option value="">—</option>');
  });

  it('EventPicker es un popover, no un diálogo a medias', async () => {
    const source = await readFile(new URL('EventPicker.svelte', base), 'utf8');
    expect(source).not.toContain('role="dialog"');
    expect(source).toContain('aria-controls');
    expect(source).toContain("event.key === 'Escape'");
  });
});
