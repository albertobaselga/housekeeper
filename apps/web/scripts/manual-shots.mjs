// ───────────────────────────────────────────────────────────────────────────
// Las capturas del manual de usuario (docs/manual/capturas/*.png).
//
// Cada imagen es una foto del viewport, sin marco: el marco de ventana lo pinta
// el propio manual con CSS (`.ventana` / `.ventana-barra` en
// docs/manual/index.html), y el título que va en esa barra sale de aquí, del
// `document.title` REAL de cada página, volcado en `titulos.json` junto a los
// PNG. Así el manual no escribe a mano un título que la aplicación ya sabe
// decir, que es justo lo que el manual está demostrando.
//
// Dos tamaños, y solo dos:
//   · escritorio 1280×800  → PNG de 2560×1600 (deviceScaleFactor 2)
//   · móvil       390×844  → PNG de  780×1688
// Son los mismos que declaran los `width`/`height` de las <img> del manual.
//
// ── Cómo se vuelve a ejecutar ──────────────────────────────────────────────
//
// Necesita un servidor con base de datos Y con identidad real (usuario y
// contraseña), porque la mitad de las pantallas del manual no existen sin una
// de las dos cosas. La receta completa, desde una base vacía:
//
//   # 1. Base de datos desechable con las fixtures sintéticas
//   export DATABASE_URL=postgresql://casa_admin@127.0.0.1:5432/casaclara_shots
//   export APP_DB_PASSWORD=shots-only WORKER_DB_PASSWORD=shots-only AUTH_DB_PASSWORD=shots-only
//   node packages/db/scripts/bootstrap.mjs
//   node packages/db/scripts/migrate.mjs
//   psql -d casaclara_shots -f packages/db/fixtures/001_two_households.sql
//
//   # 2. La Guía entera (corpus commiteado) y el contenido de las capturas
//   node packages/db/scripts/import-manual.mjs --household 10000000-0000-4000-8000-000000000001
//   psql -d casaclara_shots -v ON_ERROR_STOP=1 -f apps/web/scripts/manual-shots-seed.sql
//
//   # 3. Cuentas con contraseña, enganchadas a las membresías de la fixture
//   node apps/web/scripts/manual-shots-accounts.mjs
//
//   # 4. Servidor (build de producción) con base, identidad y claves de avisos
//   pnpm --filter @casa-clara/web build
//   DATABASE_URL=… DATABASE_AUTH_URL=… BETTER_AUTH_SECRET=… BETTER_AUTH_URL=http://127.0.0.1:4363 \
//   VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:… \
//   PORT=4363 ORIGIN=http://127.0.0.1:4363 node apps/web/build
//
//   # 5. Las capturas, y adelgazarlas antes de commitear
//   node apps/web/scripts/manual-shots.mjs --base http://127.0.0.1:4363
//   node apps/web/scripts/manual-shots-optimize.mjs
//
// La captura `familia-personal-alta` da de alta a «Elena» de verdad, así que la
// segunda vez sobre la MISMA base fallará por usuario repetido: se rehace sobre
// una base recién sembrada, o se borra a Elena antes.
//
// Opciones: `--out <dir>` (por omisión docs/manual/capturas), `--only a,b,c`
// para rehacer solo algunas, `--list` para ver los nombres.
// ───────────────────────────────────────────────────────────────────────────

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const args = process.argv.slice(2);
function option(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

const BASE = option('--base', 'http://127.0.0.1:4363').replace(/\/$/, '');
const OUT = path.resolve(option('--out', path.join(repoRoot, 'docs', 'manual', 'capturas')));
const ONLY = option('--only', null)?.split(',').map((name) => name.trim()).filter(Boolean) ?? null;
const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const PASSWORD = 'manual-de-la-casa-2026';

const DEVICES = {
  escritorio: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
  movil: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  }
};

const hogar = (ruta) => `/h/${HOUSEHOLD}${ruta}`;

// El acuerdo de Ana en la fixture. Contrato va en pestañas y, con dos empleadas
// en la casa, `/employment` a secas es la PORTADA: hay que decir de quién es el
// expediente o las capturas de dentro no llegan a existir.
const ANA = '12000000-0000-4000-8000-000000000001';
const expediente = (pestana = '') => hogar(`/employment${pestana}?empleada=${ANA}`);

// ── Utilidades de puesta en escena ─────────────────────────────────────────

