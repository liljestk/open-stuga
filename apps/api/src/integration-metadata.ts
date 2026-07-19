import type { IntegrationSecrets } from "./integration-secrets.js";
import type { ClimateDatabase } from "./db.js";

export type IntegrationMetadataKind =
  | "home-assistant"
  | "tp-link"
  | "telegram"
  | "apple-notes"
  | "webhook";

export type IntegrationSecretSource = "protected-file" | "environment";

export type IntegrationMetadataChangeReason =
  | "configured"
  | "reconciled"
  | "moved"
  | "disconnected"
  | "credential-absent"
  | "house-deleted"
  | "identity-refreshed";

interface IntegrationMetadataRow {
  kind: IntegrationMetadataKind;
  secret_ref: string;
  secret_source: IntegrationSecretSource;
  house_id: string | null;
  house_ref: string | null;
  endpoint: string | null;
  label: string | null;
  secondary_label: string | null;
  configured_at: string;
  updated_at: string;
  retired_at: string | null;
  revision: number;
}

export interface IntegrationMetadataRecord {
  kind: IntegrationMetadataKind;
  /** Stable reference into the protected credential source; never a credential. */
  secretRef: string;
  secretSource: IntegrationSecretSource;
  /** Live foreign key, null after the owning House has been deleted. */
  houseId: string | null;
  /** Last known House id retained for non-secret lifecycle history. */
  houseRef: string | null;
  /** Sanitized HA endpoint or TP-Link host. Query strings and fragments are never stored. */
  endpoint: string | null;
  label: string | null;
  secondaryLabel: string | null;
  configuredAt: string;
  updatedAt: string;
  retiredAt: string | null;
  revision: number;
  active: boolean;
}

export interface ProtectedIntegrationMetadataSnapshot {
  /** True only when an existing protected file was read and validated successfully. */
  authoritative: boolean;
  secrets: IntegrationSecrets;
  legacyHouseId: string | null;
}

export interface EnvironmentIntegrationMetadataSnapshot {
  homeAssistant: { houseId: string; url: string } | null;
  tpLink: { houseId: string; host: string } | null;
  telegramConfigured: boolean;
  webhookConfigured: boolean;
}

interface UpsertInput {
  kind: IntegrationMetadataKind;
  secretRef: string;
  secretSource: IntegrationSecretSource;
  houseRef?: string | null;
  endpoint?: string | null;
  /** Undefined preserves a previously discovered label during reconciliation. */
  label?: string | null;
  /** Undefined preserves a previously discovered secondary label during reconciliation. */
  secondaryLabel?: string | null;
  configuredAt?: string;
  reason: IntegrationMetadataChangeReason;
}

function metadataRecord(row: IntegrationMetadataRow): IntegrationMetadataRecord {
  return {
    kind: row.kind,
    secretRef: row.secret_ref,
    secretSource: row.secret_source,
    houseId: row.house_id,
    houseRef: row.house_ref,
    endpoint: row.endpoint,
    label: row.label,
    secondaryLabel: row.secondary_label,
    configuredAt: row.configured_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
    revision: row.revision,
    active: row.retired_at === null,
  };
}

function boundedString(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maximumLength) {
    throw new Error(`${label} must contain between 1 and ${maximumLength} characters`);
  }
  return normalized;
}

function optionalBoundedString(value: string | null, label: string, maximumLength: number): string | null {
  if (value === null) return null;
  return boundedString(value, label, maximumLength);
}

/**
 * Produces useful connection metadata without persisting URL credentials,
 * capability query parameters, or fragments which may themselves be secrets.
 */
export function sanitizedHttpIntegrationEndpoint(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Integration endpoint must be an HTTP(S) URL without embedded credentials");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function homeAssistantSecretRef(houseId: string): string {
  return `house:${houseId}`;
}

/**
 * Typed repository for durable, explicitly non-secret integration state.
 * Credential material remains in integration-secrets.json or the environment.
 */
export class IntegrationMetadataStore {
  constructor(private readonly database: ClimateDatabase) {
    this.migrate();
  }

