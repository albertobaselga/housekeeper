import nodeAdapter from '@sveltejs/adapter-node';
import vercelAdapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Objetivo de despliegue, elegido por variable de entorno en tiempo de BUILD.
 *
 *   DEPLOY_TARGET=node      → @sveltejs/adapter-node
 *   DEPLOY_TARGET=vercel    → @sveltejs/adapter-vercel
 *   (sin DEPLOY_TARGET)     → `vercel` si la build corre en Vercel, si no `node`
 *
 * Fuera de Vercel el valor por omisión es `node` a propósito: la demo local,
 * las imágenes de `infra/docker`, los Compose autogestionados y las suites e2e
 * viven de `node build`, y ninguna de esas rutas debe cambiar porque exista un
 * segundo objetivo.
 *
 * Dentro de Vercel el defecto se invierte solo. Vercel exporta `VERCEL=1` en
 * toda build suya, así que la plataforma se reconoce a sí misma sin que haya
 * que acordarse de declarar nada en el panel. Olvidarlo construía con
 * adapter-node, que deja el resultado en `build/` y no en `.vercel/output`, y
 * el despliegue moría con «No Output Directory named "public" found» después
 * de una build en verde: un fallo tardío y con un mensaje que no menciona al
 * adaptador. `DEPLOY_TARGET` explícito sigue mandando sobre la detección, de
 * modo que `DEPLOY_TARGET=node` permite construir el servidor autónomo también
 * desde Vercel.
 *
 * Región: el ADR 0001 exige residencia en la UE. `regions` se fija aquí y no
 * en el panel para que el requisito viaje con el código; VERCEL_REGION permite
 * cambiar de `fra1` a `cdg1` sin tocar el fichero.
 */
const runningOnVercel = (process.env.VERCEL ?? '').trim() !== '';
const declaredTarget = (process.env.DEPLOY_TARGET ?? '').trim();
const target = (declaredTarget || (runningOnVercel ? 'vercel' : 'node')).toLowerCase();
const region = (process.env.VERCEL_DEPLOY_REGION ?? 'fra1').trim();
const runtime = (process.env.VERCEL_NODE_RUNTIME ?? 'nodejs24.x').trim();
// La subida de adjuntos escanea con ClamAV con un tope de 30 s
// (attachment-deps.server.ts). El plan Hobby corta a 60 s y el Pro admite más;
// se deja configurable para no fijar aquí un límite que el plan rechace.
const maxDuration = Number.parseInt(process.env.VERCEL_MAX_DURATION ?? '60', 10);

function selectAdapter() {
  switch (target) {
    case 'node':
      return nodeAdapter();
    case 'vercel':
      return vercelAdapter({
        // Node, no edge: el servidor usa `pg`, `node:crypto`, `node:net`
        // (ClamAV INSTREAM) y el SDK de S3. Ninguno corre en el runtime edge.
        runtime,
        regions: [region],
        maxDuration,
        // Sin ISR ni división por ruta: una sola función para todo el servidor
        // (8,3 MB de bundle frente a los 250 MB del límite) evita multiplicar
        // arranques en frío y pools de Postgres por ruta.
        split: false
      });
    default:
      throw new Error(
        `DEPLOY_TARGET="${declaredTarget}" no es un objetivo conocido; usa "node" o "vercel"`
      );
  }
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: selectAdapter(),
    alias: {
      $lib: './src/lib'
    },
    csp: {
      // Nonces automáticos para los scripts inline de SvelteKit; todo lo demás
      // queda restringido al propio origen. 'unsafe-inline' en estilos es
      // necesario para los estilos que Svelte inyecta en transiciones.
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:'],
        'font-src': ['self'],
        'connect-src': ['self'],
        'object-src': ['none'],
        'base-uri': ['self'],
        'form-action': ['self'],
        'frame-ancestors': ['none'],
        'worker-src': ['self'],
        'manifest-src': ['self']
      }
    }
  }
};

export default config;
