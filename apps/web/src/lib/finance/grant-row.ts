/**
 * Lo que una fila de la tarjeta de concesiones DICE de sí misma, construido de
 * una vez.
 *
 * Las cuatro superficies que hablan del estado —el chip, la frase de debajo del
 * nombre, el texto visible del botón y su nombre accesible— salían antes de
 * cuatro lecturas independientes de `granted`. Que coincidieran era una
 * convención vigilada por expresiones regulares, y una convención vigilada así
 * se derrota envolviendo el literal en vez de sustituirlo: la fila podía acabar
 * diciendo «Apagado», «No ve el módulo de Finanzas» y ofreciendo «Desactivar
 * Finanzas» a la vez. Eso no es media verdad: no hay forma de saber cuál de las
 * tres es.
 *
 * Aquí no hay campos que calcular por separado: hay DOS objetos completos y se
 * devuelve uno entero. Divergir no es difícil, es que no hay de dónde.
 *
 * El nombre accesible se construye a partir del visible, así que «etiqueta en el
 * nombre» (WCAG 2.5.3) deja de ser algo que haya que recordar: quien maneja la
 * casa por voz dice lo que lee.
 */

export interface FinanceRowText {
  /** Texto del chip de estado. */
  estado: 'Activado' | 'Apagado';
  /** ¿El chip va en tono de logro? Solo la concesión viva lo es. */
  destacado: boolean;
  /** La frase de debajo del nombre, que dice el estado en palabras. */
  detalle: string;
  /** Texto VISIBLE del botón. */
  accion: string;
  /** Nombre accesible del botón: el visible más a quién se le hace. */
  accionCompleta: string;
}

export function financeRowText(admin: { name: string; granted: boolean }): FinanceRowText {
  const vista = admin.granted
    ? {
        estado: 'Activado' as const,
        destacado: true,
        detalle: 'Ve el módulo de Finanzas',
        accion: 'Desactivar Finanzas'
      }
    : {
        estado: 'Apagado' as const,
        destacado: false,
        detalle: 'No ve el módulo de Finanzas',
        accion: 'Activar Finanzas'
      };
  return { ...vista, accionCompleta: `${vista.accion} a ${admin.name}` };
}
