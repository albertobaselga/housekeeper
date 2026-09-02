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
  it('F6-M5: grupo identificable por su etiqueta, sin prometer el patrón toolbar de APG', () => {
    // `role="toolbar"` exige navegación por flechas y tabindex itinerante; sin
    // ellos el rol miente al lector de pantalla.
    expect(bar).not.toContain('role="toolbar"');
    expect(bar).toContain('aria-label="Acciones sobre la selección"');
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
    // Los aplicadores se invocan DENTRO del envoltorio. C-M4: cualitativo, no
    // un conteo exacto — un refactor legítimo (una acción más, una menos) no
    // debe teñir esto de rojo sin haber cambiado nada del comportamiento.
    const dentroDeRun = table.match(/run\(async \(\) => \{\s*await apply\w+\(/g) ?? [];
    expect(dentroDeRun.length).toBeGreaterThan(0);
    expect(table).toContain('return run(async () => {');
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

  it('T13-M1/T13-M2: el popover de evento nuevo exige nombre, toma el foco, tiene Cancelar y Escape propio', () => {
    expect(table).toContain('disabled={newEventName.trim().length === 0}');
    expect(table).toMatch(/\$effect\(\(\) => \{\s*if \(newEventDrop !== null\) newEventInput\?\.focus\(\);/);
    expect(table).toContain('>Cancelar<');
    // Escape desde CUALQUIER control del popover (campo y los dos botones), no
    // solo desde dentro del <input>, que era justo donde el foco no estaba.
    // C-M4: que esté enganchado a más de un control basta; el número exacto de
    // controles del popover no es lo que este caso vigila.
    const escapes = table.match(/onkeydown=\{onPopoverKeydown\}/g) ?? [];
    expect(escapes.length).toBeGreaterThan(1);
    expect(table).toMatch(/function onPopoverKeydown[\s\S]*?cancelNewEventDrop\(\);/);
    // El atributo inerte que pedía el foco («data-» + «autofocus») ya no está.
    expect(table).not.toMatch(/<input[^>]*data-autofocus/);
  });

  it('T13-M4/T13-M5: soltar una fila sobre sí misma no hace nada, y un drop aplicado limpia la selección', () => {
    expect(table).toMatch(/sueltaSobreSiMisma\(e, destinoKey\)/);
    expect(table).toMatch(/e\.dataTransfer\?\.getData\('text\/plain'\) === destinoKey/);
    // C-M4: cualitativo. El comportamiento (qué payloads salen) lo cubre
    // finance-pivot-actions.test.ts; aquí solo se vigila que el drop no deje
    // la selección viva para que el siguiente gesto la reenvíe.
    const drops = table.match(/await apply\w+\(payload\.items[\s\S]{0,120}?clearSelection\(\);/g) ?? [];
    expect(drops.length).toBeGreaterThan(0);
  });

  it('T13-M6: el popover se posiciona con `fixed` y coordenadas, y se abre hacia arriba si no cabe', () => {
    // `.pivot-scroll` lleva overflow-x:auto, que vuelve auto también el eje Y:
    // dentro de la tabla el popover se recortaba SIEMPRE.
    expect(table).toMatch(/\.popover-evento \{ position: fixed;/);
    expect(table).toMatch(/r\.bottom \+ POPOVER_H <= window\.innerHeight \? r\.bottom : r\.top - POPOVER_H/);
    expect(table).toContain('style:left={`${popoverPos.left}px`}');
  });

  it('F6-M3: al cerrar el aviso el foco vuelve a un ancla estable, no al <body>', () => {
    expect(table).toContain('function devolverFoco()');
    expect(table).toMatch(/data-fila=\{node\.key\}/);
    expect(table).toMatch(/toast = null; devolverFoco\(\);/);
  });

  it('F6-I4/T12-M1: los payloads los componen funciones puras de pivot-actions, no el .svelte', () => {
    // La partición `txId != null` estaba escrita tres veces dentro del
    // componente y la composición de payloads de evento dos, sin ninguna
    // prueba de ningún nivel. Ahora el componente solo encadena.
    for (const compositor of [
      'eventAssignPayloads(items, eventId)',
      'undoEventPayloads(items, eventId)',
      'newEventPayloads(items, name, eventId)',
      'categoryAssignPayloads(items, categoryId, movIdsByKey)',
      'recurrencePayloads(items, rec)',
      'categoryUndoPayloads(plan)'
    ]) {
      expect(table).toContain(compositor);
    }
    // Y ya no arma ningún payload a mano.
    expect(table).not.toMatch(/kind: 'finance\./);
    expect(table).not.toMatch(/assignConceptToEvent\(/);
    expect(table).not.toMatch(/createEventPayload\(/);
    expect(table).not.toMatch(/bulkByIds\(/);
  });

  it('sin non-null assertion sobre txId: la partición vive en splitByTx/splitForCategory', () => {
    expect(table).not.toMatch(/\.txId!/);
    expect(table).toContain('splitByTx(items)');
    expect(table).toContain('splitForCategory(items, movIdsByKey)');
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
    expect(table).toMatch(/r\.ok && movidos > 0 && puedeDeshacer \? \{ onUndo: \(\) => runCategoryUndo\(/);
    // T12-M6: la rama «No se pudo deshacer: N sin categoría previa» era
    // inalcanzable tras esa guarda y se borró en vez de condicionarla; un
    // mensaje muerto es peor que ninguno.
    expect(table).not.toMatch(/No se pudo deshacer/);
  });

  it('C-I1: el acuse de «Deshacer» solo avisa de las reglas que de verdad sobreviven', () => {
    // `finance.category.assignConcept` SUSTITUYE la regla manual de prioridad 0
    // del mismo patrón (`replaceManualRule`, integrado en el servidor), así que
    // la rama `reassignments` reajusta la regla del drop y no hay nada que
    // borrar: avisar allí invitaría al usuario a deshacer el estado correcto.
    // Solo `bulkRestores` (por ids, sin tocar reglas) la deja huérfana, y solo
    // si el drop llegó a crear alguna (un drop de solo hojas no crea ninguna).
    expect(table).not.toContain("const aviso = ' · las reglas creadas se conservan (bórralas en Ajustes)';");
    expect(table).toMatch(/huerfanas === 0\s*\?\s*''/);
    expect(table).toContain("' · la regla creada se conserva (bórrala en Ajustes)'");
    expect(table).toMatch(/const huerfanas = reparto\.concepts\.filter\(/);
    expect(table).toMatch(/!plan\.reassignments\.some\(\(re\) => re\.provider === i\.provider && re\.concept === i\.concept\)/);
    expect(table).toContain('runCategoryUndo(plan, huerfanas)');
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
