import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APP_HOME_SCREEN_NAME,
  APP_NAME,
  documentTitle,
  sectionLabelFor
} from '../src/lib/app-title';
import { HOUSEHOLD_MODULES } from '../src/lib/auth/routing';

describe('título de la pestaña: una sola fuente', () => {
  it('sin sesión anuncia el producto genérico, nunca un proyecto ni una casa', () => {
    expect(APP_NAME).toBe('Aplicación para la gestión del personal doméstico');
    // La pantalla de acceso: quien todavía no ha entrado no debe leer el
    // nombre de ninguna casa.
    expect(sectionLabelFor('/login')).toBeNull();
    expect(documentTitle(sectionLabelFor('/login'))).toBe(APP_NAME);
    expect(documentTitle(sectionLabelFor('/offline'))).toBe(`Sin conexión · ${APP_NAME}`);
    expect(documentTitle('No encontrado')).toBe(`No encontrado · ${APP_NAME}`);
    for (const title of [documentTitle(null), documentTitle('Sin conexión')]) {
      expect(title).not.toMatch(/Casa Clara/);
      // El nombre del proyecto tampoco: ni el viejo ni el nuevo se muestran.
      expect(title).not.toMatch(/Housekeeper/i);
    }
  });

  it('con sesión manda el nombre del hogar al que se ha entrado', () => {
    expect(documentTitle(sectionLabelFor('/h/abc/today'), 'Casa EG112')).toBe('Hoy · Casa EG112');
    expect(documentTitle(sectionLabelFor('/h/abc/menu'), 'Casa Olivo')).toBe('Menú · Casa Olivo');
    // Dos casas, dos títulos: la sección es la misma y el nombre no.
    expect(documentTitle(sectionLabelFor('/h/uno/today'), 'Casa Roble')).toBe('Hoy · Casa Roble');
    expect(documentTitle(sectionLabelFor('/h/dos/today'), 'Casa Olivo')).toBe('Hoy · Casa Olivo');
    // El índice del hogar no tiene sección propia: solo la casa.
    expect(documentTitle(sectionLabelFor('/h/abc'), 'Casa Roble')).toBe('Casa Roble');
    // Un hogar sin nombre utilizable no deja la pestaña en blanco.
    expect(documentTitle('Hoy', '   ')).toBe(`Hoy · ${APP_NAME}`);
  });

  it('toda sección estable tiene etiqueta, y las hijas declaradas la suya', () => {
    for (const moduleName of HOUSEHOLD_MODULES) {
      expect(sectionLabelFor(`/h/abc/${moduleName}`), moduleName).toBeTruthy();
    }
    // La sección se llama «Contrato» (decisión del propietario): la etiqueta de
    // la pestaña es la misma palabra que la barra lateral y la cabecera.
    expect(sectionLabelFor('/h/abc/employment')).toBe('Contrato');
    expect(sectionLabelFor('/h/abc/employment/acuerdo')).toBe('Condiciones del contrato');
    expect(sectionLabelFor('/h/abc/employment/condiciones')).toBe('Mis condiciones');
    expect(sectionLabelFor('/h/abc/employment/conceptos')).toBe('Conceptos del mes');
    expect(sectionLabelFor('/h/abc/employment/pagos')).toBe('Pagos');
    // Una nota de la guía hereda la sección; su propio título llega por `section`.
    expect(sectionLabelFor('/h/abc/wiki/lavadora')).toBe('Guía de la casa');
    expect(sectionLabelFor('/h/abc/wiki/progreso')).toBe('Avance de la guía');
    // El modo libro hereda la sección; la nota concreta la pone su `load`.
    expect(sectionLabelFor('/h/abc/wiki/libro/lavadora')).toBe('Guía de la casa');
    // Una ruta que nadie declaró no inventa etiqueta: se titula con la casa.
    expect(sectionLabelFor('/h/abc/inventada')).toBeNull();
  });

  it('el nombre del icono es el del manifiesto, o mandaríamos a buscar algo que no existe', () => {
    // «Tu cuenta» manda a la ficha del sistema por su nombre para desbloquear
    // los avisos. Si el manifiesto cambiara y este texto no, la instrucción
    // llevaría a una ficha que en ese teléfono se llama de otra manera.
    const manifest = JSON.parse(
      readFileSync(new URL('../static/manifest.webmanifest', import.meta.url), 'utf8')
    );
    expect(APP_HOME_SCREEN_NAME).toBe(manifest.short_name);
    expect(manifest.name).toBe(APP_NAME);
  });
});
