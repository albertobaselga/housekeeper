#!/usr/bin/env node
/**
 * Comprueba sobre la SALIDA DE LA BUILD que `__FIXTURE_LOGIN__` hizo lo que
 * promete, en los dos sentidos.
 *
 * - Con la constante en `false`: ninguna marca del camino de cuentas sintéticas
 *   puede aparecer en el servidor construido. Si aparece, la build falla; es
 *   preferible una build rota a un despliegue que sirva cuentas de mentira
 *   sobre la casa real.
 * - Con la constante en `true`: las marcas TIENEN que aparecer. Sin esta mitad
 *   el guion sería inútil: pasaría igual de verde si estuviera mirando un
 *   directorio equivocado, si Vite cambiara la ruta de salida, o si alguien
 *   renombrara la cookie. Aquí la comprobación se comprueba a sí misma.
 *
 * Se mira `.svelte-kit/output/server`, que es la salida de SvelteKit ANTES del
 * adaptador: lo que no está ahí no puede estar ni en `build/` (adapter-node) ni
 * en `.vercel/output` (adapter-vercel). Si además existe la salida del
 * adaptador, se mira también, porque es el artefacto que se sube.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { FIXTURE_LOGIN_MARKERS, resolveFixtureLogin } from '../src/lib/server/fixture-login-flag.js';

const WEB_ROOT = new URL('../', import.meta.url);
const SEARCH_ROOTS = ['.svelte-kit/output/server/', 'build/server/', '.vercel/output/functions/'];

/** @param {URL} directory @returns {Promise<URL[]>} */
async function listJavaScript(directory) {
  /** @type {URL[]} */
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) found.push(...(await listJavaScript(child)));
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) found.push(child);
  }
  return found;
}

/** @param {URL} root */
async function existsDirectory(root) {
  try {
    return (await stat(root)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Quita comentarios antes de buscar. Sin esto la comprobación da un FALSO
 * POSITIVO que tumba cualquier despliegue de producción: la salida de servidor
 * de SvelteKit no va minificada y conserva los comentarios del código fuente,
 * así que el propio párrafo que explica por qué `listDemoUsers` y `getDemoUser`
 * no deben estar en el paquete contiene sus nombres. Rollup sí las había
 * borrado; lo que quedaba era la prosa que hablaba de ellas.
 *
 * Basta con un barrido textual: aquí solo se busca la presencia de un nombre,
 * y romper una cadena que contenga `//` no puede crear una coincidencia nueva.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

async function main() {
  // El guion corre después de `vite build`, así que el comando es 'build'.
  const expected = resolveFixtureLogin(env, 'build');


  /** @type {{ root: string; hits: Map<string, string[]> }[]} */
  const scanned = [];

  // Qué salidas mirar. La de SvelteKit la produce SIEMPRE esta build; de las dos
  // de adaptador solo existe la que corresponde al objetivo de ESTA build, y la
  // otra puede ser de una anterior con banderas distintas (construir para node
  // deja intacto el `.vercel/output` de antes). Mirar la vieja produce un fallo
  // que no habla de este código, así que se elige por objetivo, no por fecha.
  const adapterRoot = (env.DEPLOY_TARGET ?? 'node') === 'vercel' ? '.vercel/output/functions/' : 'build/server/';
  const roots = [SEARCH_ROOTS[0], adapterRoot];

  for (const relative of roots) {
    const root = new URL(relative, WEB_ROOT);
    if (!(await existsDirectory(root))) continue;
    const files = await listJavaScript(root);
    /** @type {Map<string, string[]>} */
    const hits = new Map();
    for (const file of files) {
      const source = stripComments(await readFile(file, 'utf8'));
      for (const marker of FIXTURE_LOGIN_MARKERS) {
        if (!source.includes(marker.text)) continue;
        const list = hits.get(marker.text) ?? [];
        list.push(fileURLToPath(file));
        hits.set(marker.text, list);
      }
    }
    scanned.push({ root: relative, hits });
  }

  if (scanned.length === 0) {
    throw new Error(
      `No se encontró ninguna salida de build en ${SEARCH_ROOTS.join(', ')}; ejecuta este guion después de \`vite build\``
    );
  }

  /** @type {string[]} */
  const problems = [];
  for (const { root, hits } of scanned) {
    if (expected) {
      const missing = FIXTURE_LOGIN_MARKERS.filter((marker) => !hits.has(marker.text));
      if (missing.length > 0) {
        problems.push(
          `${root}: se construyó con CASA_CLARA_FIXTURE_LOGIN=true pero faltan las marcas ` +
            `${missing.map((marker) => marker.text).join(', ')}. O el selector ya no está donde se cree, ` +
            'o esta comprobación mira donde no debe.'
        );
      }
    } else {
      for (const marker of FIXTURE_LOGIN_MARKERS) {
        const files = hits.get(marker.text);
        if (!files) continue;
        problems.push(
          `${root}: «${marker.text}» (${marker.proves}) sigue en el paquete de producción, ` +
            `en ${files.length} fichero(s): ${files.slice(0, 3).join(', ')}`
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      ['El camino de cuentas sintéticas no quedó como manda __FIXTURE_LOGIN__:', ...problems.map((p) => `  - ${p}`)].join(
        '\n'
      )
    );
  }

  const where = scanned.map(({ root }) => root).join(', ');
  console.log(
    expected
      ? `__FIXTURE_LOGIN__=true: el selector de cuentas sintéticas está presente en ${where}, como se pidió.`
      : `__FIXTURE_LOGIN__=false: ninguna marca del selector de cuentas sintéticas sobrevive en ${where}.`
  );
}

// Importable desde las pruebas sin ejecutarse.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((cause) => {
    console.error(String(cause instanceof Error ? cause.message : cause));
    exit(1);
  });
}
