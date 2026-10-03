import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PrepareAttachmentError,
  UPLOAD_TARGET_BYTES,
  prepareAttachment
} from '../src/lib/attachments/prepare';

/**
 * La preparación de la foto EN EL DISPOSITIVO, sin navegador: el lienzo y la
 * descodificación se sustituyen por dobles que apuntan qué se pidió. Lo que
 * importa aquí no es el JPEG (eso es cosa del navegador) sino las decisiones:
 * cuándo se reencoda, con qué calidad, a qué tamaño y qué pasa si no se puede.
 *
 * Todas las «fotos» son bytes sintéticos generados aquí; ninguna es real.
 */

interface Encoded {
  quality: number;
  width: number;
  height: number;
}

let encoded: Encoded[] = [];
/** Lo que se pintó en el lienzo, en orden: el fondo y la foto. */
let painted: string[] = [];
let decoded: Array<{ options: unknown }> = [];
/** Peso que «saca» el lienzo para cada calidad y lado mayor. */
let sizeFor: (quality: number, edge: number) => number = () => 100_000;
let decodeFails = false;
let bitmapEdge = { width: 4000, height: 3000 };

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => {
      const context = {
        fillStyle: '',
        fillRect: () => painted.push(`fondo ${context.fillStyle}`),
        drawImage: () => painted.push('foto')
      };
      return context;
    },
    toBlob: (callback: (blob: Blob | null) => void, _type: string, quality: number) => {
      encoded.push({ quality, width: canvas.width, height: canvas.height });
      const bytes = sizeFor(quality, Math.max(canvas.width, canvas.height));
      callback(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
    }
  };
  return canvas;
}

/** Una «foto» sintética: una cabecera JPEG con un bloque EXIF de mentira. */
function syntheticPhoto(bytes: number, name = 'IMG_20261003_101500.jpg', type = 'image/jpeg'): File {
  const content = new Uint8Array(bytes);
  content.set([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66]);
  return new File([content], name, { type, lastModified: 1_700_000_000_000 });
}

