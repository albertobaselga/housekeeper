/**
 * Los avisos al móvil: el catálogo, el texto y el envío.
 *
 * Módulo propio y no dentro de `integrations.ts` por una razón operativa: aquel
 * importa `sharp` y `tesseract.js`, y el drenaje de la cola vive en una función
 * de Vercel que no puede arrastrar binarios nativos. Aquí solo entra `web-push`,
 * que es JavaScript.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOS AVISOS. NI UNO MÁS, Y LA LISTA DE LO QUE NO SE MANDA ES CÓDIGO.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `PUSH_TOPICS` es el catálogo entero y está cerrado. Lo que queda prohibido, y
 * por qué, está en `docs/notificaciones.md` §6; lo importante de esa lista es
 * que **prohibido significa que no se construye el emisor**, no que venga
 * apagado por defecto. Un interruptor apagado es una promesa; la ausencia de
 * código es un hecho. En concreto no existe, ni debe existir, emisor para:
 *
 *   · recordatorios de tareas o rutinas hacia quien trabaja en la casa;
 *   · cualquier recuento de trabajo (rachas, medias, «te quedan 3»);
 *   · avisos disparados por la AUSENCIA de una acción («no ha confirmado»);
 *   · repetición o escalada hacia quien no puede resolver el asunto;
 *   · presencia y actividad («ha entrado», «visto por última vez»);
 *   · avisos sobre el desempeño de una persona, aunque el destinatario sea
 *     quien administra: lo prohibido es que el mensaje exista, no quién lo lee;
 *   · producto y relleno (novedades, resúmenes, «hace tiempo que no entras»).
 *
 * La base tampoco los sabría resolver: `app_private.push_notice_targets`
 * (migración 0032) rechaza con 22023 cualquier tópico fuera de estos dos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NINGÚN DATO EN EL TEXTO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * El cuerpo de un aviso viaja cifrado de punta a punta (RFC 8291): ni Apple, ni
 * Google, ni Mozilla tienen las claves. El riesgo no es el transporte: **es la
 * pantalla de bloqueo**, que dibuja el texto sin sesión y sin desbloquear el
 * teléfono, delante de cualquiera que pase. En un piso donde la administración y
 * quien trabaja comparten cocina, ese es el canal de fuga, y es asimétrico.
 *
 * Regla dura, y la razón por la que el importe de la cuenta NO viaja en el
 * aviso: **el aviso dice de qué tipo es y dónde mirar; nunca el dato.** El
 * importe es el sueldo de una persona que no es la destinataria del aviso —lo
 * recibe quien administra— y por tanto nadie puede consentir por ella que su
 * número se pinte en la pantalla apagada de otro. Además no compra nada: desde
 * la notificación no se transfiere dinero, así que la cifra se ve al abrir, que
 * es a un toque y detrás de una contraseña.
 */
import type { Pool } from "pg";

import { PermanentJobError, type JobHandler } from "./queue.js";

export const PUSH_NOTICE_JOB = "notification.push";

/** El catálogo entero. Añadir uno cuesta una migración y una discusión. */
export const PUSH_TOPICS = ["settlement.receipt_ready", "settlement.due"] as const;
export type PushTopic = (typeof PUSH_TOPICS)[number];

/**
 * Cuántas veces se re-avisa de una cuenta sin pagar, además de la primera.
 *
 * El aviso sale tres días antes del vencimiento y vuelve cada tres días mientras
 * siga pendiente. La escalada se conserva —hacia quien administra, que es quien
 * puede resolverla y de quien es la deuda— pero **acotada**: cuatro avisos en
 * total cubren de tres días antes a seis después. Si en nueve días no se ha
 * pagado, la quinta vibración no es lo que falta, y el hecho sigue en Hoy.
 *
 * El tope no es cosmético: la versión anterior de este aviso se re-encolaba a sí
 * misma sin límite, y esa es literalmente la razón que la migración 0029 escribió
 * al retirarla («este además se multiplicaba solo»).
 */
export const SETTLEMENT_DUE_MAX_REPEATS = 3;

/** Días entre un aviso de cuenta pendiente y el siguiente. */
export const SETTLEMENT_DUE_REPEAT_DAYS = 3;

