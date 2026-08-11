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
//   # 5. Las capturas
//   node apps/web/scripts/manual-shots.mjs --base http://127.0.0.1:4363
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

// ── Utilidades de puesta en escena ─────────────────────────────────────────

/** Deja `elemento` arriba del viewport, con un respiro de 20 px. */
async function encuadrar(page, selector, hueco = 20) {
  const target = typeof selector === 'string' ? page.locator(selector).first() : selector;
  await target.waitFor({ state: 'visible', timeout: 15_000 });
  await target.evaluate((node, gap) => {
    const y = node.getBoundingClientRect().top + window.scrollY - gap;
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
      const marcar = page.getByRole('button', { name: 'Marcar hecha' }).first();
      if (await marcar.count()) {
        await marcar.click();
        await page.getByText('Deshacer').first().waitFor({ timeout: 15_000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await asentar(page);
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
    ruta: hogar('/menu?vista=compra')
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
  { nombre: 'familia-contrato', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/employment') },
  {
    nombre: 'familia-contrato-empleadas',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment'),
    foco: 'text=Elegir de quién es el expediente'
  },
  {
    nombre: 'familia-contrato-cuenta',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment'),
    foco: 'h2:has-text("Lo que va sumando")'
  },
  {
    nombre: 'familia-contrato-versiones',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment'),
    foco: 'h2:has-text("Versiones y cambios de salario")'
  },
  {
    nombre: 'familia-contrato-historial',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment'),
    foco: 'h2:has-text("Historial con pagos")'
  },
  {
    nombre: 'familia-vacaciones',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment'),
    foco: 'h2:has-text("Días disfrutados")'
  },
  {
    nombre: 'familia-vacaciones-historico',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment/vacaciones')
  },

  // ── El acuerdo (solo quien administra) ───────────────────────────────────
  { nombre: 'familia-acuerdo', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/employment/acuerdo') },
  {
    nombre: 'familia-acuerdo-version',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment/acuerdo'),
    async preparar(page) {
      await desplegar(page, 'Cambiar las condiciones');
    },
    foco: 'h3:has-text("Trabajo extra"), h2:has-text("Trabajo extra")'
  },
  {
    nombre: 'familia-acuerdo-horario',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment/acuerdo'),
    async preparar(page) {
      await desplegar(page, 'Cambiar las condiciones');
    },
    foco: 'h3:has-text("Horario"), h2:has-text("Horario")'
  },
  {
    nombre: 'familia-acuerdo-complementos',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/employment/acuerdo'),
    async preparar(page) {
      await desplegar(page, 'Cambiar las condiciones');
    },
    foco: 'h3:has-text("Complementos"), h2:has-text("Complementos")'
  },

  // ── Calendario, contactos y emergencias ──────────────────────────────────
  { nombre: 'familia-calendario', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/calendar') },
  {
    nombre: 'familia-calendario-vistas',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/calendar'),
    async preparar(page) {
      await page.getByRole('link', { name: 'Mes', exact: true }).first().click();
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
      await desplegar(page, 'Enlazar un calendario');
    },
    foco: 'summary:has-text("Enlazar un calendario")'
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
      await desplegar(page, /Repon|contraseñ/i.source);
    }
  },
  { nombre: 'familia-personal', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/personal') },
  {
    nombre: 'familia-personal-alta',
    cuenta: 'alberto',
    aparato: 'escritorio',
    ruta: hogar('/personal'),
    async preparar(page, estado) {
      await desplegar(page, 'Entra alguien nuevo en la casa');
      await page.locator('input[name="displayName"]').first().fill('Elena');
      await page.locator('input[name="username"]').first().fill('elena');
      await page.locator('input[name="email"]').first().fill('elena@casaroble.invalid');
      await page.getByRole('button', { name: /Dar de alta|Crear/i }).first().click();
      await page.waitForLoadState('domcontentloaded');
      await asentar(page);
      // La contraseña provisional se enseña UNA vez: se apunta aquí para poder
      // entrar con ella y retratar el bloqueo de la pantalla siguiente.
      const texto = await page.locator('body').innerText();
      const credencial = /Contraseña provisional\s*\n?\s*([A-Za-z0-9-]{8,})/.exec(texto);
      if (credencial) estado.provisional = { usuario: 'elena', contrasena: credencial[1] };
    },
    foco: 'text=/provisional/i'
  },
  { nombre: 'familia-cuenta', cuenta: 'alberto', aparato: 'escritorio', ruta: hogar('/account') },

  // ── Miembro de la familia y apoyo ────────────────────────────────────────
  { nombre: 'miembro-contrato', cuenta: 'marta', aparato: 'escritorio', ruta: hogar('/employment') },
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
      await desplegar(page, 'Repaso del filtro del agua');
    },
    foco: 'summary:has-text("Repaso del filtro del agua")'
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
  { nombre: 'interna-compra-movil', cuenta: 'ana', aparato: 'movil', ruta: hogar('/menu?vista=compra') },
  {
    nombre: 'interna-jornada-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/employment'),
    foco: 'h2:has-text("Apuntar una jornada"), h3:has-text("Apuntar una jornada")'
  },
  {
    nombre: 'interna-gasto-foto-movil',
    cuenta: 'ana',
    aparato: 'movil',
    ruta: hogar('/employment'),
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
    ruta: hogar('/wiki/libro/principios-de-la-casa')
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
    if (shot.foco) await encuadrar(page, shot.foco);
    await asentar(page);
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
