import { describe, expect, it } from 'vitest';

import { actions } from '../src/routes/h/[householdId]/employment/alta/+page.server';
import { readHireAgreementTerms, validateHireInput } from '../src/lib/server/staff-hire.server';

/**
 * La lectura del formulario del alta, que hasta ahora no tenía ninguna prueba:
 * las seis de `staff-hire.integration.test.ts` llaman a `hireHouseholdMember`
 * directamente, con los términos ya construidos en TypeScript, así que nadie
 * comprobaba nunca que la pantalla y el servidor se entendieran.
 *
 * Importa desde el punto en que las DOS entradas de la etapa 2 —la persona
 * nueva y la que ya está en la casa esperando contrato— leen exactamente los
 * mismos nombres de campo. Si cada una los leyera por su cuenta, un campo nuevo
 * entraría por una puerta y se perdería por la otra.
 */
function formulario(campos: Record<string, string>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(campos)) form.append(name, value);
  return form;
}

const BASICO = {
  monthlySalary: '1.400,00',
  contractedWeeklyMinutes: '2400',
  annualVacationDays: '30',
  reason: 'Alta desde la aplicación'
};

describe('las condiciones que pacta un alta, leídas del formulario', () => {
  it('lo básico entra en vigor el mismo día que empieza el contrato', () => {
    const result = readHireAgreementTerms(formulario(BASICO), '2026-09-01');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Una sola fecha para las dos cosas: en un alta no hay historia previa que
    // respetar, y pedir dos fechas para decir lo mismo invita a teclear una mal.
    expect(result.terms.effectiveFrom).toBe('2026-09-01');
    expect(result.terms.monthlySalaryCents).toBe('140000');
    expect(result.terms.contractedWeeklyMinutes).toBe(2400);
    expect(result.terms.annualVacationDays).toBe(30);
    // El catálogo de trabajo extra y los complementos se pactan después.
    expect(result.terms.extraWorkTypes).toEqual([]);
    expect(result.terms.supplements).toEqual([]);
    expect(result.terms.schedule).toBeNull();
  });

  it('sin tocar las dos condiciones nuevas, la tarifa es null y la caducidad seis meses', () => {
    const result = readHireAgreementTerms(formulario(BASICO), '2026-09-01');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // null, NUNCA cero: la fila es inmutable, y un cero por omisión dejaría
    // escrito para siempre que se acordó pagar cero euros por día.
    expect(result.terms.unusedVacationDayRateCents).toBeNull();
    expect(result.terms.vacationCarryoverExpiry).toEqual({ mode: 'months', months: 6 });
  });

  it('el campo vacío del precio del día sigue siendo «no se pactó», no un cero', () => {
    const result = readHireAgreementTerms(
      formulario({ ...BASICO, unusedVacationDayRate: '   ' }),
      '2026-09-01'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terms.unusedVacationDayRateCents).toBeNull();
  });

  it('las dos condiciones nuevas se pactan si se quieren pactar', () => {
    const result = readHireAgreementTerms(
      formulario({
        ...BASICO,
        unusedVacationDayRate: '46,15',
        carryoverExpiryMode: 'never'
      }),
      '2026-09-01'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Céntimos exactos: el dinero no pasa por coma flotante ni de camino.
    expect(result.terms.unusedVacationDayRateCents).toBe('4615');
    expect(result.terms.vacationCarryoverExpiry).toEqual({ mode: 'never' });
  });

  it('un margen distinto de meses se guarda tal cual', () => {
    const result = readHireAgreementTerms(
      formulario({ ...BASICO, carryoverExpiryMode: 'months', carryoverExpiryMonths: '12' }),
      '2026-09-01'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terms.vacationCarryoverExpiry).toEqual({ mode: 'months', months: 12 });
  });

  it('los meses de margen sólo se leen cuando los días caducan', () => {
    // «Nunca expiran» no lleva número: el formulario manda el campo igualmente
    // —tiene que existir siempre para poder volver a «meses» sin JavaScript— y
    // el servidor lo ignora, que es donde esa decisión pertenece.
    const nunca = readHireAgreementTerms(
      formulario({ ...BASICO, carryoverExpiryMode: 'never', carryoverExpiryMonths: '6' }),
      '2026-09-01'
    );
    expect(nunca.ok).toBe(true);
    if (!nunca.ok) return;
    expect(nunca.terms.vacationCarryoverExpiry).toEqual({ mode: 'never' });

    // Y con el modo en «meses» y el número borrado no sale un NaN silencioso:
    // sale una frase en castellano que dice qué hacer.
    const sinNumero = readHireAgreementTerms(
      formulario({ ...BASICO, carryoverExpiryMode: 'months', carryoverExpiryMonths: '' }),
      '2026-09-01'
    );
    expect(sinNumero.ok).toBe(false);
    if (sinNumero.ok) return;
    expect(sinNumero.message).toBe(
      'Di qué pasa con los días arrastrados: o caducan pasados unos meses (entre 1 y 120), o no expiran nunca.'
    );
  });

  it('el rechazo del esquema se lee en castellano y dice qué campo', () => {
    // Antes salía «Invalid input: expected number, received NaN» en una
    // aplicación que está en castellano hasta el último aria-label, y sin decir
    // siquiera cuál de los cinco campos numéricos era.
    const jornada = readHireAgreementTerms(
      formulario({ ...BASICO, contractedWeeklyMinutes: '' }),
      '2026-09-01'
    );
    expect(jornada.ok).toBe(false);
    if (jornada.ok) return;
    expect(jornada.message).toBe(
      'La jornada semanal tiene que ser un número de minutos entre 1 y 10.080.'
    );
    expect(jornada.message).not.toMatch(/Invalid|expected|received|NaN/);

    const vacaciones = readHireAgreementTerms(
      formulario({ ...BASICO, annualVacationDays: 'treinta' }),
      '2026-09-01'
    );
    expect(vacaciones.ok).toBe(false);
    if (vacaciones.ok) return;
    expect(vacaciones.message).toBe(
      'Los días de vacaciones al año tienen que ser un número entre 0 y 365.'
    );
  });

  it('un importe que no es un importe se rechaza con una frase, no con un cero', () => {
    const salarioMalo = readHireAgreementTerms(
      formulario({ ...BASICO, monthlySalary: 'mil cuatrocientos' }),
      '2026-09-01'
    );
    expect(salarioMalo).toEqual({
      ok: false,
      message: 'El salario mensual no es un importe válido.'
    });

    const tarifaMala = readHireAgreementTerms(
      formulario({ ...BASICO, unusedVacationDayRate: 'lo que sea' }),
      '2026-09-01'
    );
    expect(tarifaMala.ok).toBe(false);
    if (tarifaMala.ok) return;
    expect(tarifaMala.message).toContain('día de vacaciones no disfrutado');
  });
});

describe('el apoyo del hogar no lleva contrato', () => {
  const PERSONA = {
    displayName: 'Prueba Apoyo',
    username: 'apoyo_prueba',
    email: 'apoyo@casa.local'
  };
  const CONTRATO = {
    startsOn: '2026-09-01',
    terms: {
      effectiveFrom: '2026-09-01',
      monthlySalaryCents: '140000',
      contractedWeeklyMinutes: 2400,
      annualVacationDays: 30,
      unusedVacationDayRateCents: null,
      vacationCarryoverExpiry: { mode: 'months' as const, months: 6 },
      reason: 'Alta desde la aplicación',
      extraWorkTypes: [],
      supplements: [],
      schedule: null
    }
  };

  it('se rechaza antes de tocar nada, y se dice qué hacer en su lugar', () => {
    // Demostrado en revisión: los dos botones de la etapa 2 son igual de
    // pulsables con cualquier papel, y «Dar de alta con su contrato» sobre un
    // apoyo creaba el acuerdo y con él una línea en la lista de personas
    // empleadas. El diseño lo prohíbe con esas palabras.
    expect(
      validateHireInput({ ...PERSONA, role: 'helper', agreement: CONTRATO })
    ).toBe(
      'El apoyo del hogar no tiene contrato: créale sólo el acceso, o dala de alta como empleada interna.'
    );
  });

  it('pero el apoyo sin contrato se da de alta con normalidad', () => {
    expect(validateHireInput({ ...PERSONA, role: 'helper', agreement: null })).toBeNull();
  });

  it('y la empleada interna con contrato sigue pasando', () => {
    expect(
      validateHireInput({ ...PERSONA, role: 'employee_live_in', agreement: CONTRATO })
    ).toBeNull();
  });
});

describe('un fallo de la etapa 2 no devuelve a la etapa 1', () => {
  it('el rechazo del alta conserva `persona`, que es lo que mantiene la etapa', async () => {
    /*
     * La etapa se deriva de la clave `persona`. La action `hire` fallaba sin
     * ponerla, así que cualquier rechazo devolvía a la etapa 1 y borraba el
     * contrato recién tecleado —fecha, salario, jornada, vacaciones, motivo,
     * tarifa y caducidad—. Y el rechazo más probable es el que la etapa 1 NO
     * puede detectar porque no toca la base de identidad: «ya hay una cuenta con
     * ese correo» o «ese usuario está cogido».
     *
     * Aquí no hay identidad configurada, así que el alta falla por esa vía; lo
     * que se comprueba es la FORMA de la respuesta, que es lo que decide qué
     * etapa se pinta.
     */
    const form = new FormData();
    for (const [name, value] of Object.entries({
      displayName: 'Nuria Sintética',
      username: 'nuria_sintetica',
      email: 'nuria@casa.local',
      role: 'employee_live_in',
      withAgreement: 'on',
      startsOn: '2026-09-01',
      ...BASICO
    })) {
      form.append(name, value);
    }

    const respuesta = (await actions.hire({
      locals: { user: { id: 'quien-sea' } },
      params: { householdId: 'casa' },
      request: new Request('http://localhost/?/hire', { method: 'POST', body: form })
    } as never)) as { status: number; data: Record<string, unknown> };

    expect(respuesta.status).toBe(400);
    expect(typeof respuesta.data.hireError).toBe('string');
    expect(respuesta.data.hireError).not.toBe('');
    // La clave que mantiene la pantalla en la etapa 2, con lo tecleado dentro.
    expect(respuesta.data.persona).toEqual({
      displayName: 'Nuria Sintética',
      username: 'nuria_sintetica',
      email: 'nuria@casa.local',
      role: 'employee_live_in'
    });
    expect(respuesta.data.draft).toEqual(respuesta.data.persona);
  });
});