/**
 * Cuánto retiene el servicio de push un aviso para un teléfono apagado.
 *
 * Cuatro horas, y es una decisión con un residuo honesto detrás: la ventana de
 * silencio la decide el servidor al encolar, pero **el último tramo no lo decide
 * nadie de esta casa**. Si el teléfono estaba apagado, el aviso se entrega
 * cuando vuelva, y eso puede ser de madrugada. No hay forma de evitarlo: no se
 * puede programar en el dispositivo y no se puede recibir sin mostrar. Con un
 * TTL corto, un aviso que no llegó en cuatro horas se pierde — que es
 * exactamente lo que queremos que pase antes que sonar a las tres de la mañana.
 */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

export interface PushTarget {
  subscriptionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  agreementId: string;
  /** `YYYY-MM-DD` del primer día del periodo liquidado. */
  periodStart: string;
  /** `YYYY-MM-DD` del vencimiento del pago. */
  dueOn: string;
}

export interface PushNoticeText {
  title: string;
  body: string;
  /** Ruta relativa dentro de la aplicación; la abre `notificationclick`. */
  url: string;
  /**
   * Agrupador RFC 8030 (cabecera `Topic`) y `tag` de la notificación: dos avisos
   * del mismo asunto se sustituyen en vez de acumularse. El alfabeto permitido
   * por la norma es el de base64url y el tope, 32 caracteres.
   */
  tag: string;
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** «junio», o «junio de 2025» cuando el año no es el que corre. */
export function monthLabel(isoDate: string, today: Date): string {
  const [year, month] = isoDate.split("-");
  const name = MONTHS[Number(month) - 1] ?? isoDate;
  return Number(year) === today.getUTCFullYear() ? name : `${name} de ${year}`;
}

/** «el 5 de julio». Sin año: el vencimiento siempre está a la vuelta. */
export function dayLabel(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `el ${Number(day)} de ${MONTHS[Number(month) - 1] ?? month}`;
}

/**
 * El texto exacto de cada aviso, compuesto EN EL ENVÍO y nunca en la cola.
 *
 * Regla de redacción: el sujeto es el hecho o la casa, nunca «tú» en imperativo.
 * «La cuenta de junio está sin pagar» sí; «paga la cuenta» no. Un aviso que da
 * órdenes al teléfono de alguien es otra cosa distinta de un aviso.
 */
export function composeNotice(
  topic: PushTopic,
  target: PushTarget,
  householdId: string,
  today: Date,
): PushNoticeText {
  const month = monthLabel(target.periodStart, today);
  const href = `/h/${householdId}/employment?empleada=${target.agreementId}`;
  // El agrupador tiene que caber en 32 caracteres del alfabeto de base64url, así
  // que ni el tópico con puntos ni el uuid entero valen. Con el prefijo corto y
  // los ocho primeros dígitos basta para que dos avisos del mismo asunto se
  // sustituyan, que es para lo único que sirve.
  const shortId = target.agreementId.replace(/-/g, "").slice(0, 8);

  if (topic === "settlement.receipt_ready") {
    return {
      title: `El recibo de ${month} ya está`,
      body: "Puedes verlo y confirmar el cobro cuando quieras.",
      url: href,
      tag: `recibo-${shortId}`,
    };
  }
  return {
    title: `La cuenta de ${month} está sin pagar`,
    // El importe NO va aquí, y no es un olvido: ver la cabecera del módulo.
    body: `Vence ${dayLabel(target.dueOn)}. El importe se ve al abrir.`,
    url: href,
    tag: `cuenta-${shortId}`,
  };
}

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * `sub` limpio o Apple contesta 403 BadJwtToken — y **solo Apple**, lo que
 * convierte un espacio de más en un fallo que aparece únicamente en los iPhone
 * de la casa y en ningún otro sitio. Se valida aquí, al arrancar, y no allí.
 */
const VAPID_SUBJECT = /^(mailto:[^\s<>]+@[^\s<>]+\.[^\s<>]+|https:\/\/[^\s<>]+)$/;

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

export type PushSendOutcome =
  /** Entregado al servicio de push (no al teléfono: eso nadie lo sabe). */
  | { delivered: true }
  /**
   * `gone` es 404/410: ese endpoint no volverá a existir nunca (datos del sitio
   * limpiados, aplicación desinstalada, icono de iOS rehecho). Cualquier otro
   * fallo puede ser del día.
   */
  | { delivered: false; gone: boolean };

export interface PushSender {
  (input: { target: PushTarget; notice: PushNoticeText }): Promise<PushSendOutcome>;
}

export interface PushNoticeDeps {
  resolveTargets: (
    householdId: string,
    settlementId: string,
    topic: PushTopic,
  ) => Promise<PushTarget[]>;
  recordDelivery: (subscriptionId: string, delivered: boolean, gone: boolean) => Promise<void>;
  send: PushSender;
  /** Re-encola el aviso de cuenta pendiente dentro de la ventana permitida. */
  rescheduleSettlementDue: (input: {
    householdId: string;
    settlementId: string;
    repeat: number;
    afterDays: number;
  }) => Promise<void>;
  now?: () => Date;
}

interface PushNoticePayload {
  topic: PushTopic;
  settlementId: string;
  /** Cuántas veces se ha reavisado ya de esto. Un entero: ningún dato personal. */
  repeat: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePushNoticePayload(payload: unknown): PushNoticePayload {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const topic = raw.topic;
  if (typeof topic !== "string" || !(PUSH_TOPICS as readonly string[]).includes(topic)) {
    // Reintentar no lo haría legal: el catálogo es cerrado.
    throw new PermanentJobError(`Aviso fuera del catálogo: ${String(topic)}`);
  }
  const settlementId = raw.settlementId;
  if (typeof settlementId !== "string" || !UUID.test(settlementId)) {
    throw new PermanentJobError("El aviso necesita el identificador de la liquidación");
  }
  const repeat = raw.repeat;
  if (repeat !== undefined && (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 0)) {
    throw new PermanentJobError("`repeat` debe ser un entero no negativo");
  }
  return { topic: topic as PushTopic, settlementId, repeat: (repeat as number | undefined) ?? 0 };
}

/**
 * Trabajo `notification.push` {topic, settlementId, repeat?}.
 *
 * Tres propiedades que conviene no perder al tocarlo:
 *
 *   1. **Cero destinatarios NO es un fallo.** Es el caso normal cuando el hecho
 *      ya no es cierto (se confirmó el cobro, se pagó la cuenta, se retiró el
 *      acceso, la persona está de vacaciones) o cuando sencillamente nadie ha
 *      encendido los avisos. El trabajo se completa sin efectos, igual que hacía
 *      el recordatorio que esta casa ya tenía escrito y probado.
 *
 *   2. **Una entrega fallida NO tumba el trabajo.** Si reintentásemos el trabajo
 *      entero por un teléfono que no contestó, el que sí recibió el aviso lo
 *      recibiría otra vez. Aquí una vibración de más es peor que una de menos:
 *      el hecho está en la aplicación de todos modos. Cada resultado se anota en
 *      su fila y el trabajo termina bien.
 *
 *   3. **La escalada está acotada y solo existe hacia quien administra.** La
 *      audiencia la decide la base (0032); el tope lo decide `repeat`.
 */
export function createPushNoticeHandler(deps: PushNoticeDeps): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job) => {
    const { topic, settlementId, repeat } = parsePushNoticePayload(job.payload);
    const targets = await deps.resolveTargets(job.householdId, settlementId, topic);

    for (const target of targets) {
      const notice = composeNotice(topic, target, job.householdId, now());
      const outcome = await deps.send({ target, notice });
      await deps.recordDelivery(
        target.subscriptionId,
        outcome.delivered,
        outcome.delivered ? false : outcome.gone,
      );
    }

    // La cuenta sigue pendiente (si no lo estuviera, `resolveTargets` habría
    // devuelto cero) y aún queda margen de escalada: se vuelve a preguntar
    // dentro de tres días. Nótese que se re-encola aunque no haya habido ningún
    // destinatario esta vez —el teléfono puede estar suscrito mañana— pero no si
    // el hecho desapareció, porque entonces tampoco habría a quién.
    if (topic === "settlement.due" && repeat < SETTLEMENT_DUE_MAX_REPEATS && targets.length > 0) {
      await deps.rescheduleSettlementDue({
        householdId: job.householdId,
        settlementId,
        repeat: repeat + 1,
        afterDays: SETTLEMENT_DUE_REPEAT_DAYS,
      });
    }
  };
}

