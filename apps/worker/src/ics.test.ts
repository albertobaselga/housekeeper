import { describe, expect, it } from "vitest";

import { PermanentJobError, type ClaimedJob } from "./queue.js";
import {
  ICS_SYNC_ALL_JOB,
  ICS_SYNC_INTERVAL_HOURS,
  ICS_SYNC_JOB,
  ROUTINE_DUE_JOB,
  createIcsSyncAllHandler,
  createIcsSyncHandler,
  createRoutineDueHandler,
  expandIcs,
  fetchIcsSource,
  parseSimpleRrule,
  type IcsEnqueueInput,
  type IcsOccurrence,
  type ResolvedAddress,
} from "./ics.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const OLIVO = "20000000-0000-4000-8000-000000000001";
const ROUTINE = "13000000-0000-4000-8000-0000000000aa";
const SOURCE = "14000000-0000-4000-8000-0000000000bb";

// «Ahora» estable para las ventanas de expansión de los tests.
const NOW = new Date("2027-08-30T12:00:00Z");

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:reunion@example.com",
  "DTSTART:20270901T090000Z",
  "DTEND:20270901T100000Z",
  // Línea plegada RFC 5545: el desplegado quita CRLF + UN espacio; el segundo
  // espacio pertenece al texto original.
  "SUMMARY:Reunión de padres",
  "  y madres",
  "LOCATION:Colegio San Blas",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:excursion@example.com",
  "DTSTART;VALUE=DATE:20270905",
  "SUMMARY:Excursión\\, otoño",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function makeLookup(map: Record<string, string[]>): (hostname: string) => Promise<ResolvedAddress[]> {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`sin DNS para ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

function icsResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/calendar" } });
}

describe("fetchIcsSource: protección SSRF", () => {
  it("rechaza URLs que no sean https sin tocar la red", async () => {
    let fetched = 0;
    await expect(
      fetchIcsSource("http://calendario.example.com/x.ics", {
        lookup: makeLookup({ "calendario.example.com": ["93.184.216.34"] }),
        fetchImpl: async () => {
          fetched += 1;
          return icsResponse(SAMPLE_ICS);
        },
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(fetched).toBe(0);
  });

  it.each([
    ["https://127.0.0.1/cal.ics", { "127.0.0.1": ["127.0.0.1"] }],
    ["https://intranet.example.com/cal.ics", { "intranet.example.com": ["10.20.30.40"] }],
    ["https://169.254.169.254/latest/meta-data", { "169.254.169.254": ["169.254.169.254"] }],
    ["https://nas.example.com/cal.ics", { "nas.example.com": ["192.168.1.5"] }],
    ["https://vpn.example.com/cal.ics", { "vpn.example.com": ["172.16.0.9"] }],
    ["https://dual.example.com/cal.ics", { "dual.example.com": ["93.184.216.34", "10.0.0.8"] }],
    ["https://v6.example.com/cal.ics", { "v6.example.com": ["fd12:3456::1"] }],
    ["https://loop6.example.com/cal.ics", { "loop6.example.com": ["::1"] }],
  ])("rechaza %s por resolver a una dirección no pública", async (url, dns) => {
    let fetched = 0;
    await expect(
      fetchIcsSource(url, {
        lookup: makeLookup(dns),
        fetchImpl: async () => {
          fetched += 1;
          return icsResponse(SAMPLE_ICS);
        },
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(fetched).toBe(0);
  });

  it("no sigue una redirección hacia un host privado", async () => {
    const urls: string[] = [];
    await expect(
      fetchIcsSource("https://publico.example.com/cal.ics", {
        lookup: makeLookup({
          "publico.example.com": ["93.184.216.34"],
          "interno.example.com": ["192.168.7.7"],
        }),
        fetchImpl: async (url) => {
          urls.push(url);
          return new Response(null, {
            status: 302,
            headers: { location: "https://interno.example.com/cal.ics" },
          });
        },
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    // Solo se contactó el host público original; el destino privado nunca.
    expect(urls).toEqual(["https://publico.example.com/cal.ics"]);
  });

  it("corta tras el máximo de redirecciones aunque todas sean públicas", async () => {
    let fetched = 0;
    await expect(
      fetchIcsSource("https://publico.example.com/cal.ics", {
        lookup: makeLookup({ "publico.example.com": ["93.184.216.34"] }),
        fetchImpl: async () => {
          fetched += 1;
          return new Response(null, {
            status: 302,
            headers: { location: "https://publico.example.com/otra.ics" },
          });
        },
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(fetched).toBe(4); // original + 3 redirecciones permitidas
  });

  it("rechaza cuerpos por encima del tamaño máximo", async () => {
    await expect(
      fetchIcsSource("https://publico.example.com/cal.ics", {
        lookup: makeLookup({ "publico.example.com": ["93.184.216.34"] }),
        maxBytes: 64,
        fetchImpl: async () => icsResponse(SAMPLE_ICS),
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("acepta un https público, sigue una redirección revalidada y expande los eventos", async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const events = await fetchIcsSource("https://publico.example.com/cal.ics", {
      now: () => NOW,
      lookup: makeLookup({
        "publico.example.com": ["93.184.216.34"],
        "cdn.example.net": ["203.0.113.10"],
      }),
      fetchImpl: async (url, init) => {
        calls.push({ url, redirect: init.redirect });
        if (url === "https://publico.example.com/cal.ics") {
          return new Response(null, {
            status: 301,
            headers: { location: "https://cdn.example.net/cal.ics" },
          });
        }
        return icsResponse(SAMPLE_ICS);
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://publico.example.com/cal.ics",
      "https://cdn.example.net/cal.ics",
    ]);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(events.map(({ uid, startsAt, summary }) => ({ uid, startsAt, summary }))).toEqual([
      { uid: "reunion@example.com", startsAt: "2027-09-01T09:00:00.000Z", summary: "Reunión de padres y madres" },
      // Día completo: medianoche de Madrid (CEST, +2 en septiembre).
      { uid: "excursion@example.com", startsAt: "2027-09-04T22:00:00.000Z", summary: "Excursión, otoño" },
    ]);
  });
});

describe("expandIcs: parser y zonas horarias", () => {
  it("extrae UID/DTSTART/DTEND/SUMMARY/LOCATION con líneas plegadas y escapes", () => {
    const events = expandIcs(SAMPLE_ICS, NOW);
    expect(events).toHaveLength(2);
    const [meeting, trip] = events as [IcsOccurrence, IcsOccurrence];
    expect(meeting).toMatchObject({
      uid: "reunion@example.com",
      startsAt: "2027-09-01T09:00:00.000Z",
      endsAt: "2027-09-01T10:00:00.000Z",
      allDay: false,
      summary: "Reunión de padres y madres",
      location: "Colegio San Blas",
    });
    expect(meeting.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(trip.allDay).toBe(true);
    expect(trip.endsAt).toBeNull();
    // El hash es estable: dos expansiones del mismo contenido coinciden.
    expect(expandIcs(SAMPLE_ICS, NOW)).toEqual(events);
  });

  it("convierte TZID de pared a UTC y trata la hora flotante como hora del hogar", () => {
    const text = [
      "BEGIN:VEVENT",
      "UID:tz@example.com",
      "DTSTART;TZID=America/New_York:20270901T090000",
      "SUMMARY:Llamada",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:flotante@example.com",
      "DTSTART:20270901T090000",
      "SUMMARY:Hora local",
      "END:VEVENT",
    ].join("\n");
    const [call, floating] = expandIcs(text, NOW) as [IcsOccurrence, IcsOccurrence];
    expect(call.startsAt).toBe("2027-09-01T13:00:00.000Z"); // EDT −4
    expect(floating.startsAt).toBe("2027-09-01T07:00:00.000Z"); // Madrid CEST +2
  });

  it("un TZID desconocido degrada a la zona del hogar", () => {
    const text = [
      "BEGIN:VEVENT",
      "UID:raro@example.com",
      "DTSTART;TZID=Marte/Olympus:20270901T090000",
      "SUMMARY:Zona inexistente",
      "END:VEVENT",
    ].join("\n");
    expect(expandIcs(text, NOW)[0]?.startsAt).toBe("2027-09-01T07:00:00.000Z");
  });

  it("descarta eventos sin fecha o sin título y sintetiza uid estable si falta", () => {
    const text = [
      "BEGIN:VTODO",
      "SUMMARY:No soy un evento",
      "END:VTODO",
      "BEGIN:VEVENT",
      "SUMMARY:Sin fecha",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20270901T080000Z",
      "SUMMARY:Sin uid",
      "END:VEVENT",
    ].join("\n");
    const events = expandIcs(text, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toMatch(/^sin-uid-[0-9a-f]{32}$/);
    expect(events[0]?.uid).toBe(expandIcs(text, NOW)[0]?.uid);
  });

  it("solo conserva ocurrencias dentro de la ventana [ahora−7d, ahora+90d]", () => {
    const text = [
      "BEGIN:VEVENT",
      "UID:pasado@example.com",
      "DTSTART:20270801T090000Z", // hace 29 días: fuera
      "SUMMARY:Pasado lejano",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:encurso@example.com",
      "DTSTART:20270820T090000Z", // empezó antes de la ventana…
      "DTEND:20270825T090000Z", // …pero seguía en curso dentro de ella
      "SUMMARY:Obras en casa",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:lejos@example.com",
      "DTSTART:20280101T090000Z", // a más de 90 días: fuera
      "SUMMARY:Futuro lejano",
      "END:VEVENT",
    ].join("\n");
    expect(expandIcs(text, NOW).map((event) => event.uid)).toEqual(["encurso@example.com"]);
  });
});

describe("expandIcs: recurrencias simples", () => {
  it("DAILY con COUNT y EXDATE, manteniendo la hora de pared al cruzar el cambio de hora", () => {
    // El 31/10/2027 Madrid pasa de CEST (+2) a CET (+1).
    const text = [
      "BEGIN:VEVENT",
      "UID:diaria@example.com",
      "DTSTART;TZID=Europe/Madrid:20271030T090000",
      "DTEND;TZID=Europe/Madrid:20271030T093000",
      "RRULE:FREQ=DAILY;COUNT=4",
      "EXDATE;TZID=Europe/Madrid:20271101T090000",
      "SUMMARY:Medicación",
      "END:VEVENT",
    ].join("\n");
    const events = expandIcs(text, new Date("2027-10-28T12:00:00Z"));
    expect(events.map((event) => event.startsAt)).toEqual([
      "2027-10-30T07:00:00.000Z", // 09:00 CEST
      "2027-10-31T08:00:00.000Z", // 09:00 CET: la hora de pared no se mueve
      // 01/11 excluida por EXDATE
      "2027-11-02T08:00:00.000Z",
    ]);
    expect(events[1]?.endsAt).toBe("2027-10-31T08:30:00.000Z");
  });

  it("WEEKLY con BYDAY y UNTIL inclusivo", () => {
    const text = [
      "BEGIN:VEVENT",
      "UID:semanal@example.com",
      "DTSTART;TZID=Europe/Madrid:20260803T170000", // lunes
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260812T220000Z",
      "SUMMARY:Natación",
      "END:VEVENT",
    ].join("\n");
    const events = expandIcs(text, new Date("2026-08-03T00:00:00Z"));
    expect(events.map((event) => event.startsAt)).toEqual([
      "2026-08-03T15:00:00.000Z", // lunes 3
      "2026-08-05T15:00:00.000Z", // miércoles 5
      "2026-08-10T15:00:00.000Z", // lunes 10
      "2026-08-12T15:00:00.000Z", // miércoles 12 (UNTIL lo cubre)
    ]);
  });

  it("MONTHLY por día del mes salta los meses sin ese día", () => {
    const text = [
      "BEGIN:VEVENT",
      "UID:mensual@example.com",
      "DTSTART:20260131T100000Z",
      "RRULE:FREQ=MONTHLY;COUNT=3",
      "SUMMARY:Repaso caldera",
      "END:VEVENT",
    ].join("\n");
    const events = expandIcs(text, new Date("2026-01-28T00:00:00Z"));
    // Febrero y abril no tienen día 31: quedan enero y marzo dentro de ventana.
    expect(events.map((event) => event.startsAt)).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z",
    ]);
  });

  it("una RRULE fuera del subconjunto degrada a la ocurrencia base", () => {
    const text = [
      "BEGIN:VEVENT",
      "UID:anual@example.com",
      "DTSTART:20270901T100000Z",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:Aniversario",
      "END:VEVENT",
    ].join("\n");
    expect(expandIcs(text, NOW).map((event) => event.startsAt)).toEqual(["2027-09-01T10:00:00.000Z"]);
  });

  it.each([
    ["FREQ=HOURLY", null],
    ["FREQ=MONTHLY;BYDAY=1MO", null],
    ["FREQ=MONTHLY;BYSETPOS=-1", null],
    ["FREQ=WEEKLY;BYDAY=XX", null],
  ])("parseSimpleRrule rechaza %s", (raw, expected) => {
    expect(parseSimpleRrule(raw)).toBe(expected);
  });
});

describe("notification.routine_due", () => {
  function dueJob(payload: unknown): ClaimedJob {
    return { id: "job-routine", householdId: HOUSEHOLD, type: ROUTINE_DUE_JOB, payload, attempts: 1 };
  }

  it("envía el aviso a cada destinatario del payload, sin duplicados", async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const handler = createRoutineDueHandler({
      sendEmail: async (input) => {
        sent.push(input);
      },
    });
    await handler(
      dueJob({
        routineId: ROUTINE,
        title: "Cambiar filtros",
        audience: "family",
        recipients: ["admin.roble@example.com", "familiar.roble@example.com", "admin.roble@example.com"],
      }),
    );
    expect(sent.map((email) => email.to)).toEqual([
      "admin.roble@example.com",
      "familiar.roble@example.com",
    ]);
    for (const email of sent) {
      expect(email.subject).toContain("Cambiar filtros");
      expect(email.text).toContain("Cambiar filtros");
    }
  });

  it("una lista de destinatarios vacía completa sin enviar nada", async () => {
    let sent = 0;
    const handler = createRoutineDueHandler({
      sendEmail: async () => {
        sent += 1;
      },
    });
    await handler(dueJob({ routineId: ROUTINE, title: "Regar", audience: "all", recipients: [] }));
    expect(sent).toBe(0);
  });

  it.each([
    [{}],
    [{ routineId: ROUTINE, title: "x", audience: "family" }],
    [{ routineId: ROUTINE, title: "x", audience: "vecinos", recipients: [] }],
    [{ routineId: ROUTINE, title: "  ", audience: "all", recipients: [] }],
    [{ routineId: ROUTINE, title: "x", audience: "all", recipients: ["ok@example.com", 7] }],
  ])("payload inválido %# es fallo permanente sin enviar", async (payload) => {
    let sent = 0;
    const handler = createRoutineDueHandler({
      sendEmail: async () => {
        sent += 1;
      },
    });
    await expect(handler(dueJob(payload))).rejects.toBeInstanceOf(PermanentJobError);
    expect(sent).toBe(0);
  });
});

describe("ics.sync_source", () => {
  function syncJob(payload: unknown): ClaimedJob {
    return { id: "job-ics", householdId: HOUSEHOLD, type: ICS_SYNC_JOB, payload, attempts: 1 };
  }

  it("descarga, persiste las ocurrencias y registra la sincronización sin error", async () => {
    const persisted: Array<{ sourceId: string; count: number }> = [];
    const recorded: string[] = [];
    const handler = createIcsSyncHandler({
      fetchSource: async (url) => {
        expect(url).toBe("https://calendario.example.com/colegio.ics");
        return expandIcs(SAMPLE_ICS, NOW);
      },
      persistEvents: async (householdId, sourceId, events) => {
        expect(householdId).toBe(HOUSEHOLD);
        persisted.push({ sourceId, count: events.length });
      },
      recordSync: async (_householdId, _sourceId, error) => {
        recorded.push(error);
      },
    });
    await handler(syncJob({ sourceId: SOURCE, url: "https://calendario.example.com/colegio.ics" }));
    expect(persisted).toEqual([{ sourceId: SOURCE, count: 2 }]);
    expect(recorded).toEqual([""]);
  });

  it("con clear no toca la red y vacía los eventos de la fuente", async () => {
    let fetched = 0;
    const persisted: Array<{ sourceId: string; count: number }> = [];
    const handler = createIcsSyncHandler({
      fetchSource: async () => {
        fetched += 1;
        return [];
      },
      persistEvents: async (_householdId, sourceId, events) => {
        persisted.push({ sourceId, count: events.length });
      },
      recordSync: async () => {},
    });
    await handler(
      syncJob({ sourceId: SOURCE, url: "https://calendario.example.com/colegio.ics", clear: true }),
    );
    expect(fetched).toBe(0);
    expect(persisted).toEqual([{ sourceId: SOURCE, count: 0 }]);
  });

  it("un fallo de descarga queda anotado en la fuente y el job se relanza", async () => {
    const recorded: string[] = [];
    const handler = createIcsSyncHandler({
      fetchSource: async () => {
        throw new Error("La fuente ICS respondió 404");
      },
      persistEvents: async () => {
        throw new Error("no debería persistir nada");
      },
      recordSync: async (_householdId, _sourceId, error) => {
        recorded.push(error);
      },
    });
    await expect(
      handler(syncJob({ sourceId: SOURCE, url: "https://calendario.example.com/colegio.ics" })),
    ).rejects.toThrow("La fuente ICS respondió 404");
    expect(recorded).toEqual(["La fuente ICS respondió 404"]);
  });

  it.each([[{}], [{ sourceId: SOURCE }], [{ sourceId: SOURCE, url: "http://inseguro.example.com" }]])(
    "payload inválido %# es fallo permanente sin tocar la red",
    async (payload) => {
      let fetched = 0;
      const handler = createIcsSyncHandler({
        fetchSource: async () => {
          fetched += 1;
          return [];
        },
        persistEvents: async () => {},
        recordSync: async () => {},
      });
      await expect(handler(syncJob(payload))).rejects.toBeInstanceOf(PermanentJobError);
      expect(fetched).toBe(0);
    },
  );
});

describe("ics.sync_all", () => {
  it("encola un sync_source por fuente activa y se re-encola a +6 horas", async () => {
    const enqueued: IcsEnqueueInput[] = [];
    const now = new Date("2026-08-08T06:00:00Z");
    const handler = createIcsSyncAllHandler({
      listSources: async () => [
        { householdId: HOUSEHOLD, sourceId: SOURCE, url: "https://calendario.example.com/roble.ics" },
        { householdId: OLIVO, sourceId: "24000000-0000-4000-8000-0000000000cc", url: "https://calendario.example.com/olivo.ics" },
      ],
      enqueue: async (input) => {
        enqueued.push(input);
      },
      now: () => now,
    });
    await handler({ id: "job-all", householdId: HOUSEHOLD, type: ICS_SYNC_ALL_JOB, payload: {}, attempts: 1 });
    expect(enqueued).toHaveLength(3);
    expect(enqueued[0]).toEqual({
      householdId: HOUSEHOLD,
      type: ICS_SYNC_JOB,
      payload: { sourceId: SOURCE, url: "https://calendario.example.com/roble.ics" },
      runAt: now,
    });
    expect(enqueued[1]?.householdId).toBe(OLIVO);
    const requeue = enqueued[2]!;
    expect(requeue.type).toBe(ICS_SYNC_ALL_JOB);
    expect(requeue.runAt.getTime() - now.getTime()).toBe(ICS_SYNC_INTERVAL_HOURS * 3_600_000);
  });

  it("sin fuentes activas solo se re-encola a sí mismo", async () => {
    const enqueued: IcsEnqueueInput[] = [];
    const handler = createIcsSyncAllHandler({
      listSources: async () => [],
      enqueue: async (input) => {
        enqueued.push(input);
      },
    });
    await handler({ id: "job-all", householdId: HOUSEHOLD, type: ICS_SYNC_ALL_JOB, payload: {}, attempts: 1 });
    expect(enqueued.map((input) => input.type)).toEqual([ICS_SYNC_ALL_JOB]);
  });
});
