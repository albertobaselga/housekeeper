import { describe, expect, it } from "vitest";

import {
  PUSH_TOPICS,
  PUSH_TTL_SECONDS,
  SETTLEMENT_DUE_MAX_REPEATS,
  composeNotice,
  createPushNoticeHandler,
  isGoneStatus,
  loadVapidConfig,
  parsePushNoticePayload,
  type PushSendOutcome,
  type PushTarget,
} from "./push.js";
import { PermanentJobError, type ClaimedJob } from "./queue.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const SETTLEMENT = "12b00000-0000-4000-8000-000000000001";
const AGREEMENT = "12000000-0000-4000-8000-000000000001";
const TODAY = new Date("2026-07-02T10:00:00Z");

function target(overrides: Partial<PushTarget> = {}): PushTarget {
  return {
    subscriptionId: "fa200000-0000-4000-8000-000000000001",
    endpoint: "https://push.ejemplo.test/uno",
    p256dh: "clave-publica",
    auth: "secreto",
    agreementId: AGREEMENT,
    periodStart: "2026-06-01",
    dueOn: "2026-07-05",
    ...overrides,
  };
}

function noticeJob(payload: unknown): ClaimedJob {
  return { id: "job-1", householdId: HOUSEHOLD, type: "notification.push", payload, attempts: 1 };
}

describe("catálogo de avisos", () => {
  // Esta prueba es la que sostiene la frase que se le enseña a la empleada en
  // «Tu cuenta»: «lo que nunca te vamos a mandar… la app no sabe hacerlo». Si
  // alguien añade un tópico, esto falla y le obliga a leer docs/notificaciones.md
  // §6 antes de seguir. Mismo trato que se le dio al AC-26. El catálogo pasó de
  // dos a TRES con el Frente D (`settlement.close_due`, migración 0034): sigue
  // cerrado, solo que ahora con un aviso más.
  it("tiene exactamente tres avisos y ninguno de tareas, recuentos ni presencia", () => {
    expect([...PUSH_TOPICS]).toEqual(["settlement.receipt_ready", "settlement.due", "settlement.close_due"]);
  });

  it("rechaza como fallo permanente cualquier aviso fuera del catálogo", () => {
    for (const forbidden of [
      "routine.due", // recordatorio de tarea hacia quien trabaja
      "routine.streak", // recuento de trabajo
      "presence.seen", // presencia
      "settlement.not_confirmed", // disparado por la AUSENCIA de una acción
      "product.news", // relleno
    ]) {
      expect(() => parsePushNoticePayload({ topic: forbidden, settlementId: SETTLEMENT }))
        .toThrow(PermanentJobError);
    }
  });

  it("exige un identificador de liquidación con forma de uuid", () => {
    expect(() => parsePushNoticePayload({ topic: "settlement.due" })).toThrow(PermanentJobError);
    expect(() => parsePushNoticePayload({ topic: "settlement.due", settlementId: "12b00000" }))
      .toThrow(PermanentJobError);
    expect(parsePushNoticePayload({ topic: "settlement.due", settlementId: SETTLEMENT }))
      .toEqual({ topic: "settlement.due", settlementId: SETTLEMENT, repeat: 0 });
  });

  // El tercer aviso es del hogar y del mes, no de una liquidación: al revés que
  // los otros dos, llevar un settlementId es el error.
  it("el aviso de cierre de mes NO lleva settlementId", () => {
    expect(parsePushNoticePayload({ topic: "settlement.close_due" }))
      .toEqual({ topic: "settlement.close_due", settlementId: null, repeat: 0 });
    expect(() => parsePushNoticePayload({ topic: "settlement.close_due", settlementId: SETTLEMENT }))
      .toThrow(PermanentJobError);
  });
});

