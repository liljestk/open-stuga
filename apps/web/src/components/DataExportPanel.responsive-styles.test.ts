import { describe, expect, it } from "vitest";

import dataExportStyles from "./DataExportPanel.css?raw";

describe("DataExportPanel responsive styles", () => {
  it("clamps the content track while its preview table scrolls internally", () => {
    expect(dataExportStyles).toMatch(/\.data-export-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(dataExportStyles).toMatch(/\.data-export-preview\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/);
    expect(dataExportStyles).toMatch(/\.data-export-table-wrap\s*\{[^}]*overflow:\s*auto/);
    expect(dataExportStyles).toMatch(/\.data-export-table-wrap table\s*\{[^}]*min-width:\s*680px/);
  });
});
