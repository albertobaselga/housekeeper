/**
 * Modelo de autorización: los cinco roles del producto, las capacidades y la
 * matriz que las reparte. Vive en un submódulo propio —`@housekeeper/contracts/
 * capabilities`— y NO se reexporta desde `./index.ts`. La regla es deliberada y
 * hay que respetarla:
 *
 * > `@housekeeper/contracts` (la raíz) lo carga TODA pantalla del cliente, porque
 * > de ahí sale `canonicalJson`, que verifica la firma del paquete offline en el
 * > arranque. Cualquier dato que se reexporte desde la raíz viaja con él.
 *
 * La matriz son ~1,2 kB minificados de tablas literales que el cliente NO
 * necesita: el servidor resuelve las capacidades de la sesión en
 * `+layout.server.ts` y las manda ya resueltas dentro de `AppContextV1`, así que
 * el navegador solo hace `context.capabilities.includes(...)`. Mientras la
 * matriz estuvo en `index.ts` viajó igualmente en el trozo compartido de la
 * pantalla Hoy, y ahí se comió la mitad del margen del presupuesto de arranque.
 *
 * Reexportarla desde `index.ts` —aunque sea con `export { ... } from`, aunque
 * nadie la use— la devuelve al trozo compartido: el troceo de rolldown reparte
 * por alcanzabilidad de módulo, no por binding usado, así que basta la arista de
 * importación para arrastrarla. Lo vigila
 * `apps/web/scripts/verify-today-bundle.mjs`, que falla la construcción si este
 * módulo reaparece en el grafo inicial de Hoy.
 *
 * Quien necesite la matriz entera (el servidor, los formularios de acceso, las
 * pruebas) la importa de este submódulo y punto.
 */

export const roles = [
  "family_admin",
  "family_member",
  "employee_live_in",
  "helper",
  "viewer",
] as const;

export type Role = (typeof roles)[number];

/**
 * `content.*` gobierna el CONTENIDO del hogar en general (el recetario, que la
 * familia mantiene). `guide.write` es más estrecha a propósito: escribir la
 * **Guía de la casa** es cosa de la administración y de nadie más, porque la
 * Guía es a la vez el manual de acogida de quien trabaja aquí. Sin esta
 * capacidad la interfaz NO dibuja ningún control de escritura, y la RLS de
 * `wiki_*` lo impone igualmente (migración 0026).
 *
 * `coupon.access` abre la cartera de cupones de la familia, entera: verlos,
 * guardarlos, apuntar y anular usos, descartarlos y recuperarlos. Es UNA sola
 * capacidad porque aquí no hay lector y escritor: los cupones son de toda la
 * familia y cualquiera de la familia los toca. Quien trabaja en la casa, el
 * apoyo y el acceso puntual no ven nada del módulo, ni siquiera la foto. Sin
 * esta capacidad no hay entrada en la navegación ni ruta que abrir, y la RLS
 * de `coupons` lo impone igualmente (migración 0039).
 */
export const capabilities = [
  "access.manage",
  "agreement.read",
  "agreement.write",
  "calendar.read",
  "calendar.write",
  "comment.create",
  "contact.read",
  "contact.write",
  "content.read",
  "content.write",
  "content.publish",
  "coupon.access",
  "emergency.read",
  "expense.create.self",
  "export.employment.self",
  "finance.access",
  "guide.write",
  "leave.approve",
  "leave.request.self",
  "menu.read",
  "menu.write",
  "payment.confirm.self",
  "payment.register",
  "routine.read",
  "routine.toggle",
  "search.use",
  "settlement.close",
  "settlement.read",
  "work.confirm",
  "work.register.self",
] as const;

export type Capability = (typeof capabilities)[number];

const allCapabilities = [...capabilities];

export const roleCapabilities: Readonly<Record<Role, readonly Capability[]>> = {
  family_admin: allCapabilities,
  family_member: [
    "agreement.read",
    "calendar.read",
    "calendar.write",
    "comment.create",
    "contact.read",
    "contact.write",
    "content.publish",
    "content.read",
    "content.write",
    "coupon.access",
    "emergency.read",
    "menu.read",
    "menu.write",
    "routine.read",
    "routine.toggle",
    "search.use",
    "settlement.read",
  ],
  employee_live_in: [
    "agreement.read",
    "calendar.read",
    "comment.create",
    "contact.read",
    "content.read",
    "emergency.read",
    "expense.create.self",
    "export.employment.self",
    "leave.request.self",
    "menu.read",
    "payment.confirm.self",
    "routine.read",
    "routine.toggle",
    "search.use",
    "settlement.read",
    "work.register.self",
  ],
  helper: [
    "comment.create",
    "contact.read",
    "content.read",
    "emergency.read",
    "menu.read",
    "routine.read",
    "routine.toggle",
    "search.use",
  ],
  viewer: ["calendar.read", "contact.read", "emergency.read"],
};

export function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value);
}

export function hasCapability(role: Role, capability: Capability): boolean {
  return roleCapabilities[role].includes(capability);
}
