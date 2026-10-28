import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP Home retirement parity", () => {
  it("does not retain a second destructive Home path beside the REST Hide Home coordinator", () => {
    const directory = "src/mcp-server";
    const sources = readdirSync(directory).filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(directory, name), "utf8"));
    expect(sources.length).toBeGreaterThan(10);

    for (const source of sources) {
      expect(source).not.toContain('name: "delete_house"');
      expect(source).not.toContain("delete_house:");
      expect(source).not.toMatch(/database\.deleteHouse\s*\(/u);
    }
  });
});