  private migrate(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_metadata (
        kind TEXT NOT NULL CHECK (kind IN ('home-assistant', 'tp-link', 'telegram', 'apple-notes', 'webhook')),
        secret_ref TEXT NOT NULL CHECK (length(trim(secret_ref)) BETWEEN 1 AND 200),
        secret_source TEXT NOT NULL CHECK (secret_source IN ('protected-file', 'environment')),
        house_id TEXT REFERENCES houses(id) ON DELETE SET NULL,
        house_ref TEXT,
        endpoint TEXT,
        label TEXT,
        secondary_label TEXT,
        configured_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        retired_at TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY (kind, secret_ref),
        CHECK (house_ref IS NULL OR length(trim(house_ref)) BETWEEN 1 AND 200),
        CHECK (endpoint IS NULL OR length(endpoint) BETWEEN 1 AND 2048),
        CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),
        CHECK (secondary_label IS NULL OR length(secondary_label) BETWEEN 1 AND 200)
      );
      CREATE INDEX IF NOT EXISTS idx_integration_metadata_active_kind
        ON integration_metadata(kind, updated_at DESC) WHERE retired_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_integration_metadata_house_history
        ON integration_metadata(house_ref, updated_at DESC) WHERE house_ref IS NOT NULL;
      CREATE TABLE IF NOT EXISTS integration_metadata_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event TEXT NOT NULL CHECK (event IN ('activated', 'updated', 'retired')),
        reason TEXT NOT NULL CHECK (reason IN (
          'configured', 'reconciled', 'moved', 'disconnected', 'credential-absent',
          'house-deleted', 'identity-refreshed'
        )),
        secret_source TEXT NOT NULL CHECK (secret_source IN ('protected-file', 'environment')),
        house_ref TEXT,
        endpoint TEXT,
        label TEXT,
        secondary_label TEXT,
        configured_at TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        retired_at TEXT,
        UNIQUE (kind, secret_ref, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_integration_metadata_revisions_changed
        ON integration_metadata_revisions(changed_at DESC, id DESC);
    `);
  }

  list(options: { kind?: IntegrationMetadataKind; activeOnly?: boolean } = {}): IntegrationMetadataRecord[] {
    const filters: string[] = [];
    const parameters: string[] = [];
    if (options.kind) {
      filters.push("kind = ?");
      parameters.push(options.kind);
    }
    if (options.activeOnly) filters.push("retired_at IS NULL");
    const rows = this.database.db.prepare(`SELECT * FROM integration_metadata
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY kind, configured_at, secret_ref`).all(...parameters) as unknown as IntegrationMetadataRow[];
    return rows.map(metadataRecord);
  }

  get(kind: IntegrationMetadataKind, secretRef: string): IntegrationMetadataRecord | null {
    const row = this.database.db.prepare(`SELECT * FROM integration_metadata
      WHERE kind = ? AND secret_ref = ?`).get(kind, secretRef) as unknown as IntegrationMetadataRow | undefined;
    return row ? metadataRecord(row) : null;
  }

  saveHomeAssistant(input: {
    houseId: string;
    url: string;
    source?: IntegrationSecretSource;
    legacy?: boolean;
    reason?: IntegrationMetadataChangeReason;
  }): IntegrationMetadataRecord {
    return this.transaction(() => this.upsert({
      kind: "home-assistant",
      secretRef: input.legacy ? "legacy" : homeAssistantSecretRef(input.houseId),
      secretSource: input.source ?? "protected-file",
      houseRef: input.houseId,
      endpoint: sanitizedHttpIntegrationEndpoint(input.url),
      reason: input.reason ?? "configured",
    }, false)!);
  }

  moveHomeAssistant(fromHouseId: string, targetHouseId: string, url: string): IntegrationMetadataRecord {
    return this.transaction(() => {
      this.retire("home-assistant", homeAssistantSecretRef(fromHouseId), "moved");
      return this.upsert({
        kind: "home-assistant",
        secretRef: homeAssistantSecretRef(targetHouseId),
        secretSource: "protected-file",
        houseRef: targetHouseId,
        endpoint: sanitizedHttpIntegrationEndpoint(url),
        reason: "moved",
      }, false)!;
    });
  }

  retireHomeAssistant(houseId: string, legacy = false): boolean {
    return this.transaction(() => this.retire(
      "home-assistant",
      legacy ? "legacy" : homeAssistantSecretRef(houseId),
      "disconnected",
    ));
  }

  saveTpLink(input: {
    id: string;
    houseId: string;
    host: string;
    source?: IntegrationSecretSource;
    reason?: IntegrationMetadataChangeReason;
  }): IntegrationMetadataRecord {
    return this.transaction(() => this.upsert({
      kind: "tp-link",
      secretRef: boundedString(input.id, "TP-Link connection id", 200),
      secretSource: input.source ?? "protected-file",
      houseRef: input.houseId,
      endpoint: boundedString(input.host, "TP-Link host", 253),
      reason: input.reason ?? "configured",
    }, false)!);
  }

  moveTpLink(id: string, targetHouseId: string, host: string): IntegrationMetadataRecord {
    return this.transaction(() => this.upsert({
      kind: "tp-link",
      secretRef: boundedString(id, "TP-Link connection id", 200),
      secretSource: "protected-file",
      houseRef: targetHouseId,
      endpoint: boundedString(host, "TP-Link host", 253),
      reason: "moved",
    }, false)!);
  }

  retireTpLink(id: string): boolean {
    return this.transaction(() => this.retire("tp-link", id, "disconnected"));
  }

  saveTelegramIdentity(input: {
    botUsername?: string | null;
    chatLabel?: string | null;
    source?: IntegrationSecretSource;
    reason?: IntegrationMetadataChangeReason;
  }): IntegrationMetadataRecord {
    return this.transaction(() => this.upsert({
      kind: "telegram",
      secretRef: "singleton",
      secretSource: input.source ?? "protected-file",
      ...(input.botUsername === undefined
        ? {}
        : { label: optionalBoundedString(input.botUsername, "Telegram bot username", 200) }),
      ...(input.chatLabel === undefined
        ? {}
        : { secondaryLabel: optionalBoundedString(input.chatLabel, "Telegram chat label", 200) }),
      reason: input.reason ?? "configured",
    }, false)!);
  }

  retireTelegram(): boolean {
    return this.transaction(() => this.retire("telegram", "singleton", "disconnected"));
  }

  saveAppleNotesGrant(input: {
    id: string;
    houseId: string;
    deviceLabel: string;
    createdAt: string;
    reason?: IntegrationMetadataChangeReason;
  }): IntegrationMetadataRecord {
    return this.transaction(() => this.upsert({
      kind: "apple-notes",
      secretRef: boundedString(input.id, "Apple Notes grant id", 200),
      secretSource: "protected-file",
      houseRef: input.houseId,
      label: boundedString(input.deviceLabel, "Apple Notes device label", 100),
      configuredAt: new Date(input.createdAt).toISOString(),
      reason: input.reason ?? "configured",
    }, false)!);
  }

  retireAppleNotesGrant(id: string): boolean {
    return this.transaction(() => this.retire("apple-notes", id, "disconnected"));
  }

  retireHouse(houseId: string): number {
    return this.transaction(() => {
      const rows = this.database.db.prepare(`SELECT kind, secret_ref FROM integration_metadata
        WHERE house_ref = ? AND retired_at IS NULL`).all(houseId) as unknown as Array<{
          kind: IntegrationMetadataKind;
          secret_ref: string;
        }>;
      for (const row of rows) this.retire(row.kind, row.secret_ref, "house-deleted");
      return rows.length;
    });
  }

  reconcileProtectedFile(snapshot: ProtectedIntegrationMetadataSnapshot): void {
    this.transaction(() => {
      const active = new Map<IntegrationMetadataKind, Set<string>>();
      const remember = (kind: IntegrationMetadataKind, secretRef: string): void => {
        const refs = active.get(kind) ?? new Set<string>();
        refs.add(secretRef);
        active.set(kind, refs);
      };
      const add = (input: UpsertInput): void => {
        if (!this.upsert(input, true)) return;
        remember(input.kind, input.secretRef);
      };
      const secrets = snapshot.secrets;
      if (secrets.homeAssistant && !secrets.homeAssistantLegacyDisabled && snapshot.legacyHouseId) {
        add({
          kind: "home-assistant", secretRef: "legacy", secretSource: "protected-file",
          houseRef: snapshot.legacyHouseId, endpoint: sanitizedHttpIntegrationEndpoint(secrets.homeAssistant.url),
          reason: "reconciled",
        });
      }
      for (const connection of secrets.homeAssistantConnections ?? []) {
        const secretRef = homeAssistantSecretRef(connection.houseId);
        add({
          kind: "home-assistant", secretRef, secretSource: "protected-file", houseRef: connection.houseId,
          endpoint: sanitizedHttpIntegrationEndpoint(connection.url), reason: "reconciled",
        });
      }
      if (secrets.tpLink && !secrets.tpLinkLegacyDisabled && snapshot.legacyHouseId) {
        add({
          kind: "tp-link", secretRef: "legacy", secretSource: "protected-file", houseRef: snapshot.legacyHouseId,
          endpoint: boundedString(secrets.tpLink.host, "TP-Link host", 253), reason: "reconciled",
        });
      }
      for (const connection of secrets.tpLinkConnections ?? []) {
        add({
          kind: "tp-link", secretRef: connection.id, secretSource: "protected-file", houseRef: connection.houseId,
          endpoint: boundedString(connection.host, "TP-Link host", 253), reason: "reconciled",
        });
      }
      if (secrets.telegram) {
        add({
          kind: "telegram", secretRef: "singleton", secretSource: "protected-file",
          reason: "reconciled",
        });
      }
      if (secrets.webhook) {
        add({
          kind: "webhook", secretRef: "singleton", secretSource: "protected-file",
          reason: "reconciled",
        });
      }
      for (const grant of secrets.appleNotesGrants ?? []) {
        add({
          kind: "apple-notes", secretRef: grant.id, secretSource: "protected-file", houseRef: grant.houseId,
          label: boundedString(grant.deviceLabel, "Apple Notes device label", 100),
          configuredAt: new Date(grant.createdAt).toISOString(), reason: "reconciled",
        });
      }
      if (!snapshot.authoritative) return;
      const rows = this.database.db.prepare(`SELECT kind, secret_ref FROM integration_metadata
        WHERE secret_source = 'protected-file' AND retired_at IS NULL`).all() as unknown as Array<{
          kind: IntegrationMetadataKind;
          secret_ref: string;
        }>;
      for (const row of rows) {
        if (!active.get(row.kind)?.has(row.secret_ref)) {
          this.retire(row.kind, row.secret_ref, "credential-absent");
        }
      }
    });
  }

  reconcileEnvironment(snapshot: EnvironmentIntegrationMetadataSnapshot): void {
    this.transaction(() => {
      const active = new Map<IntegrationMetadataKind, Set<string>>();
      const add = (input: UpsertInput): void => {
        if (!this.upsert(input, true)) return;
        const refs = active.get(input.kind) ?? new Set<string>();
        refs.add(input.secretRef);
        active.set(input.kind, refs);
      };
      if (snapshot.homeAssistant) add({
        kind: "home-assistant", secretRef: "legacy", secretSource: "environment",
        houseRef: snapshot.homeAssistant.houseId,
        endpoint: sanitizedHttpIntegrationEndpoint(snapshot.homeAssistant.url), reason: "reconciled",
      });
      if (snapshot.tpLink) add({
        kind: "tp-link", secretRef: "legacy", secretSource: "environment",
        houseRef: snapshot.tpLink.houseId, endpoint: boundedString(snapshot.tpLink.host, "TP-Link host", 253),
        reason: "reconciled",
      });
      if (snapshot.telegramConfigured) add({
        kind: "telegram", secretRef: "singleton", secretSource: "environment", reason: "reconciled",
      });
      if (snapshot.webhookConfigured) add({
        kind: "webhook", secretRef: "singleton", secretSource: "environment", reason: "reconciled",
      });
      const rows = this.database.db.prepare(`SELECT kind, secret_ref FROM integration_metadata
        WHERE secret_source = 'environment' AND retired_at IS NULL`).all() as unknown as Array<{
          kind: IntegrationMetadataKind;
          secret_ref: string;
        }>;
      for (const row of rows) {
        if (!active.get(row.kind)?.has(row.secret_ref)) {
          this.retire(row.kind, row.secret_ref, "credential-absent");
        }
      }
    });
  }

  private upsert(input: UpsertInput, skipMissingHouse: boolean): IntegrationMetadataRecord | null {
    const secretRef = boundedString(input.secretRef, "Integration secret reference", 200);
    const houseRef = input.houseRef === undefined || input.houseRef === null
      ? null
      : boundedString(input.houseRef, "Integration House reference", 200);
    if (houseRef && !this.database.getHouse(houseRef)) {
      if (skipMissingHouse) return null;
      throw new Error(`Integration metadata references unknown House ${houseRef}`);
    }
    const existing = this.database.db.prepare(`SELECT * FROM integration_metadata
      WHERE kind = ? AND secret_ref = ?`).get(input.kind, secretRef) as unknown as IntegrationMetadataRow | undefined;
    const endpoint = input.endpoint === undefined
      ? existing?.endpoint ?? null
      : optionalBoundedString(input.endpoint, "Integration endpoint", 2_048);
    const label = input.label === undefined ? existing?.label ?? null : input.label;
    const secondaryLabel = input.secondaryLabel === undefined ? existing?.secondary_label ?? null : input.secondaryLabel;
    const normalizedLabel = label === null ? null : optionalBoundedString(label, "Integration label", 200);
    const normalizedSecondaryLabel = secondaryLabel === null
      ? null
      : optionalBoundedString(secondaryLabel, "Integration secondary label", 200);
    const now = new Date().toISOString();
    const configuredAt = existing && existing.retired_at === null
      ? existing.configured_at
      : input.configuredAt ?? now;
    const changed = !existing
      || existing.retired_at !== null
      || existing.secret_source !== input.secretSource
      || existing.house_ref !== houseRef
      || existing.house_id !== houseRef
      || existing.endpoint !== endpoint
      || existing.label !== normalizedLabel
      || existing.secondary_label !== normalizedSecondaryLabel;
    if (!changed) return metadataRecord(existing);
    const revision = (existing?.revision ?? 0) + 1;
    this.database.db.prepare(`INSERT INTO integration_metadata
      (kind, secret_ref, secret_source, house_id, house_ref, endpoint, label, secondary_label,
       configured_at, updated_at, retired_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(kind, secret_ref) DO UPDATE SET
        secret_source = excluded.secret_source,
        house_id = excluded.house_id,
        house_ref = excluded.house_ref,
        endpoint = excluded.endpoint,
        label = excluded.label,
        secondary_label = excluded.secondary_label,
        configured_at = excluded.configured_at,
        updated_at = excluded.updated_at,
        retired_at = NULL,
        revision = excluded.revision`)
      .run(
        input.kind, secretRef, input.secretSource, houseRef, houseRef, endpoint,
        normalizedLabel, normalizedSecondaryLabel, configuredAt, now, revision,
      );
    const row = this.database.db.prepare(`SELECT * FROM integration_metadata
      WHERE kind = ? AND secret_ref = ?`).get(input.kind, secretRef) as unknown as IntegrationMetadataRow;
    this.appendRevision(row, existing?.retired_at !== null || !existing ? "activated" : "updated", input.reason);
    return metadataRecord(row);
  }

  private retire(
    kind: IntegrationMetadataKind,
    secretRef: string,
    reason: IntegrationMetadataChangeReason,
  ): boolean {
    const existing = this.database.db.prepare(`SELECT * FROM integration_metadata
      WHERE kind = ? AND secret_ref = ? AND retired_at IS NULL`).get(kind, secretRef) as unknown as IntegrationMetadataRow | undefined;
    if (!existing) return false;
    const now = new Date().toISOString();
    this.database.db.prepare(`UPDATE integration_metadata
      SET house_id = NULL, updated_at = ?, retired_at = ?, revision = revision + 1
      WHERE kind = ? AND secret_ref = ? AND retired_at IS NULL`).run(now, now, kind, secretRef);
    const retired = this.database.db.prepare(`SELECT * FROM integration_metadata
      WHERE kind = ? AND secret_ref = ?`).get(kind, secretRef) as unknown as IntegrationMetadataRow;
    this.appendRevision(retired, "retired", reason);
    return true;
  }

  private appendRevision(
    row: IntegrationMetadataRow,
    event: "activated" | "updated" | "retired",
    reason: IntegrationMetadataChangeReason,
  ): void {
    this.database.db.prepare(`INSERT INTO integration_metadata_revisions
      (kind, secret_ref, revision, event, reason, secret_source, house_ref, endpoint, label,
       secondary_label, configured_at, changed_at, retired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.kind, row.secret_ref, row.revision, event, reason, row.secret_source, row.house_ref,
        row.endpoint, row.label, row.secondary_label, row.configured_at, row.updated_at, row.retired_at,
      );
  }

  private transaction<T>(operation: () => T): T {
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }
}
