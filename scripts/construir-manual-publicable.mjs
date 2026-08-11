#!/usr/bin/env node
/**
 * Convierte `docs/manual/index.html` en una página autónoma publicable.
 *
 * El manual del repositorio es un documento HTML normal: tiene su `<!doctype>`,
 * su `<head>` y referencias a las capturas como ficheros vecinos
 * (`capturas/familia-hoy.png`). Así se abre bien con doble clic, que es como lo
 * mira quien trabaja en el repositorio, y así deben quedarse las cosas.
 *
 * Publicado como página web es otra cosa: **no hay directorio de al lado**. Una
 * página autónoma no puede pedir ficheros a ningún sitio, así que cada captura
 * tiene que viajar dentro del propio HTML, en base64. Y el esqueleto sobra,
 * porque el publicador pone el suyo.
 *
 * Este guion hace justo esas dos cosas y nada más. No reescribe el manual: si
 * algo hay que arreglar, se arregla en `docs/manual/index.html` y se vuelve a
 * ejecutar esto.
 *
 *   node scripts/construir-manual-publicable.mjs [destino.html]
 *
 * Falla —en vez de publicar un manual con huecos— si alguna captura citada no
 * existe, o si el resultado se pasa del tope de 16 MB de una página publicada.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origen = join(raiz, 'docs/manual/index.html');
const destino = process.argv[2] ?? join(raiz, 'docs/manual/manual-publicable.html');
const TOPE_BYTES = 16 * 1024 * 1024;

const html = readFileSync(origen, 'utf8');

/** El `<title>` manda en la pestaña y en la galería: se conserva tal cual. */
const titulo = (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? 'Manual';

// El cuerpo publicable es todo lo que va dentro de <body>, más el <style> del
// <head>: el publicador envuelve esto en su propio esqueleto, así que un
// segundo <html> anidado sería basura que el navegador tiene que perdonar.
const estilos = [...html.matchAll(/<style[\s\S]*?<\/style>/g)].join('\n');
const cuerpo = (html.match(/<body[^>]*>([\s\S]*)<\/body>/) ?? [])[1];
if (!cuerpo) throw new Error('no encuentro el <body> del manual');

// Cada captura, dentro del HTML. Se resuelve una sola vez por fichero: hay
// imágenes citadas dos veces y duplicar 90 KB en base64 por gusto es tirar el
// presupuesto de tamaño.
const cache = new Map();
const ausentes = [];
let incrustadas = 0;

const conImagenes = cuerpo.replace(/src="(capturas\/[^"]+)"/g, (todo, ruta) => {
  if (!cache.has(ruta)) {
    const fichero = join(raiz, 'docs/manual', ruta);
    try {
      statSync(fichero);
    } catch {
      ausentes.push(ruta);
      cache.set(ruta, null);
      return todo;
    }
    const tipo = ruta.endsWith('.png') ? 'image/png' : 'image/jpeg';
    cache.set(ruta, `data:${tipo};base64,${readFileSync(fichero).toString('base64')}`);
    incrustadas += 1;
  }
  const dato = cache.get(ruta);
  return dato ? `src="${dato}"` : todo;
});

if (ausentes.length) {
  console.error(`Faltan ${ausentes.length} capturas citadas por el manual:`);
  for (const f of ausentes) console.error(`  · ${f}`);
  console.error('\nNo publico un manual con imágenes rotas.');
  process.exit(1);
}

const salida = `<title>${titulo}</title>\n${estilos}\n${conImagenes}`;
writeFileSync(destino, salida, 'utf8');

const bytes = Buffer.byteLength(salida);
const mb = (bytes / 1048576).toFixed(2);
console.log(`${destino}`);
console.log(`  título: ${titulo}`);
console.log(`  capturas incrustadas: ${incrustadas}`);
console.log(`  tamaño: ${mb} MB de los 16 MB que admite una página publicada`);

if (bytes > TOPE_BYTES) {
  console.error(`\nSe pasa del tope por ${((bytes - TOPE_BYTES) / 1048576).toFixed(2)} MB.`);
  process.exit(1);
}
