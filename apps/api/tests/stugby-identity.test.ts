import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateStugbyNodeKeys } from "../src/stugby/identity.js";

describe("Stugby node identity persistence", () => {
  it("atomically persists one reusable signing identity without leaving temporary files", () => {
    const directory = mkdtempSync(join(tmpdir(), "stugby-identity-"));
    try {
      const path = join(directory, "nested", "node-identity.json");
      const first = loadOrCreateStugbyNodeKeys(path, "Durable Stuga");
      const persisted = JSON.parse(readFileSync(path, "utf8")) as {
        nodeId: string;
        displayName: string;
        privateKey: string;
      };
      const second = loadOrCreateStugbyNodeKeys(path, "Ignored replacement name");
      const message = "identity survives a restart";
      const signature = first.sign(message);

      expect(persisted).toMatchObject({
        nodeId: first.identity.nodeId,
        displayName: "Durable Stuga",
      });
      expect(persisted.privateKey).toBeTruthy();
      expect(second.identity).toEqual(first.identity);
      expect(second.verify(message, signature)).toBe(true);
      expect(readdirSync(join(directory, "nested"))).toEqual(["node-identity.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
