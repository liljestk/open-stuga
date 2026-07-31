import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import {
  commitCoordinatedIntegrationSecrets,
  recoverCoordinatedIntegrationSecrets,
} from "../src/integration-secrets-coordinator.js";
import { pendingIntegrationSecretsPath } from "../src/integration-secrets-lock.js";
import { readIntegrationSecrets, writeIntegrationSecrets } from "../src/integration-secrets.js";

describe("coordinated integration secrets durability", () => {
  let directory: string | null = null;
  let database: ClimateDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function setup(): { secretsPath: string; database: ClimateDatabase } {
    directory = mkdtempSync(join(tmpdir(), "stugu-secrets-coordinator-"));
    const secretsPath = join(directory, "private", "integration-secrets.json");
    writeIntegrationSecrets(secretsPath, { version: 1 });
    database = new ClimateDatabase(join(directory, "climate.sqlite"), false);
    return { secretsPath, database };
  }

  it("publishes the same revision committed with the database mutation", () => {
    const fixture = setup();
    const committed = commitCoordinatedIntegrationSecrets(
      fixture.secretsPath,
      fixture.database,
      () => {
        fixture.database.db.prepare("INSERT INTO metadata(key, value) VALUES ('coordinator_test', 'committed')").run();
        return { patch: { telegram: { botToken: "123:test-token", chatId: "456" } }, result: "ok" };
      },
    );

    const stored = readIntegrationSecrets(fixture.secretsPath);
    const revision = fixture.database.db.prepare(
      "SELECT value FROM metadata WHERE key = 'integration_secrets_revision'",
    ).get() as { value: string };
    expect(committed).toMatchObject({ result: "ok", publicationPending: false });
    expect(stored.databaseRevision).toBe(revision.value);
    expect(stored.telegram?.chatId).toBe("456");
    expect(existsSync(pendingIntegrationSecretsPath(fixture.secretsPath))).toBe(false);
  });

  it("finishes a staged publication after a crash following database commit", () => {
    const fixture = setup();
    const revision = randomUUID();
    const pendingPath = pendingIntegrationSecretsPath(fixture.secretsPath);
    writeIntegrationSecrets(pendingPath, {
      version: 1,
      databaseRevision: revision,
      telegram: { botToken: "123:recovered-token", chatId: "789" },
    });
    fixture.database.db.prepare(
      "INSERT INTO metadata(key, value) VALUES ('integration_secrets_revision', ?)",
    ).run(revision);

    const recovered = recoverCoordinatedIntegrationSecrets(fixture.secretsPath, fixture.database);

    expect(recovered?.databaseRevision).toBe(revision);
    expect(readIntegrationSecrets(fixture.secretsPath).telegram?.chatId).toBe("789");
    expect(existsSync(pendingPath)).toBe(false);
  });

  it("discards a stage whose database transaction did not commit", () => {
    const fixture = setup();
    const pendingPath = pendingIntegrationSecretsPath(fixture.secretsPath);
    writeIntegrationSecrets(pendingPath, {
      version: 1,
      databaseRevision: randomUUID(),
      telegram: { botToken: "123:rolled-back-token", chatId: "999" },
    });

    expect(recoverCoordinatedIntegrationSecrets(fixture.secretsPath, fixture.database)).toBeNull();
    expect(readIntegrationSecrets(fixture.secretsPath)).toEqual({ version: 1 });
    expect(existsSync(pendingPath)).toBe(false);
  });
});