/**
 * Deja el elemento arriba del viewport, POR DEBAJO de la barra superior fija:
 * en escritorio el `.topbar` es sticky y se comía la primera línea de lo que se
 * quería enseñar.
 */
async function encuadrar(page, selector, hueco = 16) {
  const target = typeof selector === 'string' ? page.locator(selector).first() : selector;
  await target.waitFor({ state: 'visible', timeout: 15_000 });
  await target.evaluate((node, gap) => {
    const barra = document.querySelector('.topbar');
    const alto = barra && getComputedStyle(barra).position === 'sticky' ? barra.getBoundingClientRect().height : 0;
    const y = node.getBoundingClientRect().top + window.scrollY - gap - alto;
    window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
  }, hueco);
  await page.waitForTimeout(250);
}

/** Abre un `<details>` por el texto de su resumen. */
async function desplegar(page, texto) {
  const resumen = page.locator('summary', { hasText: texto }).first();
  await resumen.waitFor({ state: 'visible', timeout: 15_000 });
  const abierto = await resumen.evaluate((node) => node.closest('details')?.open === true);
  if (!abierto) await resumen.click();
  await page.waitForTimeout(250);
}

/**
 * Abre el editor de condiciones. La pestaña enseña ya a UNA sola persona —la
 * que dice `?empleada=`—, así que aquí no hay que buscar ficha de nadie: el
 * editor es el único `<details>` llamado «Cambiar las condiciones». Sus
 * apartados son `<legend>`, no encabezados: los `<h3>` de esta pantalla son los
 * de «Lo que rige hoy», que es justo lo que estas capturas NO quieren retratar.
 */
async function abrirEditorDeVersion(page) {
  await desplegar(page, 'Cambiar las condiciones');
  await page.locator('legend:has-text("Lo básico")').first().waitFor({ timeout: 15_000 });
  // El horario es lo que la captura de «Horario» tiene que enseñar entero: si
  // el borrador nace sin declararlo, no hay tabla de siete días que retratar.
  const declara = page.locator('input[name="schedule.declared"]').first();
  if ((await declara.count()) > 0 && !(await declara.isChecked())) await declara.check();
  await page.waitForTimeout(400);
}

/** Cambia a la pestaña «Lista de la compra» del menú (es un control, no una ruta). */
async function abrirLaCompra(page) {
  await page.getByRole('button', { name: 'Lista de la compra' }).first().click();
  await page.waitForTimeout(600);
}

/** Espera a que la página deje de moverse: fuentes cargadas y sin animación. */
async function asentar(page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(400);
}

// ── El catálogo de capturas ────────────────────────────────────────────────
//
// `cuenta: null` = sin sesión. `foco` encuadra un elemento antes de disparar.

