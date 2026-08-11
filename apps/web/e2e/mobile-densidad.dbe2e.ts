import { expect, test, type Page } from '@playwright/test';

import { HOUSEHOLD, loginAs } from './helpers';

/*
 * El sistema móvil, medido.
 *
 * `mobile-overflow.dbe2e.ts` guarda que nada se salga a lo ancho. Esta batería
 * guarda lo otro: que el marco no se coma la pantalla, que lo que se pulsa se
 * pueda pulsar y que el dato tenga el tamaño del dato. Son reglas de SISTEMA:
 * siguen valiendo aunque «Pagos» pase a llamarse «Contrato», la Guía estrene
 * modo libro y Hoy y el calendario se reescriban. Por eso no afirman textos.
 *
 * Medidas de partida (main 9316709, antes de la pasada móvil), para que se vea
 * de qué se está hablando:
 *
 *   marco / alto de ventana   0,36–0,85 a 320 px   ·   0,36–0,52 a 390
 *   dianas por debajo de 44   hasta 29 por pantalla
 *   texto por debajo de 12    9,76 px en la navegación, el control más usado
 *   tamaños por pantalla      10–16
 *   listas que saben decir cuál es la principal   ninguna
 */
test.skip(!process.env.E2E_DATABASE_URL, 'Requiere E2E_DATABASE_URL (usa pnpm test:e2e:db)');

/** Los dos móviles del contrato: el estrecho y el real. */
const VIEWPORTS = [
  /*
   * `marco` es la fracción de la primera pantalla que puede gastarse en cromo;
   * `lista`, cuántos elementos de la lista principal tienen que caber en ella
   * sin desplazar (o todos, si la casa tiene menos).
   */
  { width: 320, height: 568, marco: 0.25, lista: 3 },
  { width: 390, height: 844, marco: 0.2, lista: 3 }
] as const;

interface DensityRoute {
  path: string;
  label: string;
  as: 'admin' | 'employee';
  /** La lista principal puede no existir en pantallas que no son listas. */
  lista?: false;
}

const ROUTES: readonly DensityRoute[] = [
  { path: 'today', label: 'Hoy (interna)', as: 'employee' },
  { path: 'today', label: 'Hoy (familia)', as: 'admin' },
  { path: 'routines', label: 'Rutinas', as: 'employee' },
  { path: 'wiki', label: 'Guía de la casa', as: 'employee' },
  { path: 'wiki/lavadora', label: 'Guía · una nota', as: 'employee', lista: false },
  { path: 'menu', label: 'Menú', as: 'admin', lista: false },
  { path: 'employment', label: 'Contrato (familia)', as: 'admin' },
  { path: 'employment', label: 'Contrato (interna)', as: 'employee' },
  { path: 'calendar', label: 'Calendario', as: 'employee', lista: false },
  { path: 'contacts', label: 'Contactos', as: 'admin' },
  { path: 'emergency', label: 'Emergencias', as: 'employee' },
  { path: 'settings', label: 'Ajustes', as: 'admin' }
];

