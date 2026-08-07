import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";

/**
 * Orden alfabético y SIN paralelismo de ficheros: todas las suites de
 * integración comparten la misma base provisionada por el global setup, y
 * varias hacen aserciones de conteo absoluto (p. ej.
 * database.integration.test.ts espera exactamente la liquidación de la
 * fixture) mientras otras (employment, dismissal, reminders) crean
 * liquidaciones nuevas en el mismo hogar. Con hilos en paralelo el resultado
 * dependía del azar del planificador; el orden determinista elimina la
 * carrera sin tocar ninguna suite.
 */
class AlphabeticalSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve(
      [...files].sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
    );
  }
}

export default defineConfig({
  test: {
    globalSetup: ["./test-support/global-setup.mjs"],
    fileParallelism: false,
    sequence: { sequencer: AlphabeticalSequencer },
  },
});