interface WebPushErrorLike {
  statusCode?: number;
}

/** 404 y 410: el endpoint está muerto y no resucita. */
export function isGoneStatus(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/**
 * El emisor real, contra `web-push`.
 *
 * Las credenciales van POR LLAMADA y no por `setVapidDetails`, que es estado
 * global mutable del módulo: en una función serverless reutilizada entre
 * invocaciones eso es una variable compartida esperando a que alguien la pise.
 */
export function createWebPushSender(vapid: VapidConfig): PushSender {
  return async ({ target, notice }) => {
    // Carga diferida: el módulo solo se evalúa cuando de verdad hay algo que
    // mandar. Una pasada normal de la cola no manda nada y no lo paga.
    const { default: webPush } = await import("web-push");
    try {
      await webPush.sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        JSON.stringify(notice),
        {
          vapidDetails: vapid,
          TTL: PUSH_TTL_SECONDS,
          // `low` para todo: nada de esta casa justifica despertar a un teléfono
          // en ahorro de batería.
          urgency: "low",
          topic: notice.tag,
        },
      );
      return { delivered: true };
    } catch (error) {
      return { delivered: false, gone: isGoneStatus((error as WebPushErrorLike).statusCode) };
    }
  };
}

/**
 * Las consultas reales sobre el pool del emisor.
 *
 * `casa_clara_worker` no tiene ni un permiso sobre `app.push_subscriptions`: las
 * dos funciones definer de la 0032 son la única superficie, y ya llevan dentro
 * el filtro de membresía viva, el de audiencia y el de vacaciones.
 */