/**
 * Todo lo que se mide, en una sola visita al navegador.
 *
 * `marco` es literalmente «cuántos píxeles se gastan antes del primer dato»:
 * la coordenada del primer bloque de contenido tras la cabecera de página, más
 * el alto de la barra inferior, que también es cromo.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (element: Element) => element.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    const nav = document.querySelector('nav.bottom-nav');
    const navHeight = nav && getComputedStyle(nav).display !== 'none' ? rect(nav).height : 0;
    const topbar = document.querySelector('header.topbar');
    const topbarHeight = topbar && getComputedStyle(topbar).display !== 'none' ? rect(topbar).height : 0;

    const main = document.querySelector('#main-content');
    const wrap = main?.querySelector('.page-wrap') ?? main;
    let firstContentTop = topbarHeight;
    if (wrap) {
      const content = Array.from(wrap.children).filter(
        (element) => rect(element).height > 0 && !element.matches('.page-header, .page-head')
      );
      if (content.length > 0) firstContentTop = rect(content[0]).top + window.scrollY;
    }
    const useful = viewportHeight - navHeight;

    /*
     * El presupuesto de marco cubre UNA línea de título. Cuando el h1 es el
     * nombre de la cosa que se ha abierto —el título de una nota de la Guía— y
     * no cabe en una línea, esas líneas de más son contenido: es literalmente
     * lo que se ha venido a leer. Lo que el presupuesto vigila es el cromo que
     * se repite pantalla tras pantalla, no el largo de un título ajeno.
     */
    const h1 = document.querySelector('#main-content h1');
    let titleOverflow = 0;
    if (h1) {
      const style = getComputedStyle(h1);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      titleOverflow = Math.max(0, rect(h1).height - line);
    }

    // Dianas: todo lo que se pulsa dentro del contenido y de la navegación.
    const interactive = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#main-content a[href], #main-content button:not([disabled]), #main-content input:not([type="hidden"]), #main-content select, #main-content textarea, #main-content summary, nav.bottom-nav a, nav.bottom-nav button'
      )
    ).filter((element) => {
      const box = rect(element);
      if (box.width === 0 || box.height === 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    });

    const describe = (element: HTMLElement) => {
      const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).join('.') : '';
      const text = (element.textContent ?? '').trim().slice(0, 28);
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${text ? ` «${text}»` : ''}`;
    };

    /*
     * Un enlace DENTRO de una frase no puede medir 44 px de alto sin romper el
     * párrafo que lo contiene, y no es un fallo de diseño: es la excepción por
     * texto en línea de la propia norma. La regla, medida y sin lista de
     * nombres: `display: inline` y con texto hermano alrededor.
     */
    const inSentence = (element: HTMLElement) => {
      if (getComputedStyle(element).display !== 'inline') return false;
      const parent = element.parentElement;
      if (!parent) return false;
      const around = Array.from(parent.childNodes)
        .filter((node) => node !== element)
        .map((node) => (node.textContent ?? '').trim())
        .join('');
      return around.length > 0;
    };

    const small: string[] = [];
    for (const element of interactive) {
      if (inSentence(element)) continue;
      const box = rect(element);
      // Una casilla o un radio nativo son la MARCA; la diana es su etiqueta,
      // que es lo que de verdad se toca. Se mide la etiqueta.
      const target =
        (element as HTMLInputElement).type === 'checkbox' || (element as HTMLInputElement).type === 'radio'
          ? rect(element.closest('label') ?? element)
          : box;
      if (target.width < 44 || target.height < 44) {
        small.push(`${describe(element)} → ${Math.round(target.width)}×${Math.round(target.height)}`);
      }
    }

    /*
     * Separación entre dianas contiguas: 8 px. Se comparan pares que se solapan
     * en un eje, que son los que un dedo puede confundir.
     *
     * Los pares que se TOCAN (hueco exactamente 0 y mismo padre) quedan fuera,
     * y no por indulgencia: un contenedor con hueco cero es un control
     * segmentado —la barra inferior, la tira de días, la rejilla del mes— donde
     * cada píxel pertenece a un destino y no hay zona muerta. El modo de fallo
     * que vigila la regla de los 8 px es otro: dos botones IDÉNTICOS a 7 px uno
     * de otro, uno de ellos destructivo, con espacio muerto en medio.
     */
    const tooClose: string[] = [];
    const inChrome = (element: HTMLElement) => Boolean(element.closest('nav.bottom-nav'));
    for (let i = 0; i < interactive.length; i += 1) {
      for (let j = i + 1; j < interactive.length; j += 1) {
        if (interactive[i].contains(interactive[j]) || interactive[j].contains(interactive[i])) continue;
        // La barra inferior FLOTA sobre la página: lo que queda debajo está
        // tapado, no contiguo. Comparar una y otra capa mediría una distancia
        // que el dedo nunca ve.
        if (inChrome(interactive[i]) !== inChrome(interactive[j])) continue;
        const a = rect(interactive[i]);
        const b = rect(interactive[j]);
        const overlapY = a.top < b.bottom && b.top < a.bottom;
        if (!overlapY) continue;
        const gap = Math.max(b.left - a.right, a.left - b.right);
        if (gap > 0 && gap < 8) {
          tooClose.push(`${describe(interactive[i])} ↔ ${describe(interactive[j])} → ${Math.round(gap)}px`);
        }
      }
    }

    // Tipografía computada de los nodos que llevan texto propio.
    const sizes = new Map<number, number>();
    const weights = new Set<string>();
    const tiny: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const ownText = Array.from(element.childNodes).some(
        (node) => node.nodeType === 3 && (node.textContent ?? '').trim().length > 0
      );
      if (!ownText) continue;
      const box = rect(element);
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden') continue;
      const size = Math.round(parseFloat(style.fontSize) * 100) / 100;
      sizes.set(size, (sizes.get(size) ?? 0) + 1);
      weights.add(style.fontWeight);
      const text = (element.textContent ?? '').trim();
      /*
       * Dos pisos, los de la decisión: 12 px para una ETIQUETA (columna,
       * pestaña, navegación, rótulo) y 14 px para cualquier cosa que sea una
       * FRASE. Lo que separa una de otra, medido y sin lista de nombres: una
       * frase termina en punto o encadena más de ocho palabras sin usar «·»,
       * que es el separador con el que esta aplicación escribe sus líneas de
       * apoyo («Empleada · cada semana · la próxima el jueves»). `<small>` no
       * entra: es letra pequeña por declaración del propio marcado y su rol en
       * la escala son los 13 px de `--text-meta`. Lo que aquí se persigue es la
       * prosa disfrazada de apoyo, y esa se escribe en párrafos.
       */
      const words = text.split(/\s+/).length;
      const isSentence =
        element.tagName !== 'SMALL' &&
        (/\.(\s|$)/.test(text) || (words > 8 && !text.includes('·')));
      if (size < 12) tiny.push(`${size}px ${describe(element)}`);
      else if (size < 14 && isSentence) tiny.push(`${size}px, frase ${describe(element)}`);
    }

    // La lista principal, y cuántos de sus elementos se ven de una vez.
    const list = document.querySelector('[data-lista="principal"]');
    let visible = 0;
    let total = 0;
    if (list) {
      for (const item of Array.from(list.children)) {
        const box = rect(item);
        if (box.height === 0) continue;
        total += 1;
        if (box.top >= -1 && box.bottom <= useful + 1) visible += 1;
      }
    }

    // La primera acción de la ruta, entera en la primera ventana útil.
    const firstAction = interactive.find((element) => element.closest('#main-content'));
    const firstActionBottom = firstAction ? rect(firstAction).bottom : 0;

    // La columna del dinero: toda cifra comparte x derecha dentro de su lista.
    const columns = new Map<string, Set<number>>();
    for (const cifra of Array.from(document.querySelectorAll<HTMLElement>('.cifra'))) {
      const owner = cifra.closest('.ledger-list, .balance-list, .fila-lista');
      if (!owner) continue;
      const key = owner.className;
      if (!columns.has(key)) columns.set(key, new Set());
      columns.get(key)!.add(Math.round(rect(cifra).right));
    }
    const scatteredColumns = [...columns.entries()]
      .filter(([, xs]) => xs.size > 1)
      .map(([key, xs]) => `${key}: ${xs.size} posiciones (${[...xs].join(', ')})`);

    // Ningún elemento del contenido queda debajo de la barra sin scroll.
    const documentBottom = document.documentElement.scrollHeight;
    const lastVisible = Array.from(wrap?.children ?? []).at(-1);
    const lastBottom = lastVisible ? rect(lastVisible).bottom + window.scrollY : 0;

    // El h1 empieza en el gutter, como el resto del contenido.
    const heading = document.querySelector('#main-content h1');
    const headingLeft = heading ? Math.round(rect(heading).left) : -1;
    const gutter = wrap ? Math.round(parseFloat(getComputedStyle(wrap).paddingLeft)) : -1;

    return {
      marco: Math.round(firstContentTop - titleOverflow + navHeight),
      viewportHeight,
      navHeight: Math.round(navHeight),
      firstActionLabel: firstAction ? describe(firstAction) : '',
      firstActionBottom: Math.round(firstActionBottom),
      useful: Math.round(useful),
      small,
      tooClose,
      sizes: [...sizes.keys()].sort((a, b) => a - b),
      weights: [...weights].sort(),
      tiny,
      hasList: Boolean(list),
      visible,
      total,
      scatteredColumns,
      documentBottom: Math.round(documentBottom),
      lastBottom: Math.round(lastBottom),
      headingLeft,
      gutter
    };
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`a ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(`${route.label} respeta el sistema`, async ({ page }) => {
        await page.context().clearCookies();
        await loginAs(page, route.as);
        await page.goto(`/h/${HOUSEHOLD}/${route.path}`);
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => window.scrollTo(0, 0));
        const m = await measure(page);

        // A1 · El marco no se come la pantalla. Se gastaba entre el 33 y el
        // 85 % de la primera pantalla en repetir dónde estás.
        const ratio = m.marco / m.viewportHeight;
        expect(
          ratio,
          `A1 · ${route.label}: el marco ocupa ${m.marco} px de ${m.viewportHeight} (${(ratio * 100).toFixed(0)} %), por encima del ${viewport.marco * 100} % permitido`
        ).toBeLessThanOrEqual(viewport.marco);

        // A2 · La primera acción de la ruta cabe ENTERA en la primera ventana.
        expect(
          m.firstActionBottom,
          `A2 · ${route.label}: la primera acción (${m.firstActionLabel}) acaba en ${m.firstActionBottom} px y la ventana útil son ${m.useful}`
        ).toBeLessThanOrEqual(m.useful);

        // A3 · Ninguna diana por debajo de 44×44, y 8 px entre contiguas.
        expect(m.small, `A3 · ${route.label}: dianas por debajo de 44×44`).toEqual([]);
        expect(m.tooClose, `A3 · ${route.label}: dianas contiguas a menos de 8 px`).toEqual([]);

        // A4 · Ningún texto por debajo de 12 px, ni frases por debajo de 14.
        expect(m.tiny, `A4 · ${route.label}: texto por debajo del piso tipográfico`).toEqual([]);

        // A5 · Como máximo 4 tamaños y 3 pesos por pantalla. Una pantalla
        // llegaba a usar 16 tamaños y 5 pesos.
        expect(
          m.sizes.length,
          `A5 · ${route.label}: ${m.sizes.length} tamaños en pantalla (${m.sizes.join(', ')})`
        ).toBeLessThanOrEqual(4);
        expect(
          m.weights.length,
          `A5 · ${route.label}: ${m.weights.length} pesos en pantalla (${m.weights.join(', ')})`
        ).toBeLessThanOrEqual(3);

        // A6 · La pantalla sabe decir cuál es su lista principal, y se ven al
        // menos tres de sus elementos sin desplazar.
        if (route.lista !== false) {
          expect(m.hasList, `A6 · ${route.label}: ninguna lista declara ser la principal`).toBe(true);
          // El objetivo del ancho, o todos si la casa tiene menos: la regla mide
          // la densidad de la pantalla, no cuántas filas hay sembradas.
          const esperados = Math.min(viewport.lista, m.total);
          expect(
            m.visible,
            `A6 · ${route.label}: la lista principal tiene ${m.total} elementos y solo ${m.visible} caben en la primera ventana`
          ).toBeGreaterThanOrEqual(esperados);
        }

        // A7 · Ninguna cifra fuera de su columna.
        expect(m.scatteredColumns, `A7 · ${route.label}: cifras en varias posiciones`).toEqual([]);

        // A8 · El h1 empieza en el gutter y nada queda bajo la barra inferior
        // sin scroll que lo saque.
        expect(m.headingLeft, `A8 · ${route.label}: el h1 empieza en x=${m.headingLeft} y el gutter es ${m.gutter}`).toBe(
          m.gutter
        );
        expect(
          m.lastBottom,
          `A8 · ${route.label}: el último bloque acaba en ${m.lastBottom} px y el documento mide ${m.documentBottom}`
        ).toBeLessThanOrEqual(m.documentBottom);
      });
    }
  });
}

