import { describe, expect, it } from "vitest";

import { PermanentJobError, type ClaimedJob } from "./queue.js";
import {
  ICS_SYNC_JOB,
  ROUTINE_DUE_JOB,
  createIcsSyncHandler,
  createRoutineDueHandler,
  fetchIcsSource,
  parseIcs,
  type ResolvedAddress,
} from "./ics.js";

const HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROUTINE = "13000000-0000-4000-8000-0000000000aa";
const SOURCE = "14000000-0000-4000-8000-0000000000bb";

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTART:20270901T090000Z",
  // Línea plegada RFC 5545: el desplegado quita CRLF + UN espacio; el segundo
  // espacio pertenece al texto original.
  "SUMMARY:Reunión de padres",
  "  y madres",
  "END:VEVENT",
  "BEGIN:VEVENT",
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

  it("acepta un https público, sigue una redirección revalidada y parsea los eventos", async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const events = await fetchIcsSource("https://publico.example.com/cal.ics", {
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
    expect(events).toEqual([
      { startsAt: "2027-09-01T09:00:00Z", title: "Reunión de padres y madres" },
      { startsAt: "2027-09-05", title: "Excursión, otoño" },
    ]);
  });
});

describe("parseIcs: parser VEVENT mínimo", () => {
  it("extrae DTSTART y SUMMARY con líneas plegadas, parámetros y escapes", () => {
    expect(parseIcs(SAMPLE_ICS)).toEqual([
      { startsAt: "2027-09-01T09:00:00Z", title: "Reunión de padres y madres" },
      { startsAt: "2027-09-05", title: "Excursión, otoño" },
    ]);
  });

  it("ignora bloques que no son VEVENT y eventos incompletos", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTODO",
      "SUMMARY:No soy un evento",
      "END:VTODO",
      "BEGIN:VEVENT",
      "SUMMARY:Sin fecha",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20271001T080000",
      "SUMMARY:Hora local sin zona",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    expect(parseIcs(text)).toEqual([
      { startsAt: "2027-10-01T08:00:00", title: "Hora local sin zona" },
    ]);
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

  it("descarga la URL del payload y entrega los eventos al hook de persistencia", async () => {
    const persisted: Array<{ sourceId: string; count: number }> = [];
    const handler = createIcsSyncHandler({
      fetchSource: async (url) => {
        expect(url).toBe("https://calendario.example.com/colegio.ics");
        return parseIcs(SAMPLE_ICS);
      },
      persist: async (_householdId, sourceId, events) => {
        persisted.push({ sourceId, count: events.length });
      },
    });
    await handler(syncJob({ sourceId: SOURCE, url: "https://calendario.example.com/colegio.ics" }));
    expect(persisted).toEqual([{ sourceId: SOURCE, count: 2 }]);
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
      });
      await expect(handler(syncJob(payload))).rejects.toBeInstanceOf(PermanentJobError);
      expect(fetched).toBe(0);
    },
  );
});
