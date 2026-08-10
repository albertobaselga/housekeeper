/**
 * Quién cobra un complemento recurrente, tal y como viaja por el formulario del
 * acuerdo.
 *
 * Vive en un módulo propio, sin una sola dependencia, por dos razones.
 *
 * La primera es el contrato. El `<option>` de la plantilla y la comparación de
 * `+page.server.ts` son un acuerdo de CADENAS que ningún tipo ataba: la
 * plantilla declaraba `<option value={true}>`, Svelte lo escribía como
 * `value="true"`, y el servidor comparaba con `'suma'`. La comparación no se
 * cumplía nunca y TODO complemento —incluido el que era dinero para ella— se
 * guardaba como gasto de la casa, sobre una tabla que solo admite INSERT.
 * Compartiendo la constante, renombrar una opción es un error de compilación en
 * los dos lados en vez de una transferencia mermada en silencio.
 *
 * La segunda es el peso. La pantalla del acuerdo es una ruta propia con su
 * propio trozo de JavaScript, y meter esto en `commands.ts` le habría arrastrado
 * la cola offline entera por dos palabras.
 */
export const PAYER_CHOICES = { addsToPay: 'suma', paidByHousehold: 'casa' } as const;

export type PayerChoice = (typeof PAYER_CHOICES)[keyof typeof PAYER_CHOICES];
