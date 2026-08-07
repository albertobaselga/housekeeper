/** Error de regla de dominio con código estable para traducir o auditar. */
export class DomainRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainRuleError";
    this.code = code;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainRuleError(code, message);
}
