import { describe, expect, it } from "vitest";

import dataExportStyles from "./DataExportPanel.css?raw";

describe("DataExportPanel responsive styles", () => {
  it("lets the preview grid item shrink while its table scrolls internally", () => {
    expect(dataExportStyles).toMatch(/\.data-export-preview\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/);
    expect(dataExportStyles).toMatch(/\.data-export-table-wrap\s*\{[^}]*overflow:\s*auto/);
  });
});