beforeEach(() => {
  encoded = [];
  painted = [];
  decoded = [];
  sizeFor = () => 100_000;
  decodeFails = false;
  bitmapEdge = { width: 4000, height: 3000 };
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
  vi.stubGlobal('createImageBitmap', async (_file: Blob, options: unknown) => {
    decoded.push({ options });
    if (decodeFails) throw new Error('formato que este navegador no sabe abrir');
    return { ...bitmapEdge, close: () => undefined };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sin opciones: lo de siempre (justificantes)', () => {
  it('una foto que ya cabe se sube tal cual, sin tocarla', async () => {
    const photo = syntheticPhoto(200_000);
    const prepared = await prepareAttachment(photo);
    expect(prepared.file).toBe(photo);
    expect(prepared.notice).toBeNull();
    expect(decoded).toHaveLength(0);
  });

  it('una foto que pesa de más baja la calidad hasta 0,55 si hace falta', async () => {
    sizeFor = (quality) => (quality >= 0.7 ? UPLOAD_TARGET_BYTES + 1 : 1_000_000);
    const prepared = await prepareAttachment(syntheticPhoto(UPLOAD_TARGET_BYTES + 10));
    expect(encoded.map((step) => step.quality)).toEqual([0.82, 0.7, 0.55]);
    expect(prepared.file.type).toBe('image/jpeg');
    expect(prepared.notice).toMatch(/se ha reducido/);
  });

  it('un PDF que pesa de más no se toca: solo se avisa', async () => {
    const pdf = new File([new Uint8Array(UPLOAD_TARGET_BYTES + 1)], 'ticket.pdf', { type: 'application/pdf' });
    const prepared = await prepareAttachment(pdf);
    expect(prepared.file).toBe(pdf);
    expect(prepared.notice).toMatch(/PDF/);
  });
});

describe('alwaysReencode: la foto se vuelve a dibujar SIEMPRE (cupones)', () => {
  it('una foto pequeña también se reencoda: el EXIF y el GPS no viajan', async () => {
    const photo = syntheticPhoto(150_000);
    const prepared = await prepareAttachment(photo, { alwaysReencode: true });
    // Un fichero NUEVO salido del lienzo, no el original con sus metadatos.
    expect(prepared.file).not.toBe(photo);
    expect(prepared.file.type).toBe('image/jpeg');
    expect(prepared.file.size).toBe(100_000);
    const bytes = new Uint8Array(await prepared.file.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 0, 0]);
    // La orientación se aplica al dibujar, para que la foto no salga tumbada.
    expect(decoded[0]?.options).toEqual({ imageOrientation: 'from-image' });
    // Pesaba poco: no hay nada que contar.
    expect(prepared.notice).toBeNull();
  });

  it('lo transparente sale blanco: un JPEG no tiene transparencia y la pintaría de negro', async () => {
    await prepareAttachment(syntheticPhoto(150_000, 'vale.png', 'image/png'), { alwaysReencode: true });
    // Primero el fondo blanco, después la foto encima.
    expect(painted).toEqual(['fondo #fff', 'foto']);
  });

  it('el nombre tampoco lleva la fecha y la hora de la cámara', async () => {
    const prepared = await prepareAttachment(syntheticPhoto(150_000), { alwaysReencode: true });
    expect(prepared.file.name).toBe('foto.jpg');
  });

  it('nunca baja de calidad 0,8: un código fino tiene que seguir leyéndose', async () => {
    sizeFor = () => UPLOAD_TARGET_BYTES + 1;
    bitmapEdge = { width: 1000, height: 800 };
    await expect(prepareAttachment(syntheticPhoto(UPLOAD_TARGET_BYTES + 5), { alwaysReencode: true })).rejects.toBeInstanceOf(
      PrepareAttachmentError
    );
    expect(encoded.length).toBeGreaterThan(0);
    for (const step of encoded) expect(step.quality).toBeGreaterThanOrEqual(0.8);
  });

  it('si con 0,8 no cabe, reduce el lado antes que la calidad', async () => {
    sizeFor = (_quality, edge) => (edge > 1600 ? UPLOAD_TARGET_BYTES + 1 : 900_000);
    const prepared = await prepareAttachment(syntheticPhoto(5_000_000), { alwaysReencode: true });
    expect(prepared.file.size).toBe(900_000);
    const last = encoded.at(-1);
    expect(Math.max(last?.width ?? 0, last?.height ?? 0)).toBeLessThanOrEqual(1600);
    for (const step of encoded) expect(step.quality).toBeGreaterThanOrEqual(0.8);
    // Pesaba de más: se cuenta en llano.
    expect(prepared.notice).toMatch(/se ha reducido/);
  });

  it('una foto enorme se dibuja como mucho a 2.200 px de lado', async () => {
    bitmapEdge = { width: 6000, height: 4000 };
    await prepareAttachment(syntheticPhoto(150_000), { alwaysReencode: true });
    expect(encoded[0]).toMatchObject({ width: 2200, height: 1467 });
  });

  it('si el navegador no sabe abrir la foto, falla cerrado: el original no sale', async () => {
    decodeFails = true;
    const attempt = prepareAttachment(syntheticPhoto(150_000, 'foto.heic', 'image/heic'), { alwaysReencode: true });
    await expect(attempt).rejects.toBeInstanceOf(PrepareAttachmentError);
    await expect(attempt).rejects.toThrow(/no ha podido preparar la foto/);
  });

  it('lo que no es una imagen no se acepta como foto', async () => {
    const pdf = new File([new Uint8Array(1000)], 'vale.pdf', { type: 'application/pdf' });
    await expect(prepareAttachment(pdf, { alwaysReencode: true })).rejects.toThrow(/foto/);
    expect(decoded).toHaveLength(0);
  });
});
