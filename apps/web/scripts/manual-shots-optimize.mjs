// ───────────────────────────────────────────────────────────────────────────
// Adelgaza los PNG de las capturas del manual.
//
// El manual es una página que se publica y se descarga entera: 65 capturas a 2×
// tal y como las escribe Chromium pesan más de 12 MB. Chromium comprime rápido,
// no pequeño, y una captura de interfaz es el caso fácil: fondos planos, texto y
// ninguna fotografía.
//
// Cuatro pasos:
//   1. Se tira el canal alfa si la imagen es opaca de arriba abajo (lo es
//      siempre: es la foto de una pantalla). Un 25 % del dato en crudo.
//   2. Se censan los colores. Si caben en 256, paleta directa y exacta.
//   3. Si no caben —y no caben: el suavizado de las letras deja varios miles de
//      tonos—, se reducen a 256 por corte de la mediana. Éste es el ÚNICO paso
//      con pérdida, y va con freno: si el error medio por canal pasa de 1,5
//      sobre 255 la imagen se guarda sin tocar sus colores. En la práctica sale
//      entre 0,2 y 0,4 —la diferencia entre dos grises contiguos del borde de
//      una letra— y el fichero cae a la mitad o menos.
//   4. Se vuelve a filtrar cada línea con el candidato de menor entropía y se
//      comprime con zlib al 9.
//
// Uso:
//   node apps/web/scripts/manual-shots-optimize.mjs [dir]
// ───────────────────────────────────────────────────────────────────────────

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const DIR = path.resolve(process.argv[2] ?? path.join(repoRoot, 'docs', 'manual', 'capturas'));

const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function trocear(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const cuerpo = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([length, cuerpo, crc]);
}

/** Deshace los filtros por línea y devuelve los píxeles en crudo. */
function desfiltrar(datos, ancho, alto, canales) {
  const paso = ancho * canales;
  const salida = Buffer.alloc(paso * alto);
  let origen = 0;
  for (let y = 0; y < alto; y += 1) {
    const filtro = datos[origen];
    origen += 1;
    const linea = salida.subarray(y * paso, (y + 1) * paso);
    const anterior = y > 0 ? salida.subarray((y - 1) * paso, y * paso) : null;
    for (let x = 0; x < paso; x += 1) {
      const bruto = datos[origen + x];
      const a = x >= canales ? linea[x - canales] : 0;
      const b = anterior ? anterior[x] : 0;
      const c = anterior && x >= canales ? anterior[x - canales] : 0;
      let valor;
      switch (filtro) {
        case 0: valor = bruto; break;
        case 1: valor = bruto + a; break;
        case 2: valor = bruto + b; break;
        case 3: valor = bruto + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          valor = bruto + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`filtro PNG desconocido: ${filtro}`);
      }
      linea[x] = valor & 0xff;
    }
    origen += paso;
  }
  return salida;
}

/** Filtra cada línea con el candidato de menor suma de valores absolutos. */
function filtrar(pixeles, ancho, alto, canales) {
  const paso = ancho * canales;
  const salida = Buffer.alloc((paso + 1) * alto);
  const intento = Buffer.alloc(paso);
  for (let y = 0; y < alto; y += 1) {
    const linea = pixeles.subarray(y * paso, (y + 1) * paso);
    const anterior = y > 0 ? pixeles.subarray((y - 1) * paso, y * paso) : null;
    let mejorFiltro = 0;
    let mejorCoste = Infinity;
    let mejorLinea = null;
    for (let filtro = 0; filtro <= 4; filtro += 1) {
      let coste = 0;
      for (let x = 0; x < paso; x += 1) {
        const a = x >= canales ? linea[x - canales] : 0;
        const b = anterior ? anterior[x] : 0;
        const c = anterior && x >= canales ? anterior[x - canales] : 0;
        let valor;
        switch (filtro) {
          case 0: valor = linea[x]; break;
          case 1: valor = linea[x] - a; break;
          case 2: valor = linea[x] - b; break;
          case 3: valor = linea[x] - ((a + b) >> 1); break;
          default: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            valor = linea[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          }
        }
        intento[x] = valor & 0xff;
        coste += intento[x] < 128 ? intento[x] : 256 - intento[x];
      }
      if (coste < mejorCoste) {
        mejorCoste = coste;
        mejorFiltro = filtro;
        mejorLinea = Buffer.from(intento);
      }
    }
    salida[y * (paso + 1)] = mejorFiltro;
    mejorLinea.copy(salida, y * (paso + 1) + 1);
  }
  return salida;
}

