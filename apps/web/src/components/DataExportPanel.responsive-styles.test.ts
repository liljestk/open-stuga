import { describe, expect, it } from "vitest";

import dataExportStyles from "./DataExportPanel.css?raw";
import { cssRule } from "../test/styleSources";

describe("DataExportPanel responsive styles", () => {
  it("clamps the content track while its preview table scrolls internally", () => {
    expect(cssRule(dataExportStyles, ".data-export-content").get("grid-template-columns")).toBe("minmax(0, 1fr)");
    const preview = cssRule(dataExportStyles, ".data-export-preview");
    expect([preview.get("min-width"), preview.get("overflow")]).toEqual(["0", "hidden"]);
    expect(cssRule(dataExportStyles, ".data-export-table-wrap").get("overflow")).toBe("auto");
    expect(cssRule(dataExportStyles, ".data-export-table-wrap table").get("min-width")).toBe("680px");
  });
});
