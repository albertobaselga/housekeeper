import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `PivotSearch.svelte` no tiene librería de montaje en este repo (vitest corre
 * en `node`, sin `@testing-library/svelte` ni `jsdom`/`happy-dom`): estas
 * pruebas vigilan el CÓDIGO FUENTE del componente y de su integración en
 * `PivotTable.svelte`, mismo patrón que `finance-grant-card.test.ts` y
 * `calendar-no-metrics.test.ts` — pensado para el escenario «la línea que
 * arregla el defecto desaparece y todo sigue verde» (revisión task-11, ronda 1).
 */

let search = '';
let table = '';

beforeAll(async () => {
  search = await readFile(
    new URL('../src/lib/components/finance/PivotSearch.svelte', import.meta.url),
    'utf8'
  );
  table = await readFile(
    new URL('../src/lib/components/finance/PivotTable.svelte', import.meta.url),
    'utf8'
  );
});

describe('PivotSearch: clave del {#each} de sugerencias (I1)', () => {
  it('discrimina por proveedor además de tipo/valor: dos conceptos iguales de proveedores distintos no colisionan', () => {
    // Sin `chip.prov` en la clave, "Recibo" de dos proveedores comparte clave y
    // Svelte 5 lanza `each_key_duplicate` (también en producción, ver revisión).
    expect(search).toMatch(
      /\{#each g\.items\.slice\(0, cap\) as item \(item\.chip\.type \+ item\.chip\.value \+ \(item\.chip\.prov \?\? ''\)\)\}/
    );
  });
});

describe('PivotSearch: deduplicación de chips (M4)', () => {
  it('addChip descarta un chip ya presente con el mismo type/value/prov', () => {
    expect(search).toMatch(/const already = chips\.some\(/);
    expect(search).toContain('if (!already) onChips([...chips, chip]);');
  });
});

describe('PivotSearch: atajo «/» ignora combinaciones con modificador (M5)', () => {
  it('Ctrl+/, Cmd+/ y Alt+/ no roban el foco del buscador', () => {
    expect(search).toContain("if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;");
  });
});

describe('PivotSearch: el desplegable se cierra al perder el foco (M3)', () => {
  it('onfocusout en el contenedor cierra el panel salvo que el foco siga dentro', () => {
    expect(search).toContain('onfocusout={onFocusOut}');
    expect(search).toMatch(/buscador\?\.contains\(next\)/);
  });
});

describe('PivotSearch: sugerencias con ARIA de listbox válido (M2)', () => {
  it('cada botón de sugerencia y "más" declara role="option"', () => {
    expect(search).toMatch(/class="sugerencia" role="option"/);
    expect(search).toMatch(/class="mas" role="option"/);
  });
});

describe('PivotSearch: clase muerta "activa" retirada del chip (M7)', () => {
  it('el chip de búsqueda ya no lleva una clase sin estilo propio en este componente', () => {
    expect(search).toContain('<span class="chip">');
    expect(search).not.toContain('class="chip activa"');
  });
});

describe('PivotSearch: expandedGroups no sobrevive a un cambio de consulta (M9)', () => {
  it('un efecto reinicia expandedGroups cuando cambia la consulta debounced', () => {
    expect(search).toMatch(/\$effect\(\(\) => \{\s*debounced;\s*expandedGroups = new Set\(\);/);
  });
});

describe('PivotTable: integra PivotSearch con la URL como fuente (M10)', () => {
  it('monta <PivotSearch> dentro de .pivot-controles, antes de .dims', () => {
    const controlesStart = table.indexOf('class="pivot-controles"');
    const searchAt = table.indexOf('<PivotSearch', controlesStart);
    const dimsAt = table.indexOf('class="dims"', controlesStart);
    expect(controlesStart, 'PivotTable ya no tiene .pivot-controles').toBeGreaterThan(-1);
    expect(searchAt, 'PivotTable ya no monta <PivotSearch> dentro de .pivot-controles').toBeGreaterThan(-1);
    expect(dimsAt, 'PivotTable ya no tiene .dims dentro de .pivot-controles').toBeGreaterThan(-1);
    expect(searchAt).toBeLessThan(dimsAt);
  });

  it('onChips escribe el parámetro `q` serializado, no un estado local', () => {
    expect(table).toContain("onChips={(next) => setShallowParam('q', serializeChips(next))}");
  });

  it('le pasa las filas ya filtradas por el resto de controles (o todas si el filtro vacía)', () => {
    expect(table).toContain('rows={filteredRows.length ? filteredRows : rows}');
  });
});
