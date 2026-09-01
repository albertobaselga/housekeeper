/**
 * ¿Hay canal de avisos? El criterio, uno solo, para las dos mitades.
 *
 * Con esto decide la web si dibuja el interruptor de «Tu cuenta» y si el banner
 * ofrece encender los avisos; con esto decide el worker si registra los emisores
 * de la cola. Mientras cada mitad tuvo el suyo, la de la web era la laxa —le
 * bastaba con que las tres cadenas no estuvieran vacías— y esa diferencia
 * producía la peor avería que puede tener un aviso: con un `VAPID_SUBJECT`
 * sucio (el clásico `<mailto:avisos@ejemplo.es>` con los corchetes que se pegan
 * del panel de Vercel), la casa veía el interruptor, el navegador se suscribía y
 * la fila se guardaba... mientras la cola no registraba ni un emisor. Avisos
 * encendidos de cara a la persona y apagados de verdad, para siempre y sin una
 * línea de registro. Dos criterios distintos para lo mismo se separan; uno solo,
 * no.
 *
 * Vive en un módulo propio y sin una sola dependencia por la misma razón que su
 * vecino `net.ts`: la web NO puede traerse esto de `@housekeeper/worker/jobs`.
 * Ese barril reexporta `createJobHandlers` → `handlers.ts` → `documents.ts`, que
 * importa `pdf-lib` y `fflate` de forma ESTÁTICA, y quien lo importaría es
 * `push.server.ts`, que carga el layout de `/h/[householdId]` en cada render de
 * cualquier página del hogar: el generador de PDF acabaría en el paquete
 * serverless de toda la navegación.
 *
 * Y se aloja aquí, y no en `@housekeeper/server`, porque el barril de aquel
 * paquete apunta al fuente (`src/index.ts`) mientras el worker se ejecuta
 * compilado (`node dist/index.js`): importarlo desde `push.ts` metería un `.ts`
 * en el grafo de `dist/`. Habría que abrir un subcamino compilado, y entonces
 * la web pasaría a necesitar el `dist/` de ese paquete para desplegarse, que hoy
 * no necesita. Mucho movimiento para una expresión regular y cuatro líneas.
 */

/** Las tres piezas del canal, ya recortadas. */
export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * `sub` limpio o Apple contesta 403 BadJwtToken — y **solo Apple**, lo que
 * convierte un espacio de más en un fallo que aparece únicamente en los iPhone
 * de la casa y en ningún otro sitio. Se valida al arrancar, y no al enviar.
 */
const VAPID_SUBJECT = /^(mailto:[^\s<>]+@[^\s<>]+\.[^\s<>]+|https:\/\/[^\s<>]+)$/;

/**
 * Las tres piezas o ninguna, y el `sub` con la forma que exige la norma.
 *
 * Que devuelva `null` es la señal de que en esta instalación no hay canal. La
 * interfaz lo dice —«los avisos no están configurados»— en vez de ofrecer un
 * interruptor que no puede funcionar, y la cola no registra emisores que no
 * podrían firmar. Es la misma frase para las dos, que es justo lo que aquí se
 * está comprando.
 */
export function loadVapidConfig(
  environment: Partial<Record<string, string>>,
): VapidConfig | null {
  const subject = environment.VAPID_SUBJECT?.trim();
  const publicKey = environment.VAPID_PUBLIC_KEY?.trim();
  const privateKey = environment.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) return null;
  if (!VAPID_SUBJECT.test(subject)) return null;
  return { subject, publicKey, privateKey };
}