export function createPushQueries(pool: Pool): Pick<
  PushNoticeDeps,
  "resolveTargets" | "recordDelivery" | "rescheduleSettlementDue"
> & {
  announceReceipt: (input: { householdId: string; settlementId: string }) => Promise<void>;
} {
  return {
    announceReceipt: async ({ householdId, settlementId }) => {
      // `app.push_run_at(statement_timestamp())` y no `statement_timestamp()`:
      // el recibo se genera cuando la cola llega a él, que puede ser cualquier
      // hora, y la ventana de silencio se aplica AQUÍ, en el encolado. Es el
      // único sitio donde puede aplicarse.
      await pool.query(
        `insert into app_private.job_queue (household_id, job_type, payload, run_at)
         values ($1, $2, $3::jsonb, app.push_run_at(statement_timestamp()))`,
        [
          householdId,
          PUSH_NOTICE_JOB,
          JSON.stringify({ topic: "settlement.receipt_ready", settlementId }),
        ],
      );
    },
    resolveTargets: async (householdId, settlementId, topic) => {
      const result = await pool.query<{
        subscription_id: string;
        endpoint: string;
        p256dh: string;
        auth: string;
        agreement_id: string;
        period_start: string;
        due_on: string;
      }>(
        `select subscription_id, endpoint, p256dh, auth, agreement_id,
                period_start::text as period_start, due_on::text as due_on
           from app_private.push_notice_targets($1, $2, $3)`,
        [householdId, settlementId, topic],
      );
      return result.rows.map((row) => ({
        subscriptionId: row.subscription_id,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        agreementId: row.agreement_id,
        periodStart: row.period_start,
        dueOn: row.due_on,
      }));
    },
    recordDelivery: async (subscriptionId, delivered, gone) => {
      await pool.query("select app_private.push_delivery_recorded($1, $2, $3)", [
        subscriptionId,
        delivered,
        gone,
      ]);
    },
    rescheduleSettlementDue: async ({ householdId, settlementId, repeat, afterDays }) => {
      // `app.push_run_at` aplica la ventana de silencio también al reaviso: no
      // hay ninguna vía por la que un aviso salga fuera de hora, tampoco la de
      // «ya estaba encolado desde antes».
      await pool.query(
        `insert into app_private.job_queue (household_id, job_type, payload, run_at)
         values ($1, $2, $3::jsonb,
                 app.push_run_at(statement_timestamp() + make_interval(days => $4)))`,
        [
          householdId,
          PUSH_NOTICE_JOB,
          JSON.stringify({ topic: "settlement.due", settlementId, repeat }),
          afterDays,
        ],
      );
    },
  };
}
