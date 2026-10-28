import type { StugubyPropertyAdoption, StugubyAuthorityTransfer } from "@climate-twin/contracts";
import { randomUUID } from "node:crypto";
import type { StugubyPropertyCommand, StugubyPropertyEntityKind, StugubySharedProperty, JsonValue, StugubyPropertyCommandResult, StugubyPropertyConflict } from "@climate-twin/stuguby-protocol";
import { SharedPropertyRow, StugubyStoredPropertyCommand } from "../support/store-types.js";
import { boundedLimit } from "../support/row-mappers.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    getSharedProperty(stugubyId: string): StugubySharedProperty | null;
    saveSharedProperty(property: StugubySharedProperty, expectedRevision?: number): StugubySharedProperty;
    getPropertyAdoption(stugubyId: string): StugubyPropertyAdoption | null;
    adoptProperty(stugubyId: string, localPropertyId: string, revision: number, now?: string): StugubyPropertyAdoption;
    releaseDetachedProperty(localPropertyId: string, exceptStugubyId: string): number;
    markPropertyMaterialized(stugubyId: string, revision: number): void;
    detachProperty(stugubyId: string, now?: string): StugubyPropertyAdoption;
    enqueuePropertyCommand(command: StugubyPropertyCommand): StugubyStoredPropertyCommand;
    pendingPropertyCommandFor(stugubyId: string, actorNodeId: string, entityKind: StugubyPropertyEntityKind, entityId: string): StugubyStoredPropertyCommand | null;
    getPropertyCommand(commandId: string): StugubyStoredPropertyCommand | null;
    pendingPropertyCommands(stugubyId: string, limit?: number): StugubyStoredPropertyCommand[];
    propertyCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    deferPropertyCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    cancelPendingPropertyCommands(stugubyId: string, now?: string): number;
    completePropertyCommand(result: StugubyPropertyCommandResult): StugubyStoredPropertyCommand;
    propertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string): Record<string, number>;
    setPropertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, fields: readonly string[], revision: number): void;
    listPropertyConflicts(stugubyId: string, includeResolved?: boolean): StugubyPropertyConflict[];
    resolvePropertyConflict(stugubyId: string, commandId: string, now?: string): boolean;
    saveMigrationSnapshot(stugubyId: string, sourcePropertyId: string, targetPropertyId: string, snapshot: JsonValue, now?: string): string;
    saveAuthorityTransfer(transfer: StugubyAuthorityTransfer): StugubyAuthorityTransfer;
    listAuthorityTransfers(stugubyId: string): StugubyAuthorityTransfer[];
  }

  interface StugubyStoreCore {
    getSharedProperty(stugubyId: string): StugubySharedProperty | null;
    saveSharedProperty(property: StugubySharedProperty, expectedRevision?: number): StugubySharedProperty;
    getPropertyAdoption(stugubyId: string): StugubyPropertyAdoption | null;
    adoptProperty(stugubyId: string, localPropertyId: string, revision: number, now?: string): StugubyPropertyAdoption;
    releaseDetachedProperty(localPropertyId: string, exceptStugubyId: string): number;
    markPropertyMaterialized(stugubyId: string, revision: number): void;
    detachProperty(stugubyId: string, now?: string): StugubyPropertyAdoption;
    enqueuePropertyCommand(command: StugubyPropertyCommand): StugubyStoredPropertyCommand;
    pendingPropertyCommandFor(stugubyId: string, actorNodeId: string, entityKind: StugubyPropertyEntityKind, entityId: string): StugubyStoredPropertyCommand | null;
    getPropertyCommand(commandId: string): StugubyStoredPropertyCommand | null;
    pendingPropertyCommands(stugubyId: string, limit?: number): StugubyStoredPropertyCommand[];
    propertyCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    deferPropertyCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    cancelPendingPropertyCommands(stugubyId: string, now?: string): number;
    completePropertyCommand(result: StugubyPropertyCommandResult): StugubyStoredPropertyCommand;
    propertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string): Record<string, number>;
    setPropertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, fields: readonly string[], revision: number): void;
    listPropertyConflicts(stugubyId: string, includeResolved?: boolean): StugubyPropertyConflict[];
    resolvePropertyConflict(stugubyId: string, commandId: string, now?: string): boolean;
    saveMigrationSnapshot(stugubyId: string, sourcePropertyId: string, targetPropertyId: string, snapshot: JsonValue, now?: string): string;
    saveAuthorityTransfer(transfer: StugubyAuthorityTransfer): StugubyAuthorityTransfer;
    listAuthorityTransfers(stugubyId: string): StugubyAuthorityTransfer[];
  }
}

