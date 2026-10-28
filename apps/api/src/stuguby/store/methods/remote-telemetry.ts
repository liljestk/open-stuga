import type { JsonValue, StugubyDataset, StugubyDeletionReceipt, StugubyRemoteResource, StugubySignedEvent, StugubyTelemetryPayload } from "@climate-twin/stuguby-protocol";
import { boundedLimit } from "../support/row-mappers.js";
import { RemoteTelemetryQuery } from "../support/store-types.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";
import { withStugubySavepoint } from "../savepoint.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    reserveLiveTelemetrySample(stugubyId: string, grantId: string, utcHour: string, maximum: number): boolean;
    insertTelemetry(event: StugubySignedEvent, payload: StugubyTelemetryPayload, receivedAt: string): void;
    purgeGrantData(stugubyId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt;
    listRemoteResources(stugubyId: string): StugubyRemoteResource[];
    remoteTelemetry(query: RemoteTelemetryQuery): Array<Record<string, string | number | null>>;
    remoteTelemetryCount(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    promoteRecoveryTelemetry(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    markRemoteStale(stugubyId: string): void;
    markRemoteCurrent(stugubyId: string): void;
    purgeDepartedReplicas(stugubyId: string): void;
    enforceRetention(stugubyId: string): void;
  }

  interface StugubyStoreCore {
    reserveLiveTelemetrySample(stugubyId: string, grantId: string, utcHour: string, maximum: number): boolean;
    purgeGrantData(stugubyId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt;
    listRemoteResources(stugubyId: string): StugubyRemoteResource[];
    remoteTelemetry(query: RemoteTelemetryQuery): Array<Record<string, string | number | null>>;
    remoteTelemetryCount(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    promoteRecoveryTelemetry(stugubyId: string, authorityNodeId: string, publicationId: string): number;
    markRemoteStale(stugubyId: string): void;
    markRemoteCurrent(stugubyId: string): void;
    purgeDepartedReplicas(stugubyId: string): void;
    enforceRetention(stugubyId: string): void;
  }
}

registerStugubyStoreMethods({
  reserveLiveTelemetrySample(this: StugubyStoreInternals, stugubyId: string, grantId: string, utcHour: string, maximum: number): boolean {
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      state.db.prepare(`INSERT OR IGNORE INTO stugby_live_telemetry_usage
        (stugby_id,grant_id,utc_hour,sample_count,updated_at) VALUES (?,?,?,0,?)`)
        .run(stugubyId, grantId, utcHour, now);
      const result = state.db.prepare(`UPDATE stugby_live_telemetry_usage
        SET sample_count=sample_count+1,updated_at=?
        WHERE stugby_id=? AND grant_id=? AND utc_hour=? AND sample_count<?`)
        .run(now, stugubyId, grantId, utcHour, maximum);
      return Number(result.changes) === 1;
    },
  insertTelemetry(this: StugubyStoreInternals, event: StugubySignedEvent, payload: StugubyTelemetryPayload, receivedAt: string): void {
      const state = this[stugubyStoreState];
      if (!event.grantId || event.grantEpoch === null) throw new Error("Telemetry events require a grant and epoch");
      const db = state.db;
      const operation = (): void => {
        const scope = [
          event.stugubyId,
          event.authorityNodeId,
          payload.publicationId,
          event.grantId!,
          event.grantEpoch!,
        ] as const;
        const beginStaging = (): void => {
          state.db.prepare(`INSERT INTO stugby_remote_telemetry_epochs
            (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,state,started_at,completed_at)
            VALUES (?,?,?,?,?,'awaiting-terminal',?,NULL)
            ON CONFLICT(stugby_id,authority_node_id,publication_id,grant_id,grant_epoch) DO UPDATE SET
              state=CASE
                WHEN stugby_remote_telemetry_epochs.state='complete' THEN 'refreshing'
                ELSE stugby_remote_telemetry_epochs.state
              END,
              started_at=CASE
                WHEN stugby_remote_telemetry_epochs.state='complete' THEN excluded.started_at
                ELSE stugby_remote_telemetry_epochs.started_at
              END`).run(...scope, receivedAt);
        };
        const stageSamples = (streamKind: "snapshot" | "live"): void => {
          state.db.prepare(`DELETE FROM stugby_remote_telemetry_staging
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=?
              AND grant_epoch=? AND chunk_id=?`).run(...scope, payload.chunkId);
          const stage = state.db.prepare(`INSERT INTO stugby_remote_telemetry_staging
            (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
             metric_id,timestamp,value,quality,correction_of,received_at,stream_kind)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          for (const sample of payload.samples) {
            stage.run(...scope, payload.chunkId, sample.sensorPublicationId, sample.metricId, sample.timestamp,
              sample.value, sample.quality, sample.correctionOf ?? null, receivedAt, streamKind);
          }
        };
        if (!payload.complete) {
          beginStaging();
          stageSamples("snapshot");
          return;
        }

        if (payload.samples.length === 0) {
          const completed = state.db.prepare(`SELECT state,terminal_event_id
            FROM stugby_remote_telemetry_epochs
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=?`)
            .get(...scope) as {
              state: "awaiting-terminal" | "complete" | "refreshing";
              terminal_event_id: string | null;
            } | undefined;
          if (completed?.state === "complete" && completed.terminal_event_id === event.eventId) return;
          // Historical and full-recovery publishers end a bounded stream with
          // an empty terminal marker. Swap the whole epoch in one SQLite
          // transaction so readers see either the former complete snapshot or
          // the newly completed one, never its individual chunks.
          state.db.prepare(`DELETE FROM stugby_remote_telemetry
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=?
              AND timestamp>=? AND timestamp<=?`).run(...scope, payload.from, payload.to);
          state.db.prepare(`INSERT INTO stugby_remote_telemetry
            (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
             metric_id,timestamp,value,quality,correction_of,received_at)
            SELECT stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
             metric_id,timestamp,value,quality,correction_of,received_at
            FROM stugby_remote_telemetry_staging
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=?
              AND stream_kind='snapshot' AND timestamp>=? AND timestamp<=?`)
            .run(...scope, payload.from, payload.to);
          state.db.prepare(`INSERT OR REPLACE INTO stugby_remote_telemetry
            (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
             metric_id,timestamp,value,quality,correction_of,received_at)
            SELECT stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
             metric_id,timestamp,value,quality,correction_of,received_at
            FROM stugby_remote_telemetry_staging
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=?
              AND stream_kind='live'`).run(...scope);
          state.db.prepare(`INSERT INTO stugby_remote_telemetry_epochs
            (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,state,started_at,completed_at,terminal_event_id)
            VALUES (?,?,?,?,?,'complete',?,?,?)
            ON CONFLICT(stugby_id,authority_node_id,publication_id,grant_id,grant_epoch) DO UPDATE SET
              state='complete',completed_at=excluded.completed_at,terminal_event_id=excluded.terminal_event_id`)
            .run(...scope, receivedAt, receivedAt, event.eventId);
          state.db.prepare(`DELETE FROM stugby_remote_telemetry_staging
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=?`).run(...scope);
          return;
        }

        // Live telemetry is already a complete one-chunk publication. It may
        // append only after that epoch's initial snapshot has reached its
        // terminal marker. Early or refresh-concurrent live chunks remain
        // staged and join the next atomic swap.
        const epochState = state.db.prepare(`SELECT state
          FROM stugby_remote_telemetry_epochs
          WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=?`)
          .get(...scope) as { state: "awaiting-terminal" | "complete" | "refreshing" } | undefined;
        if (epochState?.state !== "complete") {
          beginStaging();
          stageSamples("live");
          return;
        }
        state.db.prepare(`DELETE FROM stugby_remote_telemetry
          WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=?
            AND grant_epoch=? AND chunk_id=?`).run(...scope, payload.chunkId);
        const insert = state.db.prepare(`INSERT INTO stugby_remote_telemetry
          (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
           metric_id,timestamp,value,quality,correction_of,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const sample of payload.samples) {
          insert.run(...scope, payload.chunkId, sample.sensorPublicationId, sample.metricId, sample.timestamp,
            sample.value, sample.quality, sample.correctionOf ?? null, receivedAt);
        }
      };
      withStugubySavepoint(db, "stuguby_telemetry_swap", operation);
    },
  purgeGrantData(this: StugubyStoreInternals, stugubyId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt {
      const db = this[stugubyStoreState].db;
      const operation = (): StugubyDeletionReceipt => {
        db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
          .run(stugubyId, grantId, grantEpoch);
        db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
          .run(stugubyId, grantId, grantEpoch);
        db.prepare("DELETE FROM stugby_remote_telemetry_staging WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
          .run(stugubyId, grantId, grantEpoch);
        db.prepare("DELETE FROM stugby_remote_telemetry_epochs WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
          .run(stugubyId, grantId, grantEpoch);
        const receipt: StugubyDeletionReceipt = {
          stugubyId,
          nodeId: this.localNodeId,
          grantId,
          grantEpoch,
          deletedAt: new Date().toISOString(),
        };
        db.prepare(`INSERT OR REPLACE INTO stugby_deletion_receipts
          (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
          .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
        return receipt;
      };
      return withStugubySavepoint(db, "stuguby_grant_purge", operation);
    },
  listRemoteResources(this: StugubyStoreInternals, stugubyId: string): StugubyRemoteResource[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT resource.stugby_id AS stugby_id,
        resource.authority_node_id AS authority_node_id,resource.schema_name AS schema_name,
        resource.resource_id AS resource_id,resource.publication_id AS publication_id,
        resource.revision AS revision,resource.payload_json AS payload_json,
        resource.received_at AS received_at,resource.source_occurred_at AS source_occurred_at,
        resource.stale AS stale FROM stugby_remote_resources resource
        JOIN stugby_share_grants grant_record ON grant_record.id=resource.grant_id
          AND grant_record.epoch=resource.grant_epoch
        WHERE resource.stugby_id=? AND grant_record.revoked_at IS NULL
          AND (grant_record.expires_at IS NULL OR grant_record.expires_at>?)
        ORDER BY resource.authority_node_id,resource.publication_id,resource.schema_name`)
        .all(stugubyId, new Date().toISOString()) as unknown as Array<{
          stugby_id: string; authority_node_id: string; schema_name: StugubyDataset; resource_id: string;
          publication_id: string; revision: number; payload_json: string; received_at: string;
          source_occurred_at: string; stale: number;
        }>;
      return rows.map((row) => ({
        stugubyId: row.stugby_id,
        authorityNodeId: row.authority_node_id,
        schema: row.schema_name,
        resourceId: row.resource_id,
        publicationId: row.publication_id,
        revision: row.revision,
        payload: JSON.parse(row.payload_json) as JsonValue,
        receivedAt: row.received_at,
        sourceOccurredAt: row.source_occurred_at,
        stale: Boolean(row.stale),
      }));
    },
  remoteTelemetry(this: StugubyStoreInternals, query: RemoteTelemetryQuery): Array<Record<string, string | number | null>> {
      const clauses = ["remote.stugby_id=?"];
      const parameters: Array<string | number> = [query.stugubyId];
      for (const [column, value] of [
        ["authority_node_id", query.authorityNodeId],
        ["publication_id", query.publicationId],
        ["sensor_publication_id", query.sensorPublicationId],
        ["metric_id", query.metricId],
      ] as const) {
        if (value) { clauses.push(`remote.${column}=?`); parameters.push(value); }
      }
      if (query.from) { clauses.push("remote.timestamp>=?"); parameters.push(query.from); }
      if (query.to) { clauses.push("remote.timestamp<=?"); parameters.push(query.to); }
      clauses.push("grant_record.revoked_at IS NULL");
      clauses.push("(grant_record.expires_at IS NULL OR grant_record.expires_at>?)");
      parameters.push(new Date().toISOString());
      parameters.push(boundedLimit(query.limit, 5_000, 25_000));
      return this[stugubyStoreState].db.prepare(`SELECT remote.authority_node_id AS authorityNodeId,
        remote.publication_id AS publicationId,remote.sensor_publication_id AS sensorPublicationId,
        remote.metric_id AS metricId,remote.timestamp,remote.value,remote.quality,remote.correction_of AS correctionOf
        FROM stugby_remote_telemetry remote
        JOIN stugby_share_grants grant_record ON grant_record.id=remote.grant_id
          AND grant_record.epoch=remote.grant_epoch
        JOIN stugby_remote_telemetry_epochs epoch_state
          ON epoch_state.stugby_id=remote.stugby_id
         AND epoch_state.authority_node_id=remote.authority_node_id
         AND epoch_state.publication_id=remote.publication_id
         AND epoch_state.grant_id=remote.grant_id
         AND epoch_state.grant_epoch=remote.grant_epoch
         AND epoch_state.state IN ('complete','refreshing')
        WHERE ${clauses.join(" AND ")} ORDER BY remote.timestamp LIMIT ?`)
        .all(...parameters) as unknown as Array<Record<string, string | number | null>>;
    },
  remoteTelemetryCount(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): number {
      return Number((this[stugubyStoreState].db.prepare(`SELECT count(*) AS count FROM stugby_remote_telemetry
        remote JOIN stugby_share_grants grant_record ON grant_record.id=remote.grant_id
          AND grant_record.epoch=remote.grant_epoch
        JOIN stugby_remote_telemetry_epochs epoch_state
          ON epoch_state.stugby_id=remote.stugby_id
         AND epoch_state.authority_node_id=remote.authority_node_id
         AND epoch_state.publication_id=remote.publication_id
         AND epoch_state.grant_id=remote.grant_id
         AND epoch_state.grant_epoch=remote.grant_epoch
         AND epoch_state.state IN ('complete','refreshing')
        WHERE remote.stugby_id=? AND remote.authority_node_id=? AND remote.publication_id=?
          AND grant_record.revoked_at IS NULL
          AND (grant_record.expires_at IS NULL OR grant_record.expires_at>?)`)
        .get(stugubyId, authorityNodeId, publicationId, new Date().toISOString()) as { count: number }).count);
    },
  promoteRecoveryTelemetry(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): number {
      const result = this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO measurement_samples
        (sensor_id,metric,value,canonical_unit,timestamp,source,quality)
        SELECT projection.local_id,remote.metric_id,remote.value,definition.unit,remote.timestamp,'import',remote.quality
        FROM stugby_remote_telemetry remote
        JOIN stugby_share_grants grant_record
          ON grant_record.id=remote.grant_id
         AND grant_record.epoch=remote.grant_epoch
        JOIN stugby_remote_telemetry_epochs epoch_state
          ON epoch_state.stugby_id=remote.stugby_id
         AND epoch_state.authority_node_id=remote.authority_node_id
         AND epoch_state.publication_id=remote.publication_id
         AND epoch_state.grant_id=remote.grant_id
         AND epoch_state.grant_epoch=remote.grant_epoch
         AND epoch_state.state IN ('complete','refreshing')
        JOIN stugby_projection_ids projection
          ON projection.stugby_id=remote.stugby_id
         AND projection.authority_node_id=remote.authority_node_id
         AND projection.resource_type='sensor'
         AND projection.remote_id=remote.sensor_publication_id
        JOIN measurement_definitions definition ON definition.id=remote.metric_id
        WHERE remote.stugby_id=? AND remote.authority_node_id=? AND remote.publication_id=?
          AND grant_record.revoked_at IS NULL
          AND (grant_record.expires_at IS NULL OR grant_record.expires_at>?)`)
        .run(stugubyId, authorityNodeId, publicationId, new Date().toISOString());
      return Number(result.changes);
    },
  markRemoteStale(this: StugubyStoreInternals, stugubyId: string): void {
      this[stugubyStoreState].db.prepare("UPDATE stugby_remote_resources SET stale=1 WHERE stugby_id=?").run(stugubyId);
    },
  markRemoteCurrent(this: StugubyStoreInternals, stugubyId: string): void {
      this[stugubyStoreState].db.prepare("UPDATE stugby_remote_resources SET stale=0 WHERE stugby_id=?").run(stugubyId);
    },
  purgeDepartedReplicas(this: StugubyStoreInternals, stugubyId: string): void {
      const state = this[stugubyStoreState];
      state.db.exec("BEGIN IMMEDIATE");
      try {
        state.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_remote_telemetry_staging WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_remote_telemetry_epochs WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_shared_properties WHERE stugby_id=?").run(stugubyId);
        state.db.exec("COMMIT");
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
    },
  enforceRetention(this: StugubyStoreInternals, stugubyId: string): void {
      const state = this[stugubyStoreState];
      const now = Date.now();
      for (const grant of this.listGrants(stugubyId)) {
        if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= now)) {
          state.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
          state.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
          state.db.prepare("DELETE FROM stugby_remote_telemetry_staging WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
          state.db.prepare("DELETE FROM stugby_remote_telemetry_epochs WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
          continue;
        }
        // A designated full-recovery replica is ownership-transfer material.
        // Keep its complete archive for the lifetime of the active grant instead
        // of aging out the oldest history before a planned decommission.
        if (grant.housePolicy.recoveryMode === "full") continue;
        for (const dataset of grant.datasets) {
          if (!dataset.enabled || !dataset.allowReplicaCache || dataset.retentionDays === 0) {
            state.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND schema_name=?")
              .run(stugubyId, grant.id, dataset.dataset);
            if (dataset.dataset === "home.telemetry.v1") {
              state.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
              state.db.prepare("DELETE FROM stugby_remote_telemetry_staging WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
              state.db.prepare("DELETE FROM stugby_remote_telemetry_epochs WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
            }
            continue;
          }
          const cutoff = new Date(now - dataset.retentionDays * 86_400_000).toISOString();
          state.db.prepare(`DELETE FROM stugby_remote_resources
            WHERE stugby_id=? AND grant_id=? AND schema_name=? AND received_at<?`)
            .run(stugubyId, grant.id, dataset.dataset, cutoff);
          if (dataset.dataset === "home.telemetry.v1") {
            state.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND received_at<?")
              .run(stugubyId, grant.id, cutoff);
            state.db.prepare(`DELETE FROM stugby_remote_telemetry_staging
              WHERE stugby_id=? AND grant_id=? AND received_at<?`).run(stugubyId, grant.id, cutoff);
          }
        }
      }
    },
});
