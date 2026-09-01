import { describe, expect, it } from 'vitest';

import { readHireAgreementTerms } from '../src/lib/server/staff-hire.server';

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