const CAPTURAS = [
  // ── Fuera del hogar ──────────────────────────────────────────────────────
  { nombre: 'login', cuenta: null, aparato: 'escritorio', ruta: '/login' },
  { nombre: 'login-movil', cuenta: null, aparato: 'movil', ruta: '/login' },
  { nombre: 'sin-conexion-movil', cuenta: null, aparato: 'movil', ruta: '/offline' },

  // ── Hoy, la familia ──────────────────────────────────────────────────────
  { nombre: 'familia-hoy', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/today') },
  {
    nombre: 'familia-hoy-agenda',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/today'),
    foco: '#rutinas-de-hoy'
  },
  {
    nombre: 'familia-hoy-esta-semana',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/today'),
    async preparar(page) {
      // Marcar una rutina deja el bloque plegado «N hechas hoy» al fondo, que
      // es justo lo que esta captura tiene que enseñar junto a «Esta semana».
      if ((await page.locator('summary', { hasText: 'hechas hoy' }).count()) === 0) {
        // La ÚLTIMA de la lista: las primeras pueden ser del bloque «Se quedó
        // pendiente», cuya ocurrencia es de otro día y no cuenta como «hecha hoy».
        const marcar = page.locator('#rutinas-de-hoy').getByRole('button', { name: 'Marcar hecha' }).last();
        await marcar.click();
        await page.getByRole('button', { name: 'Deshacer' }).first().waitFor({ timeout: 15_000 });
        // El chip aparece nada más pulsar (es optimista), pero el bloque plegado
        // lo pinta el SERVIDOR: hay que esperar a que el marcado salga de la
        // bandeja y volver a pedir la página.
        for (let intento = 0; intento < 5; intento += 1) {
          await page.waitForTimeout(2000);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await asentar(page);
          if ((await page.locator('summary', { hasText: 'hechas hoy' }).count()) > 0) break;
        }
      }
      await desplegar(page, 'hechas hoy');
    },
    foco: 'summary:has-text("hechas hoy")'
  },

  // ── Menú y compra ────────────────────────────────────────────────────────
  {
    nombre: 'familia-menu',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/menu'),
    foco: '.menu-day-grid, .menu-slots, main'
  },
  {
    nombre: 'familia-menu-nueva-receta',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/menu'),
    async preparar(page) {
      await page.getByRole('button', { name: 'Asignar' }).first().click();
      await page.waitForTimeout(400);
      const pestana = page.getByRole('button', { name: 'Nueva receta' }).first();
      if (await pestana.count()) await pestana.click();
      await page.waitForTimeout(300);
    },
    foco: 'text=Nueva receta'
  },
  {
    nombre: 'familia-menu-plantillas',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/menu'),
    foco: 'h2:has-text("Semanas plantilla")'
  },
  {
    nombre: 'familia-compra',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/menu'),
    preparar: abrirLaCompra,
    // Se encuadra la sección «Personal» a media altura para que encima quepan
    // las secciones del súper con sus «· del menú», que es la otra mitad de lo
    // que esta captura tiene que enseñar.
    foco: { selector: 'h3:has-text("Personal"), h2:has-text("Personal")', hueco: 430 }
  },

  // ── Rutinas ──────────────────────────────────────────────────────────────
  { nombre: 'familia-rutinas', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/routines') },
  {
    nombre: 'familia-rutinas-cadencia',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/routines'),
    async preparar(page) {
      await page.getByRole('radio', { name: 'Cada cierto tiempo' }).first().check();
      await page.waitForTimeout(300);
    },
    foco: 'text=¿Cuándo toca?'
  },
  {
    nombre: 'familia-rutinas-sin-dia',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/routines'),
    foco: 'h3:has-text("Todavía no lo sabemos"), h2:has-text("Todavía no lo sabemos")'
  },

  // ── Guía de la casa ──────────────────────────────────────────────────────
  { nombre: 'familia-guia', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/wiki') },
  {
    nombre: 'familia-guia-libro',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/wiki'),
    foco: 'text=Leerla entera, como un libro'
  },
  {
    nombre: 'familia-guia-apartados',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/wiki'),
    foco: 'h2:has-text("Apartados")'
  },
  {
    nombre: 'familia-guia-nota',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/wiki/rutina-diaria-de-referencia')
  },
  {
    nombre: 'familia-guia-pendientes',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/wiki/pendientes-de-completar')
  },
  {
    nombre: 'familia-guia-editor',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/wiki/principios-de-la-casa'),
    async preparar(page) {
      await page.getByRole('button', { name: /Editar/ }).first().click();
      await page.waitForTimeout(1200);
      await desplegar(page, 'Opciones avanzadas');
    }
  },
  {
    nombre: 'familia-guia-progreso',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/wiki/progreso'),
    foco: 'h2:has-text("Quién se ha leído la guía")'
  },

  // ── Contrato (familia) ───────────────────────────────────────────────────
  { nombre: 'familia-contrato', cuenta: 'alberto', aparato: 'escritorio', ruta: expediente() },
  {
    // La elección de persona ya no es una tira de chips dentro del expediente:
    // es la portada del hogar, que es por donde se entra a Contrato.
    nombre: 'familia-contrato-empleadas',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment'),
    foco: 'h2:has-text("El expediente de cada una")'
  },
  {
    nombre: 'familia-contrato-cuenta',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: expediente(),
    foco: 'h2:has-text("Lo que va sumando")'
  },
  {
    // Las versiones se mudaron a la pestaña del contrato, donde se pactan, y
    // dentro de ella al historial plegado del final.
    nombre: 'familia-contrato-versiones',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: expediente('/acuerdo'),
    async preparar(page) {
      await desplegar(page, 'El contrato, versión a versión');
    },
    foco: 'summary:has-text("El contrato, versión a versión")'
  },
  {
    nombre: 'familia-contrato-historial',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: expediente('/pagos'),
    foco: 'h2:has-text("Historial con pagos")'
  },
  {
    nombre: 'familia-vacaciones',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: expediente('/vacaciones'),
    foco: 'h2:has-text("Días disfrutados")'
  },
  {
    nombre: 'familia-vacaciones-historico',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment/vacaciones')
  },

  // ── El acuerdo (solo quien administra) ───────────────────────────────────
  // La pestaña enseña a UNA persona: sin decir cuál se retrataría a quien
  // encabece la lista, que cambia en cuanto el alta de más abajo mete a Elena.
  { nombre: 'familia-acuerdo', cuenta: 'alberto', aparato: 'escritorio', ruta: expediente('/acuerdo') },
  {
    nombre: 'familia-acuerdo-version',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: expediente('/acuerdo'),
    async preparar(page) {
      await abrirEditorDeVersion(page);
    },
    foco: 'legend:has-text("Trabajo extra")'
  },
  {
    nombre: 'familia-acuerdo-horario',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: expediente('/acuerdo'),
    async preparar(page) {
      await abrirEditorDeVersion(page);
    },
    foco: 'legend:has-text("Horario")'
  },
  {
    nombre: 'familia-acuerdo-complementos',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: expediente('/acuerdo'),
    async preparar(page) {
      await abrirEditorDeVersion(page);
    },
    foco: 'legend:has-text("Complementos")'
  },

  // ── Calendario, contactos y emergencias ──────────────────────────────────
  { nombre: 'familia-calendario', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/calendar') },
  {
    nombre: 'familia-calendario-vistas',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/calendar'),
    async preparar(page) {
      await page.getByRole('button', { name: 'Mes', exact: true }).first().click();
      await page.waitForLoadState('domcontentloaded');
      await asentar(page);
    }
  },
  {
    nombre: 'familia-calendario-alta',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/calendar'),
    async preparar(page) {
      await page.getByRole('button', { name: 'Enlazar un calendario' }).first().click();
      await page.waitForTimeout(400);
    },
    foco: 'h3:has-text("Enlazar un calendario")'
  },
  { nombre: 'familia-contactos', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/contacts') },
  { nombre: 'familia-emergencias', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/emergency') },

  // ── Ajustes y personal ───────────────────────────────────────────────────
  {
    nombre: 'familia-ajustes',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/settings'),
    async preparar(page) {
      const filas = page.locator('details summary');
      const total = Math.min(await filas.count(), 3);
      for (let i = 0; i < total; i += 1) {
        const fila = filas.nth(i);
        if (!(await fila.evaluate((node) => node.closest('details')?.open === true))) await fila.click();
      }
      await page.waitForTimeout(300);
    }
  },
  {
    nombre: 'familia-ajustes-contrasena',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/settings'),
    async preparar(page) {
      await desplegar(page, 'Ana');
      await page.getByRole('button', { name: /^Poner una contraseña nueva a/ }).first().click();
      await page.waitForTimeout(400);
    },
    foco: 'summary:has-text("Ana")'
  },
  { nombre: 'familia-personal', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/personal') },
  {
    // El alta salió de Personal —allí solo queda el enlace— y vive en su propia
    // ruta, en dos etapas: primero quién entra, después sus condiciones. La
    // captura recorre las dos y retrata la tercera pantalla, la de la entrega.
    nombre: 'familia-personal-alta',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment/alta'),
    async preparar(page, estado) {
      // Etapa 1: quién es. No escribe nada todavía.
      await page.locator('input[name="displayName"]').first().fill('Elena');
      await page.locator('input[name="username"]').first().fill('elena');
      await page.locator('input[name="email"]').first().fill('elena@casaroble.invalid');
      await page.getByRole('button', { name: 'Seguir con sus condiciones' }).first().click();
      await page.waitForLoadState('domcontentloaded');
      // Etapa 2: sus condiciones. La fecha, la jornada, los días de vacaciones
      // y el motivo vienen ya puestos; el salario es lo único que falta.
      await page.locator('input[name="monthlySalary"]').first().fill('1.400,00');
      await page.getByRole('button', { name: 'Dar de alta con su contrato' }).first().click();
      await page.waitForLoadState('domcontentloaded');
      await asentar(page);
      // La contraseña provisional se enseña UNA sola vez: se apunta aquí para
      // poder entrar con ella y retratar el bloqueo de la pantalla siguiente.
      const secreto = page.locator('.handout-secret dd');
      if ((await secreto.count()) >= 2) {
        estado.provisional = {
          usuario: (await secreto.nth(0).innerText()).trim(),
          contrasena: (await secreto.nth(1).innerText()).trim()
        };
      } else {
        console.error('  (el alta no entregó usuario y contraseña)');
      }
    },
    foco: 'h2:has-text("ya puede entrar")'
  },
  { nombre: 'familia-cuenta', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/account') },

  // ── Miembro de la familia y apoyo ────────────────────────────────────────
  // Lo que la familia no administradora ve DE VERDAD son las jornadas y los
  // gastos pendientes, que viven en Conceptos desde el rediseño en pestañas:
  // en `/employment` a secas aterriza ahora en la portada del hogar.
  { nombre: 'miembro-contrato', cuenta: 'marta', aparato: 'escritorio', ruta: hogar('/employment/conceptos') },
  { nombre: 'apoyo-sin-acceso', cuenta: 'lucia', aparato: 'escritorio', ruta: hogar('/employment') },

  // ── La interna, en el ordenador ──────────────────────────────────────────
  { nombre: 'interna-condiciones', cuenta: 'ana', aparato: 'escritorio', ruta: hogar('/employment/condiciones') },
  {
    nombre: 'interna-condiciones-extra',
    cuenta: 'ana',
    aparato: 'escritorio',
    ruta: hogar('/employment/condiciones'),
    foco: 'h2:has-text("Lo que se suma")'
  },

  // ── La interna, en el móvil ──────────────────────────────────────────────
  {
    nombre: 'interna-vacaciones-aviso-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/employment/vacaciones')
  },
  {
    nombre: 'interna-vacaciones-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/employment/vacaciones'),
    foco: 'h2:has-text("Vacaciones de"), h1'
  },
  { nombre: 'interna-hoy-movil', cuenta: 'ana', aparato: 'movil', ruta: hogar('/today') },
  {
    nombre: 'interna-hoy-detalle-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/today'),
    async preparar(page) {
      // La primera rutina del día que TIENE detalle: el resumen se pulsa y el
      // «cómo se hace» se abre sin salir de Hoy.
      const resumen = page.locator('#rutinas-de-hoy details.routine-detail > summary').first();
      await resumen.waitFor({ state: 'visible', timeout: 15_000 });
      if (!(await resumen.evaluate((node) => node.closest('details')?.open === true))) await resumen.click();
      await page.waitForTimeout(300);
    },
    foco: '#rutinas-de-hoy details.routine-detail > summary'
  },
  {
    nombre: 'interna-hoy-deshacer-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/today'),
    async preparar(page) {
      const marcar = page.getByRole('button', { name: 'Marcar hecha' }).first();
      await marcar.click();
      await page.getByRole('button', { name: 'Deshacer' }).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(400);
    },
    foco: 'button:has-text("Deshacer")'
  },
  {
    nombre: 'interna-mas-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/today'),
    async preparar(page) {
      await page.getByRole('button', { name: 'Más' }).first().click();
      await page.waitForTimeout(400);
    }
  },
  { nombre: 'interna-menu-movil', cuenta: 'ana', aparato: 'movil', ruta: hogar('/menu') },
  {
    nombre: 'interna-compra-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/menu'),
    preparar: abrirLaCompra,
    foco: { selector: 'h3:has-text("Personal"), h2:has-text("Personal")', hueco: 60 }
  },
  {
    nombre: 'interna-jornada-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/employment/conceptos'),
    foco: 'h3:has-text("Registrar jornada extra")'
  },
  {
    nombre: 'interna-gasto-foto-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/employment/conceptos'),
    foco: 'text=Hacer la foto ahora'
  },
  {
    nombre: 'interna-jornada-horario-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/employment/condiciones'),
    foco: 'h2:has-text("Tu jornada")'
  },
  { nombre: 'interna-emergencias-movil', cuenta: 'ana', aparato: 'movil', ruta: hogar('/emergency') },
  { nombre: 'interna-cuenta-movil', cuenta: 'ana', aparato: 'movil', ruta: hogar('/account') },
  {
    nombre: 'interna-avisos-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/account'),
    foco: 'h2:has-text("Tus avisos en este teléfono")'
  },
  {
    nombre: 'interna-buscar-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/search?q=lavadora'),
    async preparar(page) {
      await page.waitForTimeout(800);
    }
  },
  {
    nombre: 'interna-guia-libro-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/wiki/libro/principios-de-la-casa'),
    async preparar(page) {
      // Dos notas más adentro: así se ven los dos botones de navegación y el
      // chip «Leída», no solo la primera página del libro.
      for (let paso = 0; paso < 2; paso += 1) {
        await page.locator('a:has-text("Siguiente"), button:has-text("Siguiente")').first().click();
        await page.waitForLoadState('domcontentloaded');
        await asentar(page);
      }
    }
  },
  {
    nombre: 'interna-guia-progreso-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/wiki/progreso')
  },

  // ── Apoyo y acceso puntual, en el móvil ──────────────────────────────────
  { nombre: 'apoyo-hoy-movil', cuenta: 'lucia', aparato: 'movil', ruta: hogar('/today') },
  { nombre: 'visor-hoy-movil', cuenta: 'diego', aparato: 'movil', ruta: hogar('/today') },

  // ── La contraseña provisional de quien acaba de entrar ───────────────────
  {
    nombre: 'familia-cuenta-provisional',
    cuenta: 'provisional',
    aparato: 'movil',
    ruta: hogar('/account')
  }
];

