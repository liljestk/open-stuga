import type { AssistantConnection, AssistantKind, TenantMemberRole } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../db.js";

export type AssistantTokenKind = "access" | "refresh";

export interface StoredAssistantClient {
  clientId: string;
  secretHash: string | null;
  assistant: AssistantKind;
  /** The registration response (RFC 7591) without the secret, returned again by the client store. */
  metadata: Record<string, unknown>;
  registeredAt: string;
}

export interface StoredAssistantToken {
  grantId: string;
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: string;
  rotatedAt: string | null;
  /** The approving account's current workspace role, or null once it is no longer a member. */
  approverRole: TenantMemberRole | null;
  lastUsedAt: string | null;
}

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  assistant: AssistantKind;
  metadata_json: string;
  registered_at: string;
}

interface TokenRow {
  grant_id: string;
  client_id: string;
  resource: string;
  scope: string;
  expires_at: string;
  rotated_at: string | null;
  role: TenantMemberRole | null;
  last_used_at: string | null;
}

interface ConnectionRow {
  id: string;
  assistant: AssistantKind;
  metadata_json: string;
  email: string;
  created_at: string;
  last_used_at: string | null;
}

function clientName(metadataJson: string): string | null {
  try {
    const name = (JSON.parse(metadataJson) as { client_name?: unknown }).client_name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** SQLite persistence for assistant OAuth clients, approved grants and their hashed tokens. */
export class AssistantConnectorStore {
  constructor(private readonly database: ClimateDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  clientCount(): number {
    const row = this.database.db.prepare("SELECT COUNT(*) AS count FROM assistant_oauth_clients").get() as { count: number };
    return row.count;
  }

  /** Forget registrations nobody approved, so open registration cannot grow the table without bound. */
  pruneUnapprovedClients(registeredBefore: string): void {
    this.database.db.prepare(`DELETE FROM assistant_oauth_clients
      WHERE registered_at < ?
        AND NOT EXISTS (SELECT 1 FROM assistant_connector_grants grant_row WHERE grant_row.client_id = assistant_oauth_clients.client_id)`)
      .run(registeredBefore);
  }

  insertClient(client: StoredAssistantClient): void {
    this.database.db.prepare(`INSERT INTO assistant_oauth_clients
      (client_id, client_secret_hash, assistant, metadata_json, registered_at) VALUES (?, ?, ?, ?, ?)`)
      .run(client.clientId, client.secretHash, client.assistant, JSON.stringify(client.metadata), client.registeredAt);
  }

  client(clientId: string): StoredAssistantClient | null {
    const row = this.database.db.prepare(`SELECT client_id, client_secret_hash, assistant, metadata_json, registered_at
      FROM assistant_oauth_clients WHERE client_id = ?`).get(clientId) as unknown as ClientRow | undefined;
    if (!row) return null;
    return {
      clientId: row.client_id,
      secretHash: row.client_secret_hash,
      assistant: row.assistant,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      registeredAt: row.registered_at,
    };
  }

  memberRole(userId: string): TenantMemberRole | null {
    const row = this.database.db.prepare("SELECT role FROM local_workspace_members WHERE user_id = ?").get(userId) as
      | { role: TenantMemberRole }
      | undefined;
    return row?.role ?? null;
  }

  insertGrant(grant: { id: string; clientId: string; userId: string; resource: string; scope: string; createdAt: string }): void {
    this.database.db.prepare(`INSERT INTO assistant_connector_grants
      (id, client_id, user_id, resource, scope, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(grant.id, grant.clientId, grant.userId, grant.resource, grant.scope, grant.createdAt);
  }

  insertToken(token: { tokenHash: string; grantId: string; kind: AssistantTokenKind; expiresAt: string }): void {
    this.database.db.prepare(`INSERT INTO assistant_connector_tokens
      (token_hash, grant_id, kind, expires_at, rotated_at) VALUES (?, ?, ?, ?, NULL)`)
      .run(token.tokenHash, token.grantId, token.kind, token.expiresAt);
  }

  token(tokenHash: string, kind: AssistantTokenKind): StoredAssistantToken | null {
    const row = this.database.db.prepare(`SELECT token.grant_id, grant_row.client_id, grant_row.resource, grant_row.scope,
        token.expires_at, token.rotated_at, member.role, grant_row.last_used_at
      FROM assistant_connector_tokens token
      JOIN assistant_connector_grants grant_row ON grant_row.id = token.grant_id
      LEFT JOIN local_workspace_members member ON member.user_id = grant_row.user_id
      WHERE token.token_hash = ? AND token.kind = ?`).get(tokenHash, kind) as unknown as TokenRow | undefined;
    if (!row) return null;
    return {
      grantId: row.grant_id,
      clientId: row.client_id,
      resource: row.resource,
      scope: row.scope,
      expiresAt: row.expires_at,
      rotatedAt: row.rotated_at,
      approverRole: row.role,
      lastUsedAt: row.last_used_at,
    };
  }

  /**
   * Marks a refresh token as spent and keeps it only long enough to recognise a
   * second use, which is treated as theft of the whole grant.
   */
  markRotated(tokenHash: string, rotatedAt: string, retainUntil: string): void {
    this.database.db.prepare("UPDATE assistant_connector_tokens SET rotated_at = ?, expires_at = ? WHERE token_hash = ?")
      .run(rotatedAt, retainUntil, tokenHash);
  }

  deleteToken(tokenHash: string): void {
    this.database.db.prepare("DELETE FROM assistant_connector_tokens WHERE token_hash = ?").run(tokenHash);
  }

  touchGrant(grantId: string, usedAt: string): void {
    this.database.db.prepare("UPDATE assistant_connector_grants SET last_used_at = ? WHERE id = ?").run(usedAt, grantId);
  }

  deleteGrant(grantId: string): boolean {
    const result = this.database.db.prepare("DELETE FROM assistant_connector_grants WHERE id = ?").run(grantId);
    return Number(result.changes) > 0;
  }

  pruneExpiredTokens(now: string): void {
    this.database.db.prepare("DELETE FROM assistant_connector_tokens WHERE expires_at <= ?").run(now);
  }

  connections(): AssistantConnection[] {
    const rows = this.database.db.prepare(`SELECT grant_row.id, client.assistant, client.metadata_json, account.email,
        grant_row.created_at, grant_row.last_used_at
      FROM assistant_connector_grants grant_row
      JOIN assistant_oauth_clients client ON client.client_id = grant_row.client_id
      JOIN local_auth_users account ON account.id = grant_row.user_id
      ORDER BY grant_row.created_at DESC, grant_row.id`).all() as unknown as ConnectionRow[];
    return rows.map((row) => ({
      id: row.id,
      assistant: row.assistant,
      clientName: clientName(row.metadata_json),
      approvedBy: row.email,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  connection(grantId: string): AssistantConnection | null {
    return this.connections().find((connection) => connection.id === grantId) ?? null;
  }
}
