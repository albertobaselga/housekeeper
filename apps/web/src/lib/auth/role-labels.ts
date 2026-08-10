import type { Role } from '@casa-clara/contracts/capabilities';

/**
 * Cómo se llama cada papel de la casa en pantalla.
 *
 * Vive APARTE de `$lib/auth/capabilities` a propósito. La cabecera del hogar
 * (`AppShell`, en el layout `/h/[householdId]`) es lo único que necesita estas
 * cinco etiquetas, y el layout se carga en TODAS las pantallas autenticadas,
 * Hoy incluida. Mientras las etiquetas convivieron con `can()`, el troceo
 * juntaba las dos cosas y la cabecera se traía la matriz de capacidades entera
 * —1,6 kB para pintar «Empleada interna»—.
 *
 * Aquí solo puede haber datos de presentación. El único import es de tipo, y
 * `import type` se borra al compilar: si algún día este fichero importa algo
 * ejecutable de `./capabilities` o de `@casa-clara/contracts/capabilities`, la
 * matriz vuelve al arranque de todas las pantallas.
 */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  family_admin: 'Administrador familiar',
  family_member: 'Miembro de la familia',
  employee_live_in: 'Empleada interna',
  helper: 'Apoyo del hogar',
  viewer: 'Acceso puntual'
};