describe("el texto de un aviso", () => {
  const receipt = composeNotice("settlement.receipt_ready", target(), HOUSEHOLD, TODAY);
  const due = composeNotice("settlement.due", target(), HOUSEHOLD, TODAY);
  // El tercer aviso no lleva PushTarget de verdad (push_close_due_targets no
  // trae agreementId/periodStart/dueOn): un objeto sin esos tres campos basta,
  // y sirve para demostrar que composeNotice no los necesita para este tópico.
  const closeDue = composeNotice(
    "settlement.close_due",
    { subscriptionId: "fb300000-0000-4000-8000-000000000001", endpoint: "https://push.ejemplo.test/cierre", p256dh: "clave-publica", auth: "secreto" },
    HOUSEHOLD,
    TODAY,
  );

  it("dice de qué tipo es y dónde mirar, nunca el dato", () => {
    expect(receipt.title).toBe("El recibo de junio ya está");
    expect(receipt.body).toBe("Puedes verlo y confirmar el cobro cuando quieras.");
    expect(due.title).toBe("La cuenta de junio está sin pagar");
    expect(due.body).toBe("Vence el 5 de julio. El importe se ve al abrir.");
  });

  it("el aviso de cierre habla del mes en curso, sin acuerdo ni persona concreta", () => {
    // TODAY = 2026-07-02: el mes en curso es julio, no el periodo del target.
    expect(closeDue.title).toBe("Julio está a punto de acabar");
    expect(closeDue.body).toBe("El mes se acaba: toca cerrar la cuenta y preparar el pago.");
    expect(closeDue.url).toBe(`/h/${HOUSEHOLD}/employment`);
    expect(closeDue.url).not.toContain("?empleada=");
  });

  // La regla dura de docs/notificaciones.md §5.4, convertida en aserción: el
  // texto se dibuja en la pantalla de bloqueo, sin sesión y sin desbloquear el
  // teléfono, delante de cualquiera que pase. En un piso donde la administración
  // y quien trabaja comparten cocina, ese es el canal de fuga.
  it("no lleva importes ni nombres propios en ninguna parte", () => {
    for (const notice of [receipt, due, closeDue]) {
      const visible = `${notice.title} ${notice.body}`;
      // Ni dígitos de dinero, ni el símbolo, ni la palabra.
      expect(visible).not.toMatch(/\d[\d.,]*\s*(?:€|eur)/i);
      expect(visible).not.toMatch(/€/);
      expect(visible).not.toMatch(/\beuros?\b/i);
      // Ni la cifra suelta: los únicos números permitidos son días del mes.
      expect(visible).not.toMatch(/\d{3,}/);
    }
  });

  it("habla del hecho y no da órdenes al teléfono de nadie", () => {
    // «Hay una cuenta sin pagar» sí; «paga la cuenta» no. El sujeto es el hecho
    // o la casa, nunca «tú» en imperativo.
    for (const notice of [receipt, due, closeDue]) {
      expect(notice.title).not.toMatch(/^(?:confirma|paga|revisa|entra|abre|recuerda)\b/i);
    }
  });

  it("aterriza en la pestaña de pagos, que es donde está lo que el aviso promete", () => {
    // El recibo archivado y el botón de confirmar el cobro viven en
    // `employment/pagos`; la portada de Contrato no hace ninguna de las dos
    // cosas desde que el expediente se repartió en pestañas. Un aviso que
    // promete un recibo y deja a la persona en otra pantalla es peor que no
    // mandarlo. Y con `?empleada=`, que en una casa puede trabajar más de una.
    expect(receipt.url).toBe(`/h/${HOUSEHOLD}/employment/pagos?empleada=${AGREEMENT}`);
    expect(due.url).toBe(receipt.url);
  });

  it("agrupa por asunto con una etiqueta que la norma admite", () => {
    // RFC 8030: la cabecera `Topic` es alfabeto de base64url y ≤ 32 caracteres.
    for (const notice of [receipt, due, closeDue]) {
      expect(notice.tag).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
    // Y distingue los tres asuntos: no deben sustituirse unos a otros.
    expect(receipt.tag).not.toBe(due.tag);
    expect(closeDue.tag).not.toBe(receipt.tag);
    expect(closeDue.tag).not.toBe(due.tag);
    expect(closeDue.tag).toBe("cierre-2026-07");
  });

  it("sin datos de acuerdo, los otros dos avisos fallan alto y claro (error de programación, no de negocio)", () => {
    const { agreementId: _agreementId, ...withoutAgreement } = target();
    expect(() => composeNotice("settlement.due", withoutAgreement, HOUSEHOLD, TODAY))
      .toThrow(/sin datos de acuerdo/);
  });

  it("añade el año solo cuando el periodo no es del año que corre", () => {
    const oldOne = composeNotice(
      "settlement.receipt_ready",
      target({ periodStart: "2025-11-01" }),
      HOUSEHOLD,
      TODAY,
    );
    expect(oldOne.title).toBe("El recibo de noviembre de 2025 ya está");
  });
});

describe("configuración VAPID", () => {
  const keys = { VAPID_PUBLIC_KEY: "BPublica", VAPID_PRIVATE_KEY: "Privada" };

  it("no existe si falta cualquiera de las tres piezas", () => {
    expect(loadVapidConfig({})).toBeNull();
    expect(loadVapidConfig({ ...keys })).toBeNull();
    expect(loadVapidConfig({ VAPID_SUBJECT: "mailto:casa@ejemplo.es" })).toBeNull();
  });

  // La trampa de estreno de §5.5: Apple contesta 403 BadJwtToken con espacios,
  // corchetes angulares o dominios inválidos, y **solo Apple**. Un `sub` sucio
  // deja los avisos rotos en los iPhone de la casa y en ningún otro sitio, que
  // es el peor fallo posible: el que solo le pasa a una persona.
  //
  // Esta lista tiene gemela en `apps/web/tests/push.test.ts`: el criterio es uno
  // solo (`push-channel.ts`) y las dos pruebas existen para que siga siéndolo.
  // Cuando no lo era, la web dibujaba el interruptor de unos avisos que la cola
  // jamás iba a mandar.
  it("rechaza un `sub` que solo fallaría en los iPhone", () => {
    for (const dirty of [
      "<mailto:casa@ejemplo.es>",
      "mailto: casa@ejemplo.es",
      "casa@ejemplo.es",
      "http://casa.ejemplo.es",
      "mailto:casa@localhost",
    ]) {
      expect(loadVapidConfig({ ...keys, VAPID_SUBJECT: dirty })).toBeNull();
    }
  });

  it("acepta un mailto o un https limpios", () => {
    expect(loadVapidConfig({ ...keys, VAPID_SUBJECT: "mailto:casa@ejemplo.es" }))
      .toEqual({ subject: "mailto:casa@ejemplo.es", publicKey: "BPublica", privateKey: "Privada" });
    expect(loadVapidConfig({ ...keys, VAPID_SUBJECT: " https://casa.ejemplo.es " })?.subject)
      .toBe("https://casa.ejemplo.es");
  });
});

describe("entrega", () => {
  it("da por muerto un endpoint solo con 404 o 410", () => {
    expect(isGoneStatus(404)).toBe(true);
    expect(isGoneStatus(410)).toBe(true);
    // 429 es «ahora no»; 500 y 503 son del día; 413 es un payload demasiado
    // grande. Ninguno significa que el teléfono haya desaparecido.
    for (const transient of [429, 500, 503, 413, undefined]) {
      expect(isGoneStatus(transient)).toBe(false);
    }
  });

  it("retiene poco: un aviso que no llegó en cuatro horas se pierde antes que sonar de madrugada", () => {
    expect(PUSH_TTL_SECONDS).toBe(14_400);
  });
});

interface Recorded {
  subscriptionId: string;
  delivered: boolean;
  gone: boolean;
}

function handlerWith(options: {
  targets: PushTarget[];
  outcomes?: PushSendOutcome[];
  sent?: string[];
  recorded?: Recorded[];
  rescheduled?: unknown[];
}) {
  let call = 0;
  return createPushNoticeHandler({
    resolveTargets: async () => options.targets,
    send: async ({ target: to }) => {
      options.sent?.push(to.endpoint);
      return options.outcomes?.[call++] ?? { delivered: true };
    },
    recordDelivery: async (subscriptionId, delivered, gone) => {
      options.recorded?.push({ subscriptionId, delivered, gone });
    },
    rescheduleSettlementDue: async (input) => {
      options.rescheduled?.push(input);
    },
    today: async () => TODAY,
    now: () => TODAY,
  });
}

describe("el trabajo notification.push", () => {
  it("con cero destinatarios completa sin efectos: es el caso normal, no un fallo", async () => {
    const sent: string[] = [];
    const rescheduled: unknown[] = [];
    const handler = handlerWith({ targets: [], sent, rescheduled });

    await expect(
      handler(noticeJob({ topic: "settlement.due", settlementId: SETTLEMENT })),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    // Y sin destinatarios tampoco se reaviva la escalada: si nadie recibe, el
    // hecho desapareció (se pagó, se anuló, se retiró el acceso) o no hay canal.
    expect(rescheduled).toEqual([]);
  });

  it("una entrega fallida no tumba el trabajo ni repite la que sí llegó", async () => {
    const sent: string[] = [];
    const recorded: Recorded[] = [];
    const handler = handlerWith({
      targets: [
        target({ subscriptionId: "s-1", endpoint: "https://push.ejemplo.test/uno" }),
        target({ subscriptionId: "s-2", endpoint: "https://push.ejemplo.test/dos" }),
      ],
      outcomes: [{ delivered: true }, { delivered: false, gone: true }],
      sent,
      recorded,
    });

    await handler(noticeJob({ topic: "settlement.receipt_ready", settlementId: SETTLEMENT }));

    // Reintentar el trabajo entero por el segundo teléfono le mandaría el aviso
    // dos veces al primero. Aquí una vibración de más es peor que una de menos.
    expect(sent).toEqual(["https://push.ejemplo.test/uno", "https://push.ejemplo.test/dos"]);
    expect(recorded).toEqual([
      { subscriptionId: "s-1", delivered: true, gone: false },
      { subscriptionId: "s-2", delivered: false, gone: true },
    ]);
  });

  it("la cuenta pendiente se reavisa cada tres días, y deja de hacerlo", async () => {
    const rescheduled: Array<{ repeat: number; afterDays: number }> = [];
    const handler = handlerWith({ targets: [target()], rescheduled });

    await handler(noticeJob({ topic: "settlement.due", settlementId: SETTLEMENT }));
    expect(rescheduled).toEqual([
      { householdId: HOUSEHOLD, settlementId: SETTLEMENT, repeat: 1, afterDays: 3 },
    ]);

    // El último permitido reaviva; el siguiente ya no. Sin tope, este trabajo se
    // multiplicaba solo, que es uno de los motivos escritos de su retirada en la
    // migración 0029.
    rescheduled.length = 0;
    await handler(
      noticeJob({
        topic: "settlement.due",
        settlementId: SETTLEMENT,
        repeat: SETTLEMENT_DUE_MAX_REPEATS - 1,
      }),
    );
    expect(rescheduled).toHaveLength(1);

    rescheduled.length = 0;
    await handler(
      noticeJob({
        topic: "settlement.due",
        settlementId: SETTLEMENT,
        repeat: SETTLEMENT_DUE_MAX_REPEATS,
      }),
    );
    expect(rescheduled).toEqual([]);
  });

  it("el recibo no escala nunca: una vez y calla", async () => {
    const rescheduled: unknown[] = [];
    const handler = handlerWith({ targets: [target()], rescheduled });

    await handler(noticeJob({ topic: "settlement.receipt_ready", settlementId: SETTLEMENT }));

    // La escalada solo existe hacia quien puede resolver el asunto. Repetirle a
    // la empleada algo que no está en su mano es acoso de bajo nivel, y su aviso
    // no pide nada: cuenta que su recibo ya existe.
    expect(rescheduled).toEqual([]);
  });

  it("el aviso de cierre de mes tampoco escala: una vez y calla, sin settlementId que reencolar", async () => {
    const sent: string[] = [];
    const recorded: Recorded[] = [];
    const rescheduled: unknown[] = [];
    // El destinatario de este tópico no trae agreementId/periodStart/dueOn:
    // push_close_due_targets no los devuelve, así que aquí tampoco se simulan.
    const closeDueTarget: PushTarget = {
      subscriptionId: "fb300000-0000-4000-8000-000000000001",
      endpoint: "https://push.ejemplo.test/cierre-admin",
      p256dh: "clave-publica",
      auth: "secreto",
    };
    const handler = handlerWith({ targets: [closeDueTarget], sent, recorded, rescheduled });

    await expect(handler(noticeJob({ topic: "settlement.close_due" }))).resolves.toBeUndefined();

    expect(sent).toEqual(["https://push.ejemplo.test/cierre-admin"]);
    expect(recorded).toEqual([
      { subscriptionId: "fb300000-0000-4000-8000-000000000001", delivered: true, gone: false },
    ]);
    expect(rescheduled).toEqual([]);
  });

  it("el aviso de cierre con cero destinatarios completa sin efectos", async () => {
    const handler = handlerWith({ targets: [] });
    await expect(handler(noticeJob({ topic: "settlement.close_due" }))).resolves.toBeUndefined();
  });
});
