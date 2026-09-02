import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `PivotActionBar.svelte`/`PivotTable.svelte` no tienen librería de montaje en
 * este repo (vitest corre en `node`, sin `@testing-library/svelte` ni
 * `jsdom`/`happy-dom`): estas pruebas vigilan el CÓDIGO FUENTE, mismo patrón
 * que `finance-pivot-search-ui.test.ts` y `finance-grant-card.test.ts`.
 */

let bar = '';
let table = '';

beforeAll(async () => {
  bar = await readFile(new URL('../src/lib/components/finance/PivotActionBar.svelte', import.meta.url), 'utf8');
  table = await readFile(new URL('../src/lib/components/finance/PivotTable.svelte', import.meta.url), 'utf8');
});

describe('PivotActionBar: barra accesible con alternativa táctil/teclado al dnd', () => {
  it('es un toolbar identificable, con el resumen de la selección', () => {
    expect(bar).toContain('role="toolbar"');
    expect(bar).toContain('data-testid="pivot-actionbar"');
    expect(bar).toContain('{concepts} concepto');
  });

  it('el menú de categorías se cierra cuando la selección es solo categorías (no se sueltan sobre otra)', () => {
    expect(bar).toContain('categoryOnlySelection');
    expect(bar).toContain('Las categorías no pueden soltarse sobre otra categoría');
  });

  it('el evento nuevo solo se dispara con nombre no vacío', () => {
    expect(bar).toMatch(/if \(newEventName\.trim\(\)\)/);
  });
});

