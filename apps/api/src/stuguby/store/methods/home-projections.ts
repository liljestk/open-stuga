import { isSqliteFailure } from "../../../db/sqlite-failure.js";
import type { StugubyHomeProjection } from "@climate-twin/contracts";
import { randomUUID } from "node:crypto";
import type { StugubyHomeCommand, StugubyHomeCommandResult } from "@climate-twin/stuguby-protocol";
import { ProjectionResourceType, StugubyStoredHomeCommand } from "../support/store-types.js";
import { boundedLimit } from "../support/row-mappers.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    projectionId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, remoteId: string, preferredLocalId?: string): string;
    listProjectionIds(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType): Array<{
            remoteId: string;
            localId: string;
        }>;
    removeProjectionIds(stugubyId: string, authorityNodeId: string, projections: Array<{
            resourceType: ProjectionResourceType;
            localId: string;
        }>): number;
    projectionRemoteId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, localId: string): string;
    homeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    bumpHomeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    pendingHomeCommandFor(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyStoredHomeCommand | null;
    enqueueHomeCommand(command: StugubyHomeCommand): StugubyStoredHomeCommand;
    getHomeCommand(commandId: string): StugubyStoredHomeCommand | null;
    pendingHomeCommands(stugubyId: string, limit?: number): StugubyStoredHomeCommand[];
    homeCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    homeCommandCountsFor(stugubyId: string, authorityNodeId: string, publicationId: string): {
            pending: number;
            conflicts: number;
        };
    deferHomeCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    completeHomeCommand(result: StugubyHomeCommandResult): StugubyStoredHomeCommand;
    cancelPendingHomeCommands(stugubyId: string, now?: string): number;
    cancelPendingHomeCommandsFor(stugubyId: string, authorityNodeId: string, publicationId: string, now?: string): number;
    upsertHomeProjection(projection: StugubyHomeProjection): StugubyHomeProjection;
    getHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
    listHomeProjections(stugubyId: string): StugubyHomeProjection[];
    removeHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
  }

  interface StugubyStoreCore {
    projectionId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, remoteId: string, preferredLocalId?: string): string;
    listProjectionIds(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType): Array<{
            remoteId: string;
            localId: string;
        }>;
    removeProjectionIds(stugubyId: string, authorityNodeId: string, projections: Array<{
            resourceType: ProjectionResourceType;
            localId: string;
        }>): number;
    projectionRemoteId(stugubyId: string, authorityNodeId: string, resourceType: ProjectionResourceType, localId: string): string;
    homeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    bumpHomeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    pendingHomeCommandFor(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyStoredHomeCommand | null;
    enqueueHomeCommand(command: StugubyHomeCommand): StugubyStoredHomeCommand;
    getHomeCommand(commandId: string): StugubyStoredHomeCommand | null;
    pendingHomeCommands(stugubyId: string, limit?: number): StugubyStoredHomeCommand[];
    homeCommandCounts(stugubyId: string): {
            pending: number;
            conflicts: number;
        };
    homeCommandCountsFor(stugubyId: string, authorityNodeId: string, publicationId: string): {
            pending: number;
            conflicts: number;
        };
    deferHomeCommand(commandId: string, attempts: number, nextAttemptAt: string): void;
    completeHomeCommand(result: StugubyHomeCommandResult): StugubyStoredHomeCommand;
    cancelPendingHomeCommands(stugubyId: string, now?: string): number;
    cancelPendingHomeCommandsFor(stugubyId: string, authorityNodeId: string, publicationId: string, now?: string): number;
    upsertHomeProjection(projection: StugubyHomeProjection): StugubyHomeProjection;
    getHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
    listHomeProjections(stugubyId: string): StugubyHomeProjection[];
    removeHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null;
  }
}

registerStugubyStoreMethods({
  projectionId(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: ProjectionResourceType,
      remoteId: string,
      preferredLocalId?: string,
    ): string {
      const state = this[stugubyStoreState];
      const get = (): string | null => {
        const row = state.db.prepare(`SELECT local_id FROM stugby_projection_ids
          WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND remote_id=?`)
          .get(stugubyId, authorityNodeId, resourceType, remoteId) as { local_id: string } | undefined;
        return row?.local_id ?? null;
      };
      const existing = get();
      if (existing) return existing;
      const now = new Date().toISOString();
      const insert = (localId: string): boolean => {
        try {
          state.db.prepare(`INSERT INTO stugby_projection_ids
            (stugby_id,authority_node_id,resource_type,remote_id,local_id,created_at) VALUES (?,?,?,?,?,?)`)
            .run(stugubyId, authorityNodeId, resourceType, remoteId, localId, now);
          return true;
        } catch (error) {
          if (isSqliteFailure(error, "unique")) return false;
          throw error;
        }
      };
      if (preferredLocalId && insert(preferredLocalId)) return preferredLocalId;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const localId = randomUUID();
        if (insert(localId)) return localId;
        const concurrent = get();
        if (concurrent) return concurrent;
      }
      throw new Error("Could not allocate a local Stuguby projection id");
    },
  listProjectionIds(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: ProjectionResourceType,
    ): Array<{ remoteId: string; localId: string }> {
      const rows = this[stugubyStoreState].db.prepare(`SELECT remote_id,local_id FROM stugby_projection_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? ORDER BY remote_id`)
        .all(stugubyId, authorityNodeId, resourceType) as Array<{ remote_id: string; local_id: string }>;
      return rows.map((row) => ({ remoteId: row.remote_id, localId: row.local_id }));
    },
  removeProjectionIds(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      projections: Array<{ resourceType: ProjectionResourceType; localId: string }>,
    ): number {
      const state = this[stugubyStoreState];
      if (projections.length === 0) return 0;
      const remove = state.db.prepare(`DELETE FROM stugby_projection_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`);
      state.db.exec("BEGIN IMMEDIATE");
      try {
        let removed = 0;
        for (const projection of projections) {
          removed += Number(remove.run(
            stugubyId,
            authorityNodeId,
            projection.resourceType,
            projection.localId,
          ).changes);
        }
        state.db.exec("COMMIT");
        return removed;
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
    },
  projectionRemoteId(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: ProjectionResourceType,
      localId: string,
    ): string {
      const existing = this[stugubyStoreState].db.prepare(`SELECT remote_id FROM stugby_projection_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
        .get(stugubyId, authorityNodeId, resourceType, localId) as { remote_id: string } | undefined;
      if (existing) return existing.remote_id;
      const remoteId = randomUUID();
      const allocated = this.projectionId(stugubyId, authorityNodeId, resourceType, remoteId, localId);
      if (allocated !== localId) throw new Error("Could not bind the local Home item to its shared id");
      return remoteId;
    },
  homeRevision(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): number {
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      state.db.prepare(`INSERT OR IGNORE INTO stugby_home_revisions
        (stugby_id,authority_node_id,publication_id,revision,updated_at) VALUES (?,?,?,1,?)`)
        .run(stugubyId, authorityNodeId, publicationId, now);
      return Number((state.db.prepare(`SELECT revision FROM stugby_home_revisions
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
  cancelPendingHomeCommandsFor(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      publicationId: string,
      now = new Date().toISOString(),
    ): number {
      return Number(this[stugubyStoreState].db.prepare(`UPDATE stugby_home_commands SET status='cancelled',updated_at=?
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND status='pending'`)
        .run(now, stugubyId, authorityNodeId, publicationId).changes);
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
});
