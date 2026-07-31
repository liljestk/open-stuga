import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type { ClimateDatabase } from "./db.js";
import {
  applyIntegrationSecretsPatch,
  readIntegrationSecrets,
  writeIntegrationSecrets,
  type IntegrationSecrets,
  type IntegrationSecretsPatch,
} from "./integration-secrets.js";
import { pendingIntegrationSecretsPath, withIntegrationSecretsLock } from "./integration-secrets-lock.js";

const DATABASE_REVISION_KEY = "integration_secrets_revision";

function recordedRevision(database: ClimateDatabase): string | null {
  const row = database.db.prepare("SELECT value FROM metadata WHERE key = ?").get(DATABASE_REVISION_KEY) as
    | { value: unknown }
    | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function publishPending(path: string, pendingPath: string): IntegrationSecrets {
  const secrets = readIntegrationSecrets(pendingPath);
  writeIntegrationSecrets(path, secrets);
  unlinkSync(pendingPath);
  return secrets;
}

/**
 * Completes a credentials publication that was interrupted after SQLite commit.
 * A stage whose revision is absent from SQLite belonged to a rolled-back transaction.
 */
export function recoverCoordinatedIntegrationSecrets(
  path: string,
  database: ClimateDatabase,
): IntegrationSecrets | null {
  if (!existsSync(pendingIntegrationSecretsPath(path))) return null;
  return withIntegrationSecretsLock(path, () => {
    const pendingPath = pendingIntegrationSecretsPath(path);
    if (!existsSync(pendingPath)) return null;
    const pending = readIntegrationSecrets(pendingPath);
    if (!pending.databaseRevision) {
      throw new Error("The pending integration secrets file has no database revision");
    }
    if (pending.databaseRevision !== recordedRevision(database)) {
      unlinkSync(pendingPath);
      return null;
    }
    return publishPending(path, pendingPath);
  });
}

/**
 * Stages protected credentials while SQLite is uncommitted, records the stage
 * revision in that same transaction, then publishes the file after commit.
 */
export function commitCoordinatedIntegrationSecrets<T>(
  path: string,
  database: ClimateDatabase,
  operation: (current: Readonly<IntegrationSecrets>) => { patch: IntegrationSecretsPatch; result: T },
): { secrets: IntegrationSecrets; result: T; publicationPending: boolean } {
  return withIntegrationSecretsLock(path, () => {
    const pendingPath = pendingIntegrationSecretsPath(path);
    if (existsSync(pendingPath)) {
      throw new Error("A committed integration secrets update is pending recovery");
    }
    const current = readIntegrationSecrets(path);
    let databaseCommitted = false;
    try {
      const committed = database.transaction(() => {
        const mutation = operation(current);
        const revision = randomUUID();
        const next = applyIntegrationSecretsPatch(current, mutation.patch);
        next.databaseRevision = revision;
        writeIntegrationSecrets(pendingPath, next);
        database.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(DATABASE_REVISION_KEY, revision);
        return { secrets: next, result: mutation.result };
      });
      databaseCommitted = true;
      try {
        publishPending(path, pendingPath);
        return { ...committed, publicationPending: false };
      } catch {
        // The durable stage and SQLite revision let startup finish publication.
        return { ...committed, publicationPending: true };
      }
    } catch (error) {
      if (!databaseCommitted && existsSync(pendingPath)) {
        try { unlinkSync(pendingPath); } catch { /* Preserve the transaction error. */ }
      }
      throw error;
    }
  });
}