/*
 * A9 · La fuente, con sus condiciones de aceptación medidas y no supuestas.
 *
 * Antes de esto `font-family: Inter` estaba declarado, Inter NO se enviaba y
 * `document.fonts` devolvía cero caras: el producto no tenía tipografía, tenía
 * la del teléfono de cada cual. Aquí se comprueba lo que la decisión de diseño
 * exigía antes de mergear: que llega, que sus cifras son tabulares —si no, la
 * columna del dinero no forma columna— y que los diacríticos del español
 * (á é í ó ú ñ ü ¿ ¡ €) salen de ella y no de una familia de reserva.
 */
test('la fuente del producto llega y sus cifras forman columna', async ({ page }) => {
  await page.context().clearCookies();
  await loginAs(page, 'employee');
  await page.goto(`/h/${HOUSEHOLD}/today`);
  await page.waitForLoadState('networkidle');

  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    const familia = 'Atkinson Hyperlegible Next';
    const cargada = [...document.fonts].some(
      (face) => face.family.includes('Atkinson') && face.status === 'loaded'
    );

    /*
     * Se mide en el DOM y no en un canvas: `font-variant-numeric` no viaja en
     * el atajo `font` de un contexto 2D, así que un canvas mediría siempre las
     * cifras proporcionales y no diría nada de la columna del dinero.
     */
    const banco = document.createElement('div');
    banco.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:16px/1 "' + familia + '"';
    document.body.append(banco);
    const medir = (texto: string, tabular: boolean): number => {
      const span = document.createElement('span');
      span.style.fontVariantNumeric = tabular ? 'tabular-nums lining-nums' : 'normal';
      span.textContent = texto;
      banco.append(span);
      const ancho = Math.round(span.getBoundingClientRect().width * 100) / 100;
      span.remove();
      return ancho;
    };
    // Cifras tabulares: diez unos y diez ochos miden lo mismo. Es la condición
    // sin la cual los importes no se pueden barrer con la vista.
    const unos = medir('1111111111', true);
    const ochos = medir('8888888888', true);
    // Y que la cara tiene DE VERDAD cifras proporcionales que `tnum` corrige:
    // si midieran igual sin pedirlo, el token no estaría haciendo nada.
    const unosProporcionales = medir('1111111111', false);
    const acentos = medir('áéíóúñü¿¡€', false);
    banco.remove();
    const soporta = document.fonts.check(`16px "${familia}"`, 'áéíóúñü¿¡€');
    const cuerpo = getComputedStyle(document.body).fontFamily;
    return { cargada, unos, ochos, unosProporcionales, acentos, soporta, cuerpo };
  });

  expect(font.cargada, 'la cara variable de Atkinson Hyperlegible Next no ha llegado al navegador').toBe(true);
  expect(font.cuerpo, 'el cuerpo del documento no usa la fuente del producto').toContain('Atkinson Hyperlegible Next');
  expect(
    font.unos,
    `cifras no tabulares: con tabular-nums, «1111111111» mide ${font.unos} y «8888888888», ${font.ochos}`
  ).toBe(font.ochos);
  expect(
    font.unosProporcionales,
    'las cifras ya miden igual sin pedir tabular-nums: el token no está haciendo nada y la comprobación no vale'
  ).not.toBe(font.ochos);
  expect(font.soporta, 'los diacríticos del español no salen de esta cara').toBe(true);
  expect(font.acentos, 'los diacríticos del español no se miden').toBeGreaterThan(0);
});
