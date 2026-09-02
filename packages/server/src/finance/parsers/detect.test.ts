import { describe, expect, it } from "vitest";

import { detectBank } from "./index.js";
import {
  amexSampleXlsx,
  amexSampleXlsxSinHoja,
  caixabankSampleXls,
  deutscheSampleXls,
  openbankSampleHtml,
} from "./synthetic-samples.js";

describe("detectBank (port de importer.detect_bank, siempre por contenido)", () => {
  it("reconoce los cuatro bancos por sus marcas", () => {
    expect(detectBank(caixabankSampleXls(), "mov.xls")).toBe("caixabank");
    expect(detectBank(deutscheSampleXls(), "mov.xls")).toBe("deutsche_bank");
    expect(detectBank(openbankSampleHtml(), "mov.xls")).toBe("openbank");
    expect(detectBank(amexSampleXlsx(), "mov.xlsx")).toBe("amex");
  });
  it("devuelve null ante contenido no reconocido", () => {
    expect(detectBank(new Uint8Array(Buffer.from("cualquier cosa")), "x.xls")).toBeNull();
    expect(detectBank(amexSampleXlsxSinHoja(), "x.xlsx")).toBeNull();
    expect(detectBank(new Uint8Array(Buffer.from("<html><body>hola</body></html>", "latin1")), "x.xls")).toBeNull();
  });
});
