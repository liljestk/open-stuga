import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  STUGBY_PROTOCOL_VERSION,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  type JsonValue,
  type StugubyDataset,
  type StugubyDeletionReceipt,
  type StugubyInvitation,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRemoteResource,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
} from "@climate-twin/stuguby-protocol";
import { StugubyAuthorityTransfer, StugubyHomeProjection, StugubyStoredHomeCommand, StugubyStoredPropertyCommand, boundedLimit } from "../support/01-stuguby-row-to-event-blob-digests.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

registerStugubyStoreMethods({
  getPropertyCommand(this: StugubyStoreInternals, commandId: string): StugubyStoredPropertyCommand | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_property_commands WHERE id=?").get(commandId) as {
        command_json: string;
        status: StugubyStoredPropertyCommand["status"];
        result_json: string | null;
        attempts: number;
        next_attempt_at: string;
        updated_at: string;
      } | undefined;
      return row ? {
        command: JSON.parse(row.command_json) as StugubyPropertyCommand,
        status: row.status,
        result: row.result_json ? JSON.parse(row.result_json) as StugubyPropertyCommandResult : null,
        attempts: Number(row.attempts),
        nextAttemptAt: row.next_attempt_at,
        updatedAt: row.updated_at,
      } : null;
    },
  pendingPropertyCommands(this: StugubyStoreInternals, stugubyId: string, limit = 100): StugubyStoredPropertyCommand[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT id FROM stugby_property_commands
        WHERE stugby_id=? AND status='pending' AND next_attempt_at<=?
        ORDER BY created_at,id LIMIT ?`).all(stugubyId, new Date().toISOString(), boundedLimit(limit, 100, 250)) as Array<{ id: string }>;
      return rows.flatMap((row) => {
        const command = this.getPropertyCommand(row.id);
        return command ? [command] : [];
      });
    },
  propertyCommandCounts(this: StugubyStoreInternals, stugubyId: string): { pending: number; conflicts: number } {
      const row = this[stugubyStoreState].db.prepare(`SELECT
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='conflict' THEN 1 ELSE 0 END) AS conflicts
        FROM stugby_property_commands WHERE stugby_id=?`).get(stugubyId) as { pending: number | null; conflicts: number | null };
      return { pending: Number(row.pending ?? 0), conflicts: Number(row.conflicts ?? 0) };
    },
  deferPropertyCommand(this: StugubyStoreInternals, commandId: string, attempts: number, nextAttemptAt: string): void {
      this[stugubyStoreState].db.prepare(`UPDATE stugby_property_commands SET attempts=?,next_attempt_at=?,updated_at=?
        WHERE id=? AND status='pending'`).run(attempts, nextAttemptAt, new Date().toISOString(), commandId);
    },
  cancelPendingPropertyCommands(this: StugubyStoreInternals, stugubyId: string, now = new Date().toISOString()): number {
      return Number(this[stugubyStoreState].db.prepare(`UPDATE stugby_property_commands SET status='cancelled',updated_at=?
        WHERE stugby_id=? AND status='pending'`).run(now, stugubyId).changes);
    },
  completePropertyCommand(this: StugubyStoreInternals, result: StugubyPropertyCommandResult): StugubyStoredPropertyCommand {
      const now = new Date().toISOString();
      const changed = this[stugubyStoreState].db.prepare(`UPDATE stugby_property_commands
        SET status=?,result_json=?,updated_at=? WHERE id=?`)
        .run(result.status, JSON.stringify(result), now, result.commandId);
      if (Number(changed.changes) !== 1) throw new Error("Property command was not found");
      if (result.conflict) {
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_property_conflicts
          (command_id,stugby_id,conflict_json,detected_at,resolved_at) VALUES (?,?,?,?,NULL)
          ON CONFLICT(command_id) DO UPDATE SET conflict_json=excluded.conflict_json,
            detected_at=excluded.detected_at,resolved_at=NULL`)
          .run(result.commandId, result.property.stugubyId, JSON.stringify(result.conflict), result.conflict.detectedAt);
      }
      return this.getPropertyCommand(result.commandId)!;
    },
  homeRevision(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): number {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_home_revisions
        (stugby_id,authority_node_id,publication_id,revision,updated_at) VALUES (?,?,?,1,?)`)
        .run(stugubyId, authorityNodeId, publicationId, now);
      return Number((this[stugubyStoreState].db.prepare(`SELECT revision FROM stugby_home_revisions
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
        .get(stugubyId, authorityNodeId, publicationId) as { revision: number }).revision);
    },
  bumpHomeRevision(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): number {
      this.homeRevision(stugubyId, authorityNodeId, publicationId);
      this[stugubyStoreState].db.prepare(`UPDATE stugby_home_revisions SET revision=revision+1,updated_at=?
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
        .run(new Date().toISOString(), stugubyId, authorityNodeId, publicationId);
      return this.homeRevision(stugubyId, authorityNodeId, publicationId);
    },
  pendingHomeCommandFor(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      publicationId: string,
    ): StugubyStoredHomeCommand | null {
      const row = this[stugubyStoreState].db.prepare(`SELECT id FROM stugby_home_commands
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND status='pending'`)
        .get(stugubyId, authorityNodeId, publicationId) as { id: string } | undefined;
      return row ? this.getHomeCommand(row.id) : null;
    },
  enqueueHomeCommand(this: StugubyStoreInternals, command: StugubyHomeCommand): StugubyStoredHomeCommand {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_home_commands
        (id,stugby_id,authority_node_id,publication_id,command_json,status,result_json,attempts,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',NULL,0,?,?,?)
        ON CONFLICT(stugby_id,authority_node_id,publication_id) DO UPDATE SET
          id=excluded.id,command_json=excluded.command_json,status='pending',result_json=NULL,
          attempts=0,next_attempt_at=excluded.next_attempt_at,created_at=excluded.created_at,updated_at=excluded.updated_at`)
        .run(command.id, command.stugubyId, command.authorityNodeId, command.publicationId,
          JSON.stringify(command), now, command.createdAt, now);
      return this.getHomeCommand(command.id)!;
    },
  getHomeCommand(this: StugubyStoreInternals, commandId: string): StugubyStoredHomeCommand | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_home_commands WHERE id=?").get(commandId) as {
        command_json: string;
        status: StugubyStoredHomeCommand["status"];
        result_json: string | null;
        attempts: number;
        next_attempt_at: string;
        updated_at: string;
      } | undefined;
      return row ? {
        command: JSON.parse(row.command_json) as StugubyHomeCommand,
        status: row.status,
        result: row.result_json ? JSON.parse(row.result_json) as StugubyHomeCommandResult : null,
        attempts: Number(row.attempts),
        nextAttemptAt: row.next_attempt_at,
        updatedAt: row.updated_at,
      } : null;
    },
  pendingHomeCommands(this: StugubyStoreInternals, stugubyId: string, limit = 100): StugubyStoredHomeCommand[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT id FROM stugby_home_commands
        WHERE stugby_id=? AND status='pending' AND next_attempt_at<=?
        ORDER BY created_at,id LIMIT ?`).all(stugubyId, new Date().toISOString(), boundedLimit(limit, 100, 250)) as Array<{ id: string }>;
      return rows.flatMap((row) => {
        const command = this.getHomeCommand(row.id);
        return command ? [command] : [];
      });
    },
  homeCommandCounts(this: StugubyStoreInternals, stugubyId: string): { pending: number; conflicts: number } {
      const row = this[stugubyStoreState].db.prepare(`SELECT
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='conflict' THEN 1 ELSE 0 END) AS conflicts
        FROM stugby_home_commands WHERE stugby_id=?`).get(stugubyId) as { pending: number | null; conflicts: number | null };
      return { pending: Number(row.pending ?? 0), conflicts: Number(row.conflicts ?? 0) };
    },
  homeCommandCountsFor(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      publicationId: string,
    ): { pending: number; conflicts: number } {
      const row = this[stugubyStoreState].db.prepare(`SELECT
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='conflict' THEN 1 ELSE 0 END) AS conflicts
        FROM stugby_home_commands
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
        .get(stugubyId, authorityNodeId, publicationId) as { pending: number | null; conflicts: number | null };
      return { pending: Number(row.pending ?? 0), conflicts: Number(row.conflicts ?? 0) };
    },
  deferHomeCommand(this: StugubyStoreInternals, commandId: string, attempts: number, nextAttemptAt: string): void {
      this[stugubyStoreState].db.prepare(`UPDATE stugby_home_commands SET attempts=?,next_attempt_at=?,updated_at=?
        WHERE id=? AND status='pending'`).run(attempts, nextAttemptAt, new Date().toISOString(), commandId);
    },
  completeHomeCommand(this: StugubyStoreInternals, result: StugubyHomeCommandResult): StugubyStoredHomeCommand {
      const changed = this[stugubyStoreState].db.prepare(`UPDATE stugby_home_commands SET status=?,result_json=?,updated_at=?
        WHERE id=?`).run(result.status, JSON.stringify(result), new Date().toISOString(), result.commandId);
      if (Number(changed.changes) !== 1) throw new Error("Home command was not found");
      return this.getHomeCommand(result.commandId)!;
    },
  cancelPendingHomeCommands(this: StugubyStoreInternals, stugubyId: string, now = new Date().toISOString()): number {
      return Number(this[stugubyStoreState].db.prepare(`UPDATE stugby_home_commands SET status='cancelled',updated_at=?
        WHERE stugby_id=? AND status='pending'`).run(now, stugubyId).changes);
    },
  propertyFieldRevisions(this: StugubyStoreInternals, stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string): Record<string, number> {
      const rows = this[stugubyStoreState].db.prepare(`SELECT field_name,revision FROM stugby_property_entity_fields
        WHERE stugby_id=? AND entity_kind=? AND entity_id=?`)
        .all(stugubyId, entityKind, entityId) as Array<{ field_name: string; revision: number }>;
      return Object.fromEntries(rows.map((row) => [row.field_name, Number(row.revision)]));
    },
  setPropertyFieldRevisions(this: StugubyStoreInternals,
      stugubyId: string,
      entityKind: StugubyPropertyEntityKind,
      entityId: string,
      fields: readonly string[],
      revision: number,
    ): void {
      const statement = this[stugubyStoreState].db.prepare(`INSERT INTO stugby_property_entity_fields
        (stugby_id,entity_kind,entity_id,field_name,revision) VALUES (?,?,?,?,?)
        ON CONFLICT(stugby_id,entity_kind,entity_id,field_name) DO UPDATE SET revision=excluded.revision`);
      for (const field of fields) statement.run(stugubyId, entityKind, entityId, field, revision);
    },
  listPropertyConflicts(this: StugubyStoreInternals, stugubyId: string, includeResolved = false): StugubyPropertyConflict[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT conflict_json,resolved_at FROM stugby_property_conflicts
        WHERE stugby_id=? ${includeResolved ? "" : "AND resolved_at IS NULL"}
        ORDER BY detected_at DESC`).all(stugubyId) as Array<{ conflict_json: string; resolved_at: string | null }>;
      return rows.map((row) => ({
        ...JSON.parse(row.conflict_json) as StugubyPropertyConflict,
        resolvedAt: row.resolved_at,
      }));
    },
  resolvePropertyConflict(this: StugubyStoreInternals, stugubyId: string, commandId: string, now = new Date().toISOString()): boolean {
      return Number(this[stugubyStoreState].db.prepare(`UPDATE stugby_property_conflicts SET resolved_at=?
        WHERE stugby_id=? AND command_id=? AND resolved_at IS NULL`).run(now, stugubyId, commandId).changes) === 1;
    },
  saveMigrationSnapshot(this: StugubyStoreInternals,
      stugubyId: string,
      sourcePropertyId: string,
      targetPropertyId: string,
      snapshot: JsonValue,
      now = new Date().toISOString(),
    ): string {
      const id = randomUUID();
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_migration_snapshots
        (id,stugby_id,source_property_id,target_property_id,snapshot_json,created_at) VALUES (?,?,?,?,?,?)`)
        .run(id, stugubyId, sourcePropertyId, targetPropertyId, JSON.stringify(snapshot), now);
      return id;
    },
  upsertHomeProjection(this: StugubyStoreInternals, projection: StugubyHomeProjection): StugubyHomeProjection {
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_home_projections
        (stugby_id,authority_node_id,publication_id,local_house_id,edit_policy,recovery_mode,recovery_state,
         designated_successor_node_id,recovery_synced_through,authority_epoch,detached_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(stugby_id,authority_node_id,publication_id) DO UPDATE SET
          local_house_id=excluded.local_house_id,edit_policy=excluded.edit_policy,recovery_mode=excluded.recovery_mode,
          recovery_state=excluded.recovery_state,designated_successor_node_id=excluded.designated_successor_node_id,
          recovery_synced_through=excluded.recovery_synced_through,authority_epoch=excluded.authority_epoch,
          detached_at=excluded.detached_at,updated_at=excluded.updated_at`)
        .run(projection.stugubyId, projection.authorityNodeId, projection.publicationId, projection.localHouseId,
          projection.editPolicy, projection.recoveryMode, projection.recoveryState, projection.designatedSuccessorNodeId,
          projection.recoverySyncedThrough, projection.authorityEpoch, projection.detachedAt, projection.updatedAt);
      return this.getHomeProjection(projection.stugubyId, projection.authorityNodeId, projection.publicationId)!;
    },
  getHomeProjection(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null {
      const row = this[stugubyStoreState].db.prepare(`SELECT * FROM stugby_home_projections
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
        .get(stugubyId, authorityNodeId, publicationId) as {
          stugby_id: string; authority_node_id: string; publication_id: string; local_house_id: string;
          edit_policy: StugubyHomeProjection["editPolicy"]; recovery_mode: StugubyHomeProjection["recoveryMode"];
          recovery_state: StugubyHomeProjection["recoveryState"]; designated_successor_node_id: string | null;
          recovery_synced_through: string | null; authority_epoch: number; detached_at: string | null; updated_at: string;
        } | undefined;
      return row ? {
        stugubyId: row.stugby_id,
        authorityNodeId: row.authority_node_id,
        publicationId: row.publication_id,
        localHouseId: row.local_house_id,
        editPolicy: row.edit_policy,
        recoveryMode: row.recovery_mode,
        recoveryState: row.recovery_state,
        designatedSuccessorNodeId: row.designated_successor_node_id,
        recoverySyncedThrough: row.recovery_synced_through,
        authorityEpoch: Number(row.authority_epoch),
        detachedAt: row.detached_at,
        updatedAt: row.updated_at,
      } : null;
    },
  listHomeProjections(this: StugubyStoreInternals, stugubyId: string): StugubyHomeProjection[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT authority_node_id,publication_id FROM stugby_home_projections
        WHERE stugby_id=? ORDER BY updated_at DESC`).all(stugubyId) as Array<{ authority_node_id: string; publication_id: string }>;
      return rows.flatMap((row) => {
        const projection = this.getHomeProjection(stugubyId, row.authority_node_id, row.publication_id);
        return projection ? [projection] : [];
      });
    },
  removeHomeProjection(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null {
      const existing = this.getHomeProjection(stugubyId, authorityNodeId, publicationId);
      if (!existing) return null;
      this[stugubyStoreState].db.prepare(`DELETE FROM stugby_home_projections
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
        .run(stugubyId, authorityNodeId, publicationId);
      return existing;
    },
  saveAuthorityTransfer(this: StugubyStoreInternals, transfer: StugubyAuthorityTransfer): StugubyAuthorityTransfer {
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_authority_transfers
        (id,stugby_id,scope,resource_id,from_node_id,to_node_id,from_epoch,to_epoch,status,snapshot_hash,requested_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at`)
        .run(transfer.id, transfer.stugubyId, transfer.scope, transfer.resourceId, transfer.fromNodeId, transfer.toNodeId,
          transfer.fromEpoch, transfer.toEpoch, transfer.status, transfer.snapshotHash, transfer.requestedAt, transfer.completedAt);
      return transfer;
    },
  listAuthorityTransfers(this: StugubyStoreInternals, stugubyId: string): StugubyAuthorityTransfer[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT * FROM stugby_authority_transfers
        WHERE stugby_id=? ORDER BY requested_at DESC`).all(stugubyId) as Array<{
          id: string; stugby_id: string; scope: StugubyAuthorityTransfer["scope"]; resource_id: string;
          from_node_id: string; to_node_id: string; from_epoch: number; to_epoch: number;
          status: StugubyAuthorityTransfer["status"]; snapshot_hash: string; requested_at: string; completed_at: string | null;
        }>;
      return rows.map((row) => ({
        id: row.id, stugubyId: row.stugby_id, scope: row.scope, resourceId: row.resource_id,
        fromNodeId: row.from_node_id, toNodeId: row.to_node_id, fromEpoch: Number(row.from_epoch),
        toEpoch: Number(row.to_epoch), status: row.status, snapshotHash: row.snapshot_hash,
        requestedAt: row.requested_at, completedAt: row.completed_at,
      }));
    },
  nextSequence(this: StugubyStoreInternals, stugubyId: string, streamId: string): number {
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
        VALUES (?,?,?,0) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO NOTHING`)
        .run(stugubyId, this.localNodeId, streamId);
      this[stugubyStoreState].db.prepare(`UPDATE stugby_stream_sequences SET sequence=sequence+1
        WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`).run(stugubyId, this.localNodeId, streamId);
      return Number((this[stugubyStoreState].db.prepare(`SELECT sequence FROM stugby_stream_sequences
        WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
        .get(stugubyId, this.localNodeId, streamId) as { sequence: number }).sequence);
    },
  reserveLiveTelemetrySample(this: StugubyStoreInternals, stugubyId: string, grantId: string, utcHour: string, maximum: number): boolean {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_live_telemetry_usage
        (stugby_id,grant_id,utc_hour,sample_count,updated_at) VALUES (?,?,?,0,?)`)
        .run(stugubyId, grantId, utcHour, now);
      const result = this[stugubyStoreState].db.prepare(`UPDATE stugby_live_telemetry_usage
        SET sample_count=sample_count+1,updated_at=?
        WHERE stugby_id=? AND grant_id=? AND utc_hour=? AND sample_count<?`)
        .run(now, stugubyId, grantId, utcHour, maximum);
      return Number(result.changes) === 1;
    },
});