function comprimir(datos) {
  return zlib.deflateSync(datos, { level: 9, memLevel: 9, windowBits: 15, strategy: zlib.constants.Z_DEFAULT_STRATEGY });
}

/**
 * Corte por la mediana a 256 colores.
 *
 * Es la única parte que NO es exacta, y solo entra cuando la imagen no cabe en
 * paleta por sí sola. Lo que sobra en una captura de interfaz son los tonos
 * intermedios del suavizado de las letras: cientos de grises que se diferencian
 * en un punto. Se aceptan solo si el error medio por canal queda por debajo de
 * un umbral severo (1,5 sobre 255, y en la práctica sale 0,2-0,4) y ningún tono
 * se desvía tanto como para cambiar de color;
 * si no, se devuelve null y la imagen se guarda sin pérdida ninguna.
 */
function reducirPaleta(censo) {
  const colores = [...censo.entries()].map(([clave, peso]) => ({
    r: (clave >> 16) & 0xff,
    g: (clave >> 8) & 0xff,
    b: clave & 0xff,
    clave,
    peso
  }));

  let cajas = [colores];
  while (cajas.length < 256) {
    // Se parte siempre la caja con más volumen de color × población.
    let indiceMayor = -1;
    let mayor = 0;
    const rangos = [];
    cajas.forEach((caja, i) => {
      if (caja.length < 2) { rangos.push(null); return; }
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, peso = 0;
      for (const c of caja) {
        if (c.r < rmin) rmin = c.r; if (c.r > rmax) rmax = c.r;
        if (c.g < gmin) gmin = c.g; if (c.g > gmax) gmax = c.g;
        if (c.b < bmin) bmin = c.b; if (c.b > bmax) bmax = c.b;
        peso += c.peso;
      }
      const rango = { r: rmax - rmin, g: gmax - gmin, b: bmax - bmin };
      rangos.push(rango);
      const puntuacion = Math.max(rango.r, rango.g, rango.b) * Math.log2(peso + 1);
      if (puntuacion > mayor) { mayor = puntuacion; indiceMayor = i; }
    });
    if (indiceMayor < 0) break;
    const caja = cajas[indiceMayor];
    const rango = rangos[indiceMayor];
    const eje = rango.r >= rango.g && rango.r >= rango.b ? 'r' : rango.g >= rango.b ? 'g' : 'b';
    caja.sort((a, b) => a[eje] - b[eje]);
    const mitad = Math.max(1, Math.min(caja.length - 1, Math.floor(caja.length / 2)));
    cajas = [...cajas.slice(0, indiceMayor), caja.slice(0, mitad), caja.slice(mitad), ...cajas.slice(indiceMayor + 1)];
  }

  const paleta = [];
  const mapa = new Map();
  let errorTotal = 0;
  let errorMaximo = 0;
  let pixeles = 0;
  for (const caja of cajas) {
    let r = 0, g = 0, b = 0, peso = 0;
    for (const c of caja) { r += c.r * c.peso; g += c.g * c.peso; b += c.b * c.peso; peso += c.peso; }
    const medio = { r: Math.round(r / peso), g: Math.round(g / peso), b: Math.round(b / peso) };
    const indice = paleta.length;
    paleta.push((medio.r << 16) | (medio.g << 8) | medio.b);
    for (const c of caja) {
      mapa.set(c.clave, indice);
      const error = Math.max(Math.abs(c.r - medio.r), Math.abs(c.g - medio.g), Math.abs(c.b - medio.b));
      errorTotal += error * c.peso;
      if (error > errorMaximo) errorMaximo = error;
      pixeles += c.peso;
    }
  }
  const errorMedio = errorTotal / pixeles;
  if (errorMedio > 1.5 || errorMaximo > 48) return null;
  return { paleta, mapa, errorMedio, errorMaximo };
}

