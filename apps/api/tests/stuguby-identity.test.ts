import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateStugubyNodeKeys } from "../src/stuguby/identity.js";

describe("Stuguby node identity persistence", () => {
  it("atomically persists one reusable signing identity without leaving temporary files", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuguby-identity-"));
    try {
      const path = join(directory, "nested", "node-identity.json");
      const first = loadOrCreateStugubyNodeKeys(path, "Durable Stugu");
      const persisted = JSON.parse(readFileSync(path, "utf8")) as {
        nodeId: string;
        displayName: string;
        privateKey: string;
      };
      const second = loadOrCreateStugubyNodeKeys(path, "Ignored replacement name");
      const message = "identity survives a restart";
      const signature = first.sign(message);

      expect(persisted).toMatchObject({
        nodeId: first.identity.nodeId,
        displayName: "Durable Stugu",
      });
      expect(persisted.privateKey).toBeTruthy();
      expect(second.identity).toEqual(first.identity);
      expect(second.verify(message, signature)).toBe(true);
      expect(readdirSync(join(directory, "nested"))).toEqual(["node-identity.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the legacy default identity when adopting the corrected filename", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuguby-legacy-identity-"));
    try {
      const legacyPath = join(directory, "stugby-identity.json");
      const path = join(directory, "stuguby-identity.json");
      const legacy = loadOrCreateStugubyNodeKeys(legacyPath, "Original Stugu");
      const migrated = loadOrCreateStugubyNodeKeys(path, "Replacement name");
      const persisted = JSON.parse(readFileSync(path, "utf8")) as { nodeId: string; displayName: string };

      expect(migrated.identity).toEqual(legacy.identity);
      expect(persisted).toMatchObject({
        nodeId: legacy.identity.nodeId,
        displayName: "Original Stugu",
      });
      expect(readdirSync(directory).sort()).toEqual(["stugby-identity.json", "stuguby-identity.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
