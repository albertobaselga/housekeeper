/**
 * Catálogo de tipos de contacto (CHECK de app.contacts y enum del payload
 * congelado). Módulo compartido cliente/servidor: las páginas lo usan para
 * agrupar y etiquetar; contacts.server.ts para ordenar la lectura RLS.
 */
export type ContactKind = 'emergency' | 'health' | 'home' | 'service' | 'school' | 'otros';

export const CONTACT_KINDS: readonly ContactKind[] = [
  'emergency',
  'health',
  'home',
  'service',
  'school',
  'otros'
];

export const CONTACT_KIND_LABELS: Readonly<Record<ContactKind, string>> = {
  emergency: 'Emergencias',
  health: 'Salud',
  home: 'Casa y vecinos',
  service: 'Servicios y averías',
  school: 'Colegio y actividades',
  otros: 'Otros'
};
