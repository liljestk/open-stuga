import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("MCP Home retirement parity", () => {
  it("does not retain a second destructive Home path beside the REST Hide Home coordinator", () => {
    const definitions = readFileSync("src/mcp-server/07-mcp-tool-definitions-part02.ts", "utf8");
    const handlers = readFileSync("src/mcp-server/10-all-tool-handlers.ts", "utf8");
    const legacyMutations = readFileSync("src/mcp-server/02-thermal-simulation-to-create-alert-rule.ts", "utf8");

    expect(definitions).not.toContain('name: "delete_house"');
    expect(handlers).not.toContain("delete_house:");
    expect(legacyMutations).not.toMatch(/database\.deleteHouse\s*\(/u);
  });
});
