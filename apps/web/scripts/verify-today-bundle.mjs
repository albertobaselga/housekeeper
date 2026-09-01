// Presupuesto de arranque de la pantalla Hoy.
//
// Mide el grafo de importaciones ESTÁTICAS del nodo de página de Hoy y lo acota
// en 120 kB. Además vigila dos fugas concretas que ya han ocurrido:
//
//  1. El editor de la Guía (Milkdown) tiene que seguir detrás de un import
//     dinámico de su ruta.
//  2. La matriz de roles y capacidades NO puede volver al arranque. Son ~1,2 kB
//     de tablas que el navegador no usa —el servidor manda las capacidades de la
//     sesión ya resueltas en `AppContextV1`— y estuvieron ahí sin que nadie lo
//     notara porque compartían módulo con `canonicalJson`, que sí se carga
//     siempre (verifica la firma del paquete offline). El troceo de rolldown
//     reparte por ALCANZABILIDAD de módulo, no por binding usado: basta con que
//     algo del arranque importe un módulo para que sus tablas viajen enteras.
//     Por eso viven en `@housekeeper/contracts/capabilities`, sin reexport desde
//     `index.ts`, y por eso esto falla si reaparecen.
//
// El mapa módulo→trozo lo escribe el plugin `housekeeper:client-module-map` de
// `vite.config.ts`. Es lo que permite señalar al culpable en vez de dejar un
// número que sube sin explicación.

import { readFile, readdir, stat } from 'node:fs/promises';

const BUDGET_BYTES = 120_000;

/**
 * Módulos desterrados del arranque de Hoy, con el porqué en el propio mensaje:
 * quien lo rompa tiene que leer la razón antes de decidir qué hacer.
 */
const FORBIDDEN_IN_INITIAL_GRAPH = [
  {
    module: 'packages/contracts/src/capabilities.ts',
    why:
      'la matriz de roles y capacidades son ~1,2 kB que el cliente no usa: el servidor manda\n' +
      '    las capacidades de la sesión ya resueltas en AppContextV1. Impórtala de\n' +
      '    "@housekeeper/contracts/capabilities" allí donde de verdad haga falta y NO la reexportes\n' +
      '    desde "@housekeeper/contracts": la arista de importación basta para arrastrarla.'
  }
];

const webRoot = new URL('../', import.meta.url);
const outputDirectory = new URL('.svelte-kit/output/client/', webRoot);
const manifest = JSON.parse(await readFile(new URL('.vite/manifest.json', outputDirectory), 'utf8'));
const generatedApp = await readFile(new URL('.svelte-kit/generated/client-optimized/app.js', webRoot), 'utf8');
const routeMatch = generatedApp.match(/"\/h\/\[householdId\]\/today": \[~(\d+)(?:,\[([\d,\s]*)\])?/);

if (!routeMatch) throw new Error('Could not locate the Today route in the generated SvelteKit dictionary');

const nodeKey = (id) => `.svelte-kit/generated/client-optimized/nodes/${id}.js`;
const todayNode = nodeKey(routeMatch[1]);
// Node 0 es el layout raíz y se carga siempre; el resto los declara la ruta.
const layoutNodes = ['0', ...(routeMatch[2] ?? '').split(',').map((id) => id.trim()).filter(Boolean)];
const editorModule = 'src/lib/components/wiki/WikiEditor.svelte';

function walkInitialImports(key, visited = new Set()) {
  if (visited.has(key)) return visited;
  visited.add(key);
  const entry = manifest[key];
  if (!entry) throw new Error(`Missing Vite manifest entry: ${key}`);
  for (const dependency of entry.imports ?? []) walkInitialImports(dependency, visited);
  return visited;
}

const visited = walkInitialImports(todayNode);
if (visited.has(editorModule)) throw new Error('WikiEditor leaked into the Today initial bundle');

const wikiEntry = Object.entries(manifest).find(([, value]) =>
  value.dynamicImports?.includes(editorModule)
);
if (!wikiEntry) throw new Error('WikiEditor is not isolated behind the wiki route dynamic import');

async function totalBytes(keys) {
  let bytes = 0;
  for (const key of keys) bytes += (await stat(new URL(manifest[key].file, outputDirectory))).size;
  return bytes;
}

const initialBytes = await totalBytes(visited);

// Mapa módulo→trozo del plugin de vite.config.ts. Si falta (construcción vieja o
// parcial) el presupuesto sigue midiéndose; solo se pierde el diagnóstico.
let moduleMap = null;
try {
  moduleMap = JSON.parse(await readFile(new URL('.svelte-kit/housekeeper-module-map.json', webRoot), 'utf8'));
} catch {
  console.warn('Aviso: falta housekeeper-module-map.json; sin atribución por módulo en este informe.');
}

/** Módulos fuente presentes en un conjunto de trozos, con sus bytes sin minificar. */
function modulesOf(keys) {
  const modules = new Map();
  if (!moduleMap) return modules;
  for (const key of keys) {
    for (const [id, bytes] of Object.entries(moduleMap[manifest[key].file] ?? {})) {
      modules.set(id, (modules.get(id) ?? 0) + bytes);
    }
  }
  return modules;
}

const initialModules = modulesOf(visited);
const normalize = (id) => id.replace(/^(?:\.\.\/)+/, '').replaceAll('\\', '/');

for (const rule of FORBIDDEN_IN_INITIAL_GRAPH) {
  const hit = [...initialModules.keys()].find((id) => normalize(id) === rule.module);
  if (!hit) continue;
  throw new Error(
    `${rule.module} volvió al arranque de Hoy (${initialModules.get(hit)} bytes sin minificar):\n    ${rule.why}`
  );
}

if (initialBytes > BUDGET_BYTES) {
  const worst = [...initialModules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const detail = worst.map(([id, bytes]) => `\n    ${String(bytes).padStart(7)}  ${normalize(id)}`).join('');
  throw new Error(
    `Today initial JavaScript grew beyond ${BUDGET_BYTES / 1000} kB (${initialBytes} bytes).` +
      `\n  Módulos más pesados del grafo inicial (bytes sin minificar):${detail}`
  );
}

async function listJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) paths.push(...await listJavaScript(path));
    else if (entry.name.endsWith('.js')) paths.push(path);
  }
  return paths;
}

for (const path of await listJavaScript(new URL('_app/immutable/', outputDirectory))) {
  const source = await readFile(path, 'utf8');
  if (source.includes('Centro Pediátrico Olmo')) {
    throw new Error('Server-only fixture corpus leaked into a client JavaScript chunk');
  }
}

// Lo que el navegador descarga DE VERDAD al abrir Hoy: el arranque del cliente
// más los layouts de la ruta, no solo el nodo de página. No es la puerta —el
// presupuesto histórico se mide sobre el nodo de página— pero se informa porque
// es donde se escondió la matriz de capacidades: la cabecera del hogar vive en
// el layout, y lo que engorda ahí no lo veía nadie.
const fullRoute = new Set();
for (const key of ['.svelte-kit/generated/client-optimized/app.js', ...layoutNodes.map(nodeKey), todayNode]) {
  walkInitialImports(key, fullRoute);
}
const fullRouteBytes = await totalBytes(fullRoute);

console.log(
  `Today initial graph: ${visited.size} files, ${initialBytes} bytes ` +
    `(${BUDGET_BYTES - initialBytes} de margen sobre ${BUDGET_BYTES}); WikiEditor remains route-lazy.`
);
console.log(
  `Carga real de la ruta (arranque + layouts ${layoutNodes.join(', ')} + página): ` +
    `${fullRoute.size} files, ${fullRouteBytes} bytes.`
);