registerStugubyStoreMethods({
  getSharedProperty(this: StugubyStoreInternals, stugubyId: string): StugubySharedProperty | null {
      const row = this[stugubyStoreState].db.prepare("SELECT property_json FROM stugby_shared_properties WHERE stugby_id=?")
        .get(stugubyId) as unknown as SharedPropertyRow | undefined;
      return row ? JSON.parse(row.property_json) as StugubySharedProperty : null;
    },
  saveSharedProperty(this: StugubyStoreInternals, property: StugubySharedProperty, expectedRevision?: number): StugubySharedProperty {
      const existing = this.getSharedProperty(property.stugubyId);
      if (expectedRevision !== undefined && existing?.revision !== expectedRevision) {
        throw new Error(`Stuguby shared property revision conflict; current revision is ${existing?.revision ?? 0}`);
      }
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(stugby_id) DO UPDATE SET revision=excluded.revision,property_json=excluded.property_json,updated_at=excluded.updated_at
        WHERE excluded.revision > stugby_shared_properties.revision`)
        .run(property.stugubyId, property.revision, JSON.stringify(property), property.updatedAt);
      return this.getSharedProperty(property.stugubyId)!;
    },
  getPropertyAdoption(this: StugubyStoreInternals, stugubyId: string): StugubyPropertyAdoption | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_property_adoptions WHERE stugby_id=?")
        .get(stugubyId) as {
          stugby_id: string;
          local_property_id: string;
          state: StugubyPropertyAdoption["state"];
          adopted_at: string;
          detached_at: string | null;
          last_materialized_revision: number;
        } | undefined;
      return row ? {
        stugubyId: row.stugby_id,
        localPropertyId: row.local_property_id,
        state: row.state,
        adoptedAt: row.adopted_at,
        detachedAt: row.detached_at,
        lastMaterializedRevision: Number(row.last_materialized_revision),
      } : null;
    },
  adoptProperty(this: StugubyStoreInternals, stugubyId: string, localPropertyId: string, revision: number, now = new Date().toISOString()): StugubyPropertyAdoption {
      const existing = this.getPropertyAdoption(stugubyId);
      if (existing && existing.localPropertyId !== localPropertyId) {
        throw new Error("This Stuguby is already adopted by another local Property");
      }
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_property_adoptions
        (stugby_id,local_property_id,state,adopted_at,detached_at,last_materialized_revision)
        VALUES (?,?,'adopted',?,NULL,?)
        ON CONFLICT(stugby_id) DO UPDATE SET state='adopted',detached_at=NULL,
          last_materialized_revision=MAX(stugby_property_adoptions.last_materialized_revision,excluded.last_materialized_revision)`)
        .run(stugubyId, localPropertyId, now, revision);
      return this.getPropertyAdoption(stugubyId)!;
    },
  releaseDetachedProperty(this: StugubyStoreInternals, localPropertyId: string, exceptStugubyId: string): number {
      return Number(this[stugubyStoreState].db.prepare(`DELETE FROM stugby_property_adoptions
        WHERE local_property_id=? AND stugby_id<>? AND state='detached'`)
        .run(localPropertyId, exceptStugubyId).changes);
    },
  markPropertyMaterialized(this: StugubyStoreInternals, stugubyId: string, revision: number): void {
      this[stugubyStoreState].db.prepare(`UPDATE stugby_property_adoptions
        SET last_materialized_revision=MAX(last_materialized_revision,?) WHERE stugby_id=? AND state='adopted'`)
        .run(revision, stugubyId);
    },
  detachProperty(this: StugubyStoreInternals, stugubyId: string, now = new Date().toISOString()): StugubyPropertyAdoption {
      const changed = this[stugubyStoreState].db.prepare(`UPDATE stugby_property_adoptions
        SET state='detached',detached_at=? WHERE stugby_id=? AND state='adopted'`).run(now, stugubyId);
      if (Number(changed.changes) !== 1) throw new Error("An adopted Stuguby Property was not found");
      return this.getPropertyAdoption(stugubyId)!;
    },
  enqueuePropertyCommand(this: StugubyStoreInternals, command: StugubyPropertyCommand): StugubyStoredPropertyCommand {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_property_commands
        (id,stugby_id,actor_node_id,command_json,status,result_json,attempts,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,'pending',NULL,0,?,?,?)
        ON CONFLICT(id) DO UPDATE SET command_json=excluded.command_json,
          attempts=0,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at
        WHERE stugby_property_commands.status='pending'`)
        .run(command.id, command.stugubyId, command.actorNodeId, JSON.stringify(command), now, command.createdAt, now);
      return this.getPropertyCommand(command.id)!;
    },
  pendingPropertyCommandFor(this: StugubyStoreInternals,
      stugubyId: string,
      actorNodeId: string,
      entityKind: StugubyPropertyEntityKind,
      entityId: string,
    ): StugubyStoredPropertyCommand | null {
      const row = this[stugubyStoreState].db.prepare(`SELECT id FROM stugby_property_commands
        WHERE stugby_id=? AND actor_node_id=? AND status='pending'
          AND json_extract(command_json,'$.entityKind')=?
          AND json_extract(command_json,'$.entityId')=?
        ORDER BY created_at DESC,id DESC LIMIT 1`)
        .get(stugubyId, actorNodeId, entityKind, entityId) as { id: string } | undefined;
      return row ? this.getPropertyCommand(row.id) : null;
    },
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
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      const changed = state.db.prepare(`UPDATE stugby_property_commands
        SET status=?,result_json=?,updated_at=? WHERE id=?`)
        .run(result.status, JSON.stringify(result), now, result.commandId);
      if (Number(changed.changes) !== 1) throw new Error("Property command was not found");
      if (result.conflict) {
        state.db.prepare(`INSERT INTO stugby_property_conflicts
          (command_id,stugby_id,conflict_json,detected_at,resolved_at) VALUES (?,?,?,?,NULL)
          ON CONFLICT(command_id) DO UPDATE SET conflict_json=excluded.conflict_json,
            detected_at=excluded.detected_at,resolved_at=NULL`)
          .run(result.commandId, result.property.stugubyId, JSON.stringify(result.conflict), result.conflict.detectedAt);
      }
      return this.getPropertyCommand(result.commandId)!;
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
});