describe('PivotTable: selección con Shift + checkbox (T12)', () => {
  it('monta <PivotActionBar> importado, no una reimplementación', () => {
    expect(table).toContain("import PivotActionBar from './PivotActionBar.svelte';");
    expect(table).toMatch(/<PivotActionBar[\s\S]*onClear={clearSelection}/);
  });

  it('reutiliza sendAll/acuse de $lib/finance/pivot-actions (R14/R25): no reimplementa el copy de cola', () => {
    expect(table).toMatch(/import \{[\s\S]*\bacuse\b[\s\S]*\bsendAll\b[\s\S]*\} from '\$lib\/finance\/pivot-actions';/);
    // R25: el copy de "en cola" vive UNA vez en pivot-actions; PivotTable no lo duplica.
    expect(table).not.toContain('Guardado en este dispositivo');
    expect(table).not.toMatch(/function acuse\(/);
    expect(table).not.toMatch(/const COLA = /);
  });

  it('invalida con el token canónico cc:finance a través de un cierre sobre sendAll (ruling: sendAll real pide 3 argumentos)', () => {
    expect(table).toMatch(/import \{[^}]*\binvalidate\b[^}]*\} from '\$app\/navigation';/);
    expect(table).toMatch(/sendAll\(householdId, payloads, \{\s*invalidate,/);
  });

  it('T12-M5/F6-I5: todo lo que escribe pasa por `run`, con try/catch, aviso de fallo y bloqueo de reenvío', () => {
    // Un rechazo del outbox (IndexedDB llena, cuota) dejaba una promesa sin
    // manejar y la acción a medias sin decir nada.
    expect(table).toMatch(/async function run\(fn: \(\) => Promise<void>\): Promise<void>/);
    expect(table).toMatch(/catch \{\s*toast = \{ message: 'No se pudo guardar el cambio\.' \};/);
    expect(table).toMatch(/if \(enviando\) return;/);
    expect(table).toMatch(/finally \{\s*enviando = false;/);
    // Ninguna acción ni drop llama al aplicador por fuera del envoltorio.
    for (const gesto of [
      'applyCategoryAssignment(payload.items, categoryId, payload.omitted)',
      'applyEventAssignment(payload.items, eventId, eventName, payload.omitted)',
      'applyNewEventAssignment(payload.items, name, payload.omitted)'
    ]) {
      expect(table).toContain(`run(() => ${gesto})`);
    }
    expect(table).toMatch(/<PivotActionBar[\s\S]*\{enviando\}/);
  });

  it('F6-I5: el toast cuenta el progreso del lote (sendAll lo publica con onProgress)', () => {
    expect(table).toMatch(/onProgress: \(done, total\) =>/);
    expect(table).toContain('`Guardando ${done} de ${total}…`');
  });

  it('T12-M4/F6-M7: la selección y las claves expandidas no sobreviven a un árbol nuevo', () => {
    // Cambio de chips/dims (routing superficial) o re-ejecución del loader
    // (cambio de rango): las claves dejan de significar lo mismo.
    expect(table).toContain('clearSelection();');
    expect(table).toMatch(/vistoRows !== rows \|\| vistoClave !== clave/);
    expect(table).toMatch(/\[\.\.\.expanded\]\.filter\(\(k\) => expandableKeys\.has\(k\)\)/);
  });

  it('F6-M3: al cerrar el aviso el foco vuelve a un ancla estable, no al <body>', () => {
    expect(table).toContain('function devolverFoco()');
    expect(table).toMatch(/data-fila=\{node\.key\}/);
    expect(table).toMatch(/toast = null; devolverFoco\(\);/);
  });

  it('R27: createEventPayload(name, id) — nunca (id, name)', () => {
    expect(table).toMatch(/createEventPayload\(name, eventId\)/);
    expect(table).not.toMatch(/createEventPayload\(eventId, name\)/);
  });

  it('sin non-null assertion sobre txId: usa una guarda de tipo o flatMap', () => {
    expect(table).not.toMatch(/\.txId!/);
  });

  it('shift+clic selecciona un rango de hermanos; clic simple alterna', () => {
    expect(table).toContain('function clickItem(');
    expect(table).toContain('rangeBetween(siblings, lastKey, item.key)');
    expect(table).toContain('toggleInMap(selected, item)');
  });

  it('nodeRow ahora recibe los hermanos (4º argumento) en las 5 llamadas del tbody + la recursiva del snippet', () => {
    const opens = table.match(/\{@render nodeRow\(/g) ?? [];
    expect(opens.length).toBe(6);
    expect(table).toContain("{@render nodeRow(node, 'ingreso', dims, selectableListAny(ingresoTree, dims))}");
    expect(table).toContain("{@render nodeRow(node, 'gasto', dims, selectableListAny(gastoTree, dims))}");
    expect(table).toContain("{@render nodeRow(child, 'evento', dims, selectableListAny(event.children, dims))}");
    expect(table).toContain("{@render nodeRow(node, 'transferencia', INTERNA_DIMS, [])}");
    expect(table).toContain("{@render nodeRow(node, 'inversion', INVERSION_DIMS, [])}");
    expect(table).toContain('{@render nodeRow(child, kind, nodeDims, childSiblings)}');
  });

  it('el checkbox de selección vive en la celda del árbol, con aria-label propio', () => {
    expect(table).toMatch(/<input type="checkbox" class="marca"/);
    expect(table).toContain('aria-label={`seleccionar ${node.label}`}');
  });

  it('el toast de "Deshacer" existe y no rompe con teclado (botón real, no <a>)', () => {
    expect(table).toContain('data-testid="pivot-toast"');
    expect(table).toMatch(/role="status"/);
    expect(table).toContain('>Deshacer<');
  });

  it('pasa la lista COMPLETA de eventos del household a la barra (no la recorta a los visibles en la búsqueda)', () => {
    // Desviación deliberada del snippet del brief (que remapea `displayEventos`,
    // el cual se reduce a `eventTree` mientras `hasSearch` es true y omitiría
    // eventos sin movimientos visibles): se pasa `events` (el prop íntegro).
    expect(table).toMatch(/<PivotActionBar[^>]*\{events\}/);
  });

  it('sin `as` (regla del entorno): allRoots no fuerza el tipo con una aserción', () => {
    expect(table).not.toMatch(/as PivotNodeLike\[\]/);
  });

  it('buildTxCategoryIndex recibe pares {id, categoryId} aplanados desde los movs de cada fila (AnaliticaPivotRow no trae categoryId por movimiento)', () => {
    expect(table).toMatch(/buildTxCategoryIndex\(\s*rows\.flatMap/);
  });

  it('I1: el checkbox cancela la activación nativa antes de leer shiftKey (evita que Svelte deje de repintar un valor sin cambio neto)', () => {
    // Sin `preventDefault()`, un Shift+clic que reafirma una fila YA
    // seleccionada (p.ej. reajustar el rango) no cambia `selected.has(key)`:
    // Svelte no repinta el `checked` nativo que el navegador ya cambió, y la
    // casilla queda desmarcada mientras el ítem sigue en la selección.
    expect(table).toMatch(
      /onclick={\(e\) => \{[\s\S]*e\.preventDefault\(\);[\s\S]*e\.stopPropagation\(\);[\s\S]*if \(item\) clickItem\(item, siblings, e\.shiftKey\);[\s\S]*\}\}/
    );
  });

  it('I2: "Deshacer" de una recategorización no se ofrece cuando el plan no puede restaurar nada (todas las previas eran null)', () => {
    // El caso más habitual al recategorizar es partir de "sin clasificar":
    // `planCategoryUndo` sale con reassignments/bulkRestores vacíos y todo en
    // `skipped`. Sin esta guarda, `onUndo` se ofrecía igual (con `movidos > 0`,
    // que solo cuenta lo ENVIADO, no lo restaurable) y `runCategoryUndo`
    // mandaba un lote vacío que `acuse` acusaba como «No hay nada que asignar».
    expect(table).toMatch(
      /const puedeDeshacer = plan\.reassignments\.length > 0 \|\| plan\.bulkRestores\.length > 0;/
    );
    expect(table).toMatch(/r\.ok && movidos > 0 && puedeDeshacer \? \{ onUndo: \(\) => runCategoryUndo\(plan\) \} : \{\}/);
    // T12-M6: la rama «No se pudo deshacer: N sin categoría previa» era
    // inalcanzable tras esa guarda y se borró en vez de condicionarla; un
    // mensaje muerto es peor que ninguno.
    expect(table).not.toMatch(/No se pudo deshacer/);
  });

  it('F6-I1: el acuse de «Deshacer» avisa SIEMPRE de que las reglas creadas se conservan', () => {
    // El servidor no revierte la regla por ninguno de los dos caminos del plan
    // (`finance.category.assignConcept` siempre INSERTA una nueva): condicionar
    // el aviso a `bulkRestores` dejaba el camino `reassignments` prometiendo un
    // «Deshecho» limpio que la capa de reglas no cumple.
    expect(table).toContain("const aviso = ' · las reglas creadas se conservan (bórralas en Ajustes)';");
    expect(table).not.toMatch(/plan\.bulkRestores\.length > 0 \? ' · las reglas creadas/);
  });

  it('el plan de deshacer de una recategorización cubre TAMBIÉN una hoja de movimiento suelta, no solo conceptos', () => {
    // Defecto del snippet del brief: `planCategoryUndo(conceptItems, …)` con
    // `conceptItems = items.filter(txId == null && categoryId == null)`
    // excluye las hojas de movimiento (txId set) del plan. Seleccionar UNA sola
    // hoja y recategorizarla deja el plan vacío (`planCategoryUndo` sí sabe
    // indexarlas por id exacto, ver `finance-pivot-actions.test.ts`, caso
    // "mezcla de un nodo de concepto y una hoja de movimiento"): pulsar
    // «Deshacer» no restaura nada y el toast dice, engañoso, «No hay nada que
    // asignar» (acuse con sent===0). `planCategoryUndo` debe recibir todos los
    // ítems salvo los de categoría agregada (`categoryId == null`), no solo
    // `conceptItems`.
    expect(table).toMatch(/const undoItems = items\.filter\(\(i\) => i\.categoryId == null\);/);
    expect(table).toMatch(/planCategoryUndo\(undoItems, movIdsByKey, txCatIndex\)/);
    expect(table).not.toMatch(/planCategoryUndo\(conceptItems, movIdsByKey, txCatIndex\)/);
  });
});
