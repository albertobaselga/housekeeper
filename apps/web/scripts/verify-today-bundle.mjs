import { readFile, readdir, stat } from 'node:fs/promises';

const outputDirectory = new URL('../.svelte-kit/output/client/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('.vite/manifest.json', outputDirectory), 'utf8'));
const generatedApp = await readFile(new URL('../.svelte-kit/generated/client-optimized/app.js', import.meta.url), 'utf8');
const routeMatch = generatedApp.match(/"\/h\/\[householdId\]\/today": \[~(\d+)/);

if (!routeMatch) throw new Error('Could not locate the Today route in the generated SvelteKit dictionary');

const todayNode = `.svelte-kit/generated/client-optimized/nodes/${routeMatch[1]}.js`;
const editorModule = 'src/lib/components/wiki/WikiEditor.svelte';
const visited = new Set();

function walkInitialImports(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const entry = manifest[key];
  if (!entry) throw new Error(`Missing Vite manifest entry: ${key}`);
  for (const dependency of entry.imports ?? []) walkInitialImports(dependency);
}

walkInitialImports(todayNode);
if (visited.has(editorModule)) throw new Error('WikiEditor leaked into the Today initial bundle');

const wikiEntry = Object.entries(manifest).find(([, value]) =>
  value.dynamicImports?.includes(editorModule)
);
if (!wikiEntry) throw new Error('WikiEditor is not isolated behind the wiki route dynamic import');

let initialBytes = 0;
for (const key of visited) {
  initialBytes += (await stat(new URL(manifest[key].file, outputDirectory))).size;
}
if (initialBytes > 120_000) {
  throw new Error(`Today initial JavaScript grew beyond 120 kB (${initialBytes} bytes)`);
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

console.log(`Today initial graph: ${visited.size} files, ${initialBytes} bytes; WikiEditor remains route-lazy.`);
