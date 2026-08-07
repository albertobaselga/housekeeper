import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test-support/global-setup.mjs"],
    // Evidencia JUnit para CI (assert-junit-nonempty.py) sin tocar la salida normal.
    reporters: ["default", "junit"],
    outputFile: { junit: "../../artifacts/unit/server.xml" },
  },
});
