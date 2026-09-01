/**
 * Fuente única de la identidad que se muestra: el nombre genérico del producto
 * y el título de la pestaña del navegador.
 *
 * «Casa Clara» es el nombre del PROYECTO y se coló como si fuera el del
 * producto en uso. Una misma instalación sirve a varias casas, así que:
 *
 * · Sin sesión (acceso, error, sin conexión) se anuncia el producto genérico.
 *   Quien todavía no ha entrado no tiene por qué saber qué casa hay detrás.
 * · Con sesión manda el nombre del hogar que se está mirando, que ya viaja en
 *   el contexto de la aplicación (`AppContext.household.name`) y por tanto
 *   sigue al hogar de la URL, no al primero de la persona.
 *
 * Nadie más compone títulos: el `+layout.svelte` de la raíz pinta el único
 * `<title>` de la aplicación con lo que devuelven estas funciones. Una página
 * nueva no tiene que acordarse de nada, y un hogar nuevo no obliga a tocar
 * ningún fichero.
 */

/** Nombre genérico del producto: ni el del proyecto, ni el de un hogar. */
export const APP_NAME = 'Aplicación para la gestión del personal doméstico';

/**
 * Cómo se llama el icono una vez instalada en el teléfono. Es el `short_name`
 * del manifiesto, y es lo único que la persona ve bajo el icono y en la ficha
 * de ajustes del sistema. Vive aquí porque hay texto de la interfaz que tiene
 * que mandar a alguien a esa ficha: decirle otro nombre es mandarla a buscar
 * algo que no va a encontrar.
 *
 * Si cambia en `static/manifest.webmanifest`, cambia aquí. La prueba de
 * `app-title.test.ts` compara ambos y falla si divergen.
 */
export const APP_HOME_SCREEN_NAME = 'Hogar';

/**
 * Etiqueta de cada sección, indexada por la ruta sin el prefijo del hogar
 * (`/h/<id>/…`) o por la ruta entera cuando vive fuera de él. Aquí, y solo
 * aquí, se apunta una página nueva.
 */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  today: 'Hoy',
  employment: 'Contrato',
  'employment/acuerdo': 'Condiciones del contrato',
  'employment/condiciones': 'Mis condiciones',
  'employment/vacaciones': 'Vacaciones',
  personal: 'Personal',
  menu: 'Menú',
  recipes: 'Recetas',
  wiki: 'Guía de la casa',
  'wiki/progreso': 'Avance de la guía',
  search: 'Buscar',
  routines: 'Rutinas',
  calendar: 'Calendario',
  contacts: 'Contactos',
  emergency: 'Emergencias',
  account: 'Tu acceso',
  settings: 'Ajustes',
  finanzas: 'Finanzas',
  'finanzas/analitica': 'Analítica',
  'finanzas/movimientos': 'Movimientos',
  'finanzas/revision': 'Revisión',
  'finanzas/eventos': 'Eventos',
  'finanzas/importar': 'Importar',
  'finanzas/ajustes': 'Ajustes de Finanzas',
  offline: 'Sin conexión'
};

/**
 * Sección a la que corresponde una URL. Una ruta hija sin etiqueta propia
 * hereda la de su sección (`/wiki/<nota>` → «Guía de la casa»); las páginas que
 * quieran afinarlo devuelven `section` desde su `load` y esa gana.
 */
export function sectionLabelFor(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const inside = parts[0] === 'h' ? parts.slice(2) : parts;
  if (inside.length === 0) return null;
  return SECTION_LABELS[inside.join('/')] ?? SECTION_LABELS[inside[0]] ?? null;
}

/**
 * «Hoy · Casa EG112» con sesión; sin ella, el producto genérico solo o
 * precedido de la sección («Sin conexión · Aplicación para la gestión…»).
 */
export function documentTitle(
  section: string | null | undefined,
  householdName?: string | null
): string {
  const base = householdName?.trim() || APP_NAME;
  return section ? `${section} · ${base}` : base;
}
