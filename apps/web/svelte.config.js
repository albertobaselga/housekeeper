import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
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