function optimizar(buffer) {
  if (!buffer.subarray(0, 8).equals(FIRMA)) return null;
  const chunks = trocear(buffer);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const ancho = ihdr.data.readUInt32BE(0);
  const alto = ihdr.data.readUInt32BE(4);
  const profundidad = ihdr.data[8];
  const tipo = ihdr.data[9];
  const entrelazado = ihdr.data[12];
  // Solo el caso que escribe Chromium: 8 bits, RGB o RGBA, sin entrelazar.
  if (profundidad !== 8 || entrelazado !== 0 || (tipo !== 2 && tipo !== 6)) return null;

  const canales = tipo === 6 ? 4 : 3;
  const bruto = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const pixeles = desfiltrar(bruto, ancho, alto, canales);

  // ¿Hay alfa de verdad? En una foto de pantalla, nunca.
  let opaca = true;
  if (canales === 4) {
    for (let i = 3; i < pixeles.length; i += 4) {
      if (pixeles[i] !== 255) { opaca = false; break; }
    }
  }
  if (!opaca) return null;

  const total = ancho * alto;
  const rgb = canales === 3 ? pixeles : Buffer.alloc(total * 3);
  if (canales === 4) {
    for (let i = 0, j = 0; i < total; i += 1, j += 3) {
      rgb[j] = pixeles[i * 4];
      rgb[j + 1] = pixeles[i * 4 + 1];
      rgb[j + 2] = pixeles[i * 4 + 2];
    }
  }

  // Censo de colores. Una pantalla de esta aplicación tiene fondos planos y
  // texto suavizado: unos miles de tonos, casi todos bordes de letra.
  const censo = new Map();
  for (let i = 0; i < total; i += 1) {
    const clave = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    censo.set(clave, (censo.get(clave) ?? 0) + 1);
  }

  let paleta = null;
  let mapa = null;
  if (censo.size <= 256) {
    paleta = [...censo.keys()];
    mapa = new Map(paleta.map((color, i) => [color, i]));
  } else {
    const reduccion = reducirPaleta(censo);
    if (reduccion) ({ paleta, mapa } = reduccion);
  }

  const cabe = paleta !== null;
  const indices = cabe ? Buffer.alloc(total) : null;
  if (cabe) {
    for (let i = 0; i < total; i += 1) {
      indices[i] = mapa.get((rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]);
    }
  }

  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera[8] = 8;
  cabecera[10] = 0;
  cabecera[11] = 0;
  cabecera[12] = 0;

  let piezas;
  if (cabe) {
    cabecera[9] = 3;
    const plte = Buffer.alloc(paleta.length * 3);
    paleta.forEach((color, i) => {
      plte[i * 3] = (color >> 16) & 0xff;
      plte[i * 3 + 1] = (color >> 8) & 0xff;
      plte[i * 3 + 2] = color & 0xff;
    });
    piezas = [
      chunk('IHDR', cabecera),
      chunk('PLTE', plte),
      chunk('IDAT', comprimir(filtrar(indices, ancho, alto, 1)))
    ];
  } else {
    cabecera[9] = 2;
    piezas = [chunk('IHDR', cabecera), chunk('IDAT', comprimir(filtrar(rgb, ancho, alto, 3)))];
  }
  return Buffer.concat([FIRMA, ...piezas, chunk('IEND', Buffer.alloc(0))]);
}

const ficheros = (await readdir(DIR)).filter((n) => n.endsWith('.png')).sort();
let antes = 0;
let despues = 0;
for (const nombre of ficheros) {
  const ruta = path.join(DIR, nombre);
  const original = await readFile(ruta);
  antes += original.length;
  const nuevo = optimizar(original);
  if (!nuevo || nuevo.length >= original.length) {
    despues += original.length;
    console.log(`= ${nombre} (${Math.round(original.length / 1024)} kB, sin cambio)`);
    continue;
  }
  await writeFile(ruta, nuevo);
  despues += nuevo.length;
  console.log(
    `↓ ${nombre}: ${Math.round(original.length / 1024)} kB → ${Math.round(nuevo.length / 1024)} kB` +
      ` (−${Math.round((1 - nuevo.length / original.length) * 100)} %)`
  );
}
console.log(
  `\n${ficheros.length} capturas · ${(antes / 1048576).toFixed(2)} MB → ${(despues / 1048576).toFixed(2)} MB`
);
