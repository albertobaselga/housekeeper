/**
 * Encender y apagar los avisos de este dispositivo, desde el navegador.
 *
 * Módulo aparte y cargado bajo demanda: la pantalla «Tu cuenta» lo importa con
 * `import()` cuando la persona toca el interruptor, así que ni una línea de esto
 * viaja en el arranque de nadie. Tampoco pasa por la cola de comandos offline:
 * suscribir un teléfono no es un hecho del expediente laboral, no lleva recibo
 * con actor y hora, y no tiene sentido diferido —si no hay red, no hay
 * suscripción que registrar—.
 *
 * Nada de aquí se ejecuta al entrar en la aplicación. El permiso se pide cuando
 * la persona acaba de pedirlo, y en ningún otro momento.
 */

/** Qué puede hacer este navegador, antes de ofrecerle nada a nadie. */
export type PushAvailability =
  /** Se puede: hay service worker, hay PushManager y el permiso no está denegado. */
  | { kind: 'available'; permission: 'default' | 'granted' }
  /** El navegador los tiene bloqueados. No hay botón de reintento porque no existe. */
  | { kind: 'blocked' }
  /**
   * Es un iPhone o un iPad y la aplicación NO se abrió desde el icono de la
   * pantalla de inicio. En Safari-pestaña `PushManager` sencillamente no existe:
   * el fallo es silencioso, así que hay que nombrarlo.
   */
  | { kind: 'needs-home-screen' }
  /** Este navegador no sabe hacerlo, y no hay nada que la persona pueda cambiar. */
  | { kind: 'unsupported' };

function looksLikeApple(): boolean {
  // iPadOS se anuncia como Macintosh con puntero táctil desde iPadOS 13.
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari en iOS no implementa `display-mode: standalone` en versiones
    // antiguas y expone esta propiedad no estándar en su lugar.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function pushAvailability(): PushAvailability {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    return looksLikeApple() && !isInstalled() ? { kind: 'needs-home-screen' } : { kind: 'unsupported' };
  }
  if (!('PushManager' in window)) {
    // En iPhone esto significa casi siempre lo mismo: no está instalada. Decirlo
    // así —y no «tu navegador no puede»— es la diferencia entre una pega con
    // solución y un muro.
    return looksLikeApple() && !isInstalled() ? { kind: 'needs-home-screen' } : { kind: 'unsupported' };
  }
  if (Notification.permission === 'denied') return { kind: 'blocked' };
  return { kind: 'available', permission: Notification.permission === 'granted' ? 'granted' : 'default' };
}

/**
 * La clave pública VAPID viaja en base64url y `subscribe` la quiere en bytes.
 *
 * Se devuelve un `ArrayBuffer` y no un `Uint8Array` porque el tipo que pide
 * `applicationServerKey` no admite una vista sobre un búfer compartido, y una
 * `Uint8Array` recién creada lo es en la firma aunque no en los hechos.
 */
export function decodeVapidKey(base64Url: string): ArrayBuffer {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

function serialize(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }
  };
}

export type EnableResult =
  | { ok: true }
  /** La persona dijo que no, o el navegador ya lo tenía denegado. */
  | { ok: false; reason: 'denied' }
  /** Todo lo demás: sin red, el servicio de push no contestó, el servidor falló. */
  | { ok: false; reason: 'failed' };

/**
 * Pide el permiso —solo aquí, y solo tras un gesto de la persona— y registra el
 * dispositivo.
 *
 * En iOS el diálogo del sistema es de un solo disparo: si dice que no,
 * `requestPermission()` devuelve `denied` para siempre y solo se recupera
 * borrando el icono y reinstalándolo. Por eso este módulo no se llama nunca
 * solo, y por eso quien lo llama tiene que haber explicado antes para qué es.
 */
export async function enablePush(vapidPublicKey: string, deviceLabel?: string): Promise<EnableResult> {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied' };

    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        // Obligatorio por norma: no se puede recibir un aviso y no mostrarlo. Es
        // también la razón por la que las horas de silencio se aplican en el
        // servidor y no aquí — silenciar en el cliente suena igual, y encima
        // peor, porque el navegador enseña una notificación genérica suya.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(vapidPublicKey)
      }));

    const response = await fetch('/api/v1/push/subscription', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...serialize(subscription), deviceLabel })
    });
    if (!response.ok) {
      // El servidor no se quedó con el dispositivo: deshacer la suscripción del
      // navegador evita el peor estado posible, que es creer que están activos
      // sin que nadie sepa a dónde escribir.
      await subscription.unsubscribe().catch(() => false);
      return { ok: false, reason: 'failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Apaga los avisos: primero en el servidor y después en el navegador.
 *
 * Ese orden y no el otro. Si se cancelara primero en el navegador y luego
 * fallara la red, la fila quedaría viva apuntando a un endpoint muerto y el
 * servidor seguiría escribiéndole a la nada hasta que el servicio de push
 * contestara 410. Al revés, un fallo deja los avisos apagados en el servidor
 * —que es lo que la persona pidió— y una suscripción huérfana en el navegador
 * que no recibe nada.
 */
export async function disablePush(): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;

    const response = await fetch('/api/v1/push/subscription', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    if (!response.ok) return false;
    await subscription.unsubscribe().catch(() => false);
    return true;
  } catch {
    return false;
  }
}

/**
 * ¿Está este dispositivo suscrito AHORA MISMO, según el navegador?
 *
 * La verdad la tiene el navegador, no el servidor: puede haber revocado la
 * suscripción por su cuenta (limpieza de datos del sitio, cambio de móvil, un
 * icono de iOS reinstalado) sin avisar a nadie. `pushsubscriptionchange` no
 * sirve para enterarse —soporte limitado y Safari no lo implementa—, así que la
 * reconciliación es esta: mirar al abrir la pantalla.
 */
export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}