// ── Ejecución ──────────────────────────────────────────────────────────────

if (args.includes('--list')) {
  for (const shot of CAPTURAS) console.log(shot.nombre);
  process.exit(0);
}

await mkdir(OUT, { recursive: true });

const navegador = await chromium.launch();
const contextos = new Map();
const estado = {};
const titulos = {};
const fallos = [];

/** Contexto con sesión iniciada para una cuenta y un tamaño de pantalla. */
async function contextoDe(cuenta, aparato) {
  const clave = `${cuenta ?? 'anonimo'}@${aparato}`;
  if (contextos.has(clave)) return contextos.get(clave);
  const contexto = await navegador.newContext(DEVICES[aparato]);
  // Chromium sin cabeza dice SIEMPRE que las notificaciones están denegadas, y
  // `grantPermissions` no cambia `Notification.permission`. Con eso, «Tus avisos
  // en este teléfono» sale contando una avería del navegador de pruebas en vez
  // de lo que ve un teléfono normal. Se le devuelve el valor de fábrica —«sin
  // decidir»— y la pantalla vuelve a ser la que es. No se toca nada de la
  // aplicación: solo el navegador que la retrata.
  await contexto.addInitScript(() => {
    if (typeof Notification === 'function') {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
    }
  });
  if (cuenta) {
    const credencial =
      cuenta === 'provisional'
        ? estado.provisional
        : { usuario: cuenta, contrasena: PASSWORD };
    if (!credencial) throw new Error(`no hay credencial para «${cuenta}»`);
    const page = await contexto.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-username').fill(credencial.usuario);
    await page.locator('#login-password').fill(credencial.contrasena);
    await Promise.all([page.waitForURL(/\/h\//, { timeout: 20_000 }), page.getByRole('button', { name: 'Entrar' }).click()]);
    await page.close();
  }
  contextos.set(clave, contexto);
  return contexto;
}

for (const shot of CAPTURAS) {
  if (ONLY && !ONLY.includes(shot.nombre)) continue;
  try {
    const contexto = await contextoDe(shot.cuenta, shot.aparato);
    const page = await contexto.newPage();
    await page.goto(BASE + shot.ruta, { waitUntil: 'domcontentloaded' });
    await asentar(page);
    if (shot.preparar) await shot.preparar(page, estado);
    if (shot.foco) {
      const foco = typeof shot.foco === 'string' ? { selector: shot.foco } : shot.foco;
      await encuadrar(page, foco.selector, foco.hueco);
    }
    await asentar(page);
    // Ningún foco puesto por la navegación: el anillo de foco sobre un titular
    // no es parte de la pantalla que el manual está explicando.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.waitForTimeout(150);
    titulos[shot.nombre] = await page.title();
    await page.screenshot({ path: path.join(OUT, `${shot.nombre}.png`) });
    await page.close();
    console.log(`✓ ${shot.nombre}  ·  ${titulos[shot.nombre]}`);
  } catch (cause) {
    fallos.push({ nombre: shot.nombre, error: String(cause).split('\n')[0] });
    console.error(`✗ ${shot.nombre}: ${String(cause).split('\n')[0]}`);
  }
}

await navegador.close();

// El título real de cada pestaña, para la barra de ventana falsa del manual.
const destino = path.join(OUT, 'titulos.json');
let previos = {};
try {
  previos = JSON.parse(await readFile(destino, 'utf8'));
} catch {
  previos = {};
}
await writeFile(destino, `${JSON.stringify({ ...previos, ...titulos }, null, 2)}\n`);

console.log(`\n${Object.keys(titulos).length} capturas en ${OUT}`);
if (fallos.length > 0) {
  console.log(`${fallos.length} sin hacer:`);
  for (const fallo of fallos) console.log(`  · ${fallo.nombre}: ${fallo.error}`);
  process.exitCode = 1;
}
