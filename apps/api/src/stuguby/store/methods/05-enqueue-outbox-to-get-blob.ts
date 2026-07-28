import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  STUGBY_PROTOCOL_VERSION,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  serializeSignedEvent,
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
import { OutboxRow, RemoteTelemetryQuery, StugubyEventLogPage, StugubyOutboxItem, boundedLimit } from "../support/01-stuguby-row-to-event-blob-digests.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

registerStugubyStoreMethods({
  enqueueOutbox(this: StugubyStoreInternals, stugubyId: string, destinationNodeId: string, event: StugubySignedEvent): void {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_outbox
        (stugby_id,destination_node_id,event_id,event_json,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)`)
        .run(stugubyId, destinationNodeId, event.eventId, serializeSignedEvent(event), now, now);
    },
  dueOutbox(this: StugubyStoreInternals, limit = 100): StugubyOutboxItem[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT id,stugby_id,destination_node_id,event_json,attempts FROM stugby_outbox
        WHERE next_attempt_at<=? ORDER BY id LIMIT ?`).all(new Date().toISOString(), boundedLimit(limit, 100, 250)) as unknown as OutboxRow[];
      return rows.map((row) => ({
        id: row.id,
        stugubyId: row.stugby_id,
        destinationNodeId: row.destination_node_id,
        event: JSON.parse(row.event_json) as StugubySignedEvent,
        attempts: row.attempts,
      }));
    },
  acknowledgeOutbox(this: StugubyStoreInternals, ids: number[]): void {
      const statement = this[stugubyStoreState].db.prepare("DELETE FROM stugby_outbox WHERE id=?");
      for (const id of ids) statement.run(id);
    },
  discardOutboxGrantEpoch(this: StugubyStoreInternals, stugubyId: string, grantId: string, throughEpoch: number): void {
      this[stugubyStoreState].db.prepare(`DELETE FROM stugby_outbox WHERE stugby_id=?
        AND json_extract(event_json,'$.grantId')=?
        AND COALESCE(json_extract(event_json,'$.grantEpoch'),0)<=?`)
        .run(stugubyId, grantId, throughEpoch);
    },
  failOutbox(this: StugubyStoreInternals, id: number, attempts: number): void {
      const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
      this[stugubyStoreState].db.prepare("UPDATE stugby_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?")
        .run(new Date(Date.now() + delayMs).toISOString(), id);
    },
  inboxEventStatus(this: StugubyStoreInternals, event: StugubySignedEvent): "new" | "duplicate" | "non-monotonic" {
      const duplicate = this[stugubyStoreState].db.prepare("SELECT 1 AS present FROM stugby_inbox WHERE authority_node_id=? AND event_id=?")
        .get(event.authorityNodeId, event.eventId) as { present: number } | undefined;
      if (duplicate) return "duplicate";
      const current = this[stugubyStoreState].db.prepare(`SELECT sequence FROM stugby_stream_sequences
        WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
        .get(event.stugubyId, event.authorityNodeId, event.streamId) as { sequence: number } | undefined;
      return current && event.sequence <= current.sequence ? "non-monotonic" : "new";
    },
  recordInboxEvent(this: StugubyStoreInternals, event: StugubySignedEvent): boolean {
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        const result = this[stugubyStoreState].db.prepare("INSERT OR IGNORE INTO stugby_inbox(authority_node_id,event_id,received_at) VALUES (?,?,?)")
          .run(event.authorityNodeId, event.eventId, new Date().toISOString());
        if (Number(result.changes) === 1) {
          this[stugubyStoreState].db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
            VALUES (?,?,?,?) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO UPDATE SET sequence=excluded.sequence
            WHERE excluded.sequence > stugby_stream_sequences.sequence`)
            .run(event.stugubyId, event.authorityNodeId, event.streamId, event.sequence);
        }
        this[stugubyStoreState].db.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) {
        this[stugubyStoreState].db.exec("ROLLBACK");
        throw error;
      }
    },
  appendEventForMember(this: StugubyStoreInternals, stugubyId: string, targetNodeId: string, event: StugubySignedEvent): number | null {
      const now = new Date().toISOString();
      const result = this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_event_log
        (stugby_id,target_node_id,event_id,event_json,created_at) VALUES (?,?,?,?,?)`)
        .run(stugubyId, targetNodeId, event.eventId, serializeSignedEvent(event), now);
      if (Number(result.changes) === 0) return null;
      return Number((this[stugubyStoreState].db.prepare("SELECT cursor FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND event_id=?")
        .get(stugubyId, targetNodeId, event.eventId) as { cursor: number }).cursor);
    },
  eventPage(this: StugubyStoreInternals, stugubyId: string, targetNodeId: string, afterCursor: number, limit = 100): StugubyEventLogPage {
      const pageSize = boundedLimit(limit, 100, 250);
      const rows = this[stugubyStoreState].db.prepare(`SELECT cursor,event_json FROM stugby_event_log
        WHERE stugby_id=? AND target_node_id=? AND cursor>? ORDER BY cursor LIMIT ?`)
        .iterate(stugubyId, targetNodeId, Math.max(0, afterCursor), pageSize + 1) as NodeJS.Iterator<{
          cursor: number;
          event_json: string;
        }>;
      const selected: Array<{ cursor: number; event_json: string }> = [];
      let encodedBytes = 0;
      let hasMore = false;
      for (const row of rows) {
        if (selected.length >= pageSize) {
          hasMore = true;
          break;
        }
        const nextBytes = Buffer.byteLength(row.event_json) + (selected.length > 0 ? 1 : 0);
        if (selected.length > 0 && encodedBytes + nextBytes > STUGBY_MAX_EVENT_PAGE_BYTES) {
          hasMore = true;
          break;
        }
        selected.push(row);
        encodedBytes += nextBytes;
      }
      return {
        events: selected.map((row) => JSON.parse(row.event_json) as StugubySignedEvent),
        cursor: selected.at(-1)?.cursor ?? afterCursor,
        hasMore,
      };
    },
  applyDatasetEvent(this: StugubyStoreInternals, event: StugubySignedEvent): { applied: boolean; deletionReceipt?: StugubyDeletionReceipt } {
      if (!event.grantId || event.grantEpoch === null) throw new Error("Dataset events require a grant and epoch");
      const grant = this.getGrant(event.grantId);
      if (!grant || grant.epoch !== event.grantEpoch || grant.revokedAt
        || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())) {
        throw new Error("Dataset event refers to an inactive or superseded grant epoch");
      }
      if (grant.stugubyId !== event.stugubyId || grant.authorityNodeId !== event.authorityNodeId) throw new Error("Dataset grant authority mismatch");
      const datasetGrant = grant.datasets.find((item) => item.dataset === event.schema && item.enabled);
      if (!datasetGrant) throw new Error("Dataset is not enabled by this grant");
      const existing = this[stugubyStoreState].db.prepare(`SELECT revision FROM stugby_remote_resources
        WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?`)
        .get(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId) as { revision: number } | undefined;
      if (existing && existing.revision >= event.revision) return { applied: false };
      if (event.operation === "tombstone") {
        this[stugubyStoreState].db.prepare(`DELETE FROM stugby_remote_resources WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?`)
          .run(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId);
        if (event.schema === "home.telemetry.v1") {
          this[stugubyStoreState].db.prepare(`DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND authority_node_id=? AND grant_id=?`)
            .run(event.stugubyId, event.authorityNodeId, event.grantId);
        }
        return { applied: true };
      }
      // A zero retention or disabled replica-cache permission means the event may
      // wake live consumers but must not be written to the durable projection.
      if (!datasetGrant.allowReplicaCache || datasetGrant.retentionDays === 0) return { applied: true };
      const receivedAt = new Date().toISOString();
      if (event.schema === "home.telemetry.v1") {
        this.insertTelemetry(event, event.payload as unknown as StugubyTelemetryPayload, receivedAt);
        return { applied: true };
      }
      const payload = event.payload as Record<string, JsonValue>;
      const publicationId = String(payload.publicationId);
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_remote_resources
        (stugby_id,authority_node_id,schema_name,resource_id,publication_id,grant_id,grant_epoch,revision,payload_json,received_at,source_occurred_at,stale)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
        ON CONFLICT(stugby_id,authority_node_id,schema_name,resource_id) DO UPDATE SET
          publication_id=excluded.publication_id,grant_id=excluded.grant_id,grant_epoch=excluded.grant_epoch,
          revision=excluded.revision,payload_json=excluded.payload_json,received_at=excluded.received_at,
          source_occurred_at=excluded.source_occurred_at,stale=0 WHERE excluded.revision>stugby_remote_resources.revision`)
        .run(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId, publicationId, event.grantId,
          event.grantEpoch, event.revision, JSON.stringify(event.payload), receivedAt, event.occurredAt);
      return { applied: true };
    },
  insertTelemetry(this: StugubyStoreInternals, event: StugubySignedEvent, payload: StugubyTelemetryPayload, receivedAt: string): void {
      this.transaction(() => {
        this[stugubyStoreState].db.prepare(`DELETE FROM stugby_remote_telemetry
          WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=? AND chunk_id=?`)
          .run(event.stugubyId, event.authorityNodeId, payload.publicationId, event.grantId, event.grantEpoch, payload.chunkId);
        const statement = this[stugubyStoreState].db.prepare(`INSERT INTO stugby_remote_telemetry
          (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
           metric_id,timestamp,value,quality,correction_of,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const sample of payload.samples) {
          statement.run(event.stugubyId, event.authorityNodeId, payload.publicationId, event.grantId, event.grantEpoch,
            payload.chunkId, sample.sensorPublicationId, sample.metricId, sample.timestamp, sample.value, sample.quality,
            sample.correctionOf ?? null, receivedAt);
        }
      });
    },
  purgeGrantData(this: StugubyStoreInternals, stugubyId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt {
      this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
        .run(stugubyId, grantId, grantEpoch);
      this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
        .run(stugubyId, grantId, grantEpoch);
      const receipt: StugubyDeletionReceipt = {
        stugubyId,
        nodeId: this.localNodeId,
        grantId,
        grantEpoch,
        deletedAt: new Date().toISOString(),
      };
      this[stugubyStoreState].db.prepare(`INSERT OR REPLACE INTO stugby_deletion_receipts
        (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
        .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
      return receipt;
    },
  listRemoteResources(this: StugubyStoreInternals, stugubyId: string): StugubyRemoteResource[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT stugby_id,authority_node_id,schema_name,resource_id,publication_id,revision,
        payload_json,received_at,source_occurred_at,stale FROM stugby_remote_resources WHERE stugby_id=?
        ORDER BY authority_node_id,publication_id,schema_name`).all(stugubyId) as unknown as Array<{
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
      const clauses = ["stugby_id=?"];
      const parameters: Array<string | number> = [query.stugubyId];
      for (const [column, value] of [
        ["authority_node_id", query.authorityNodeId],
        ["publication_id", query.publicationId],
        ["sensor_publication_id", query.sensorPublicationId],
        ["metric_id", query.metricId],
      ] as const) {
        if (value) { clauses.push(`${column}=?`); parameters.push(value); }
      }
      if (query.from) { clauses.push("timestamp>=?"); parameters.push(query.from); }
      if (query.to) { clauses.push("timestamp<=?"); parameters.push(query.to); }
      parameters.push(boundedLimit(query.limit, 5_000, 25_000));
      return this[stugubyStoreState].db.prepare(`SELECT authority_node_id AS authorityNodeId,publication_id AS publicationId,
        sensor_publication_id AS sensorPublicationId,metric_id AS metricId,timestamp,value,quality,correction_of AS correctionOf
        FROM stugby_remote_telemetry WHERE ${clauses.join(" AND ")} ORDER BY timestamp LIMIT ?`)
        .all(...parameters) as unknown as Array<Record<string, string | number | null>>;
    },
  remoteTelemetryCount(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): number {
      return Number((this[stugubyStoreState].db.prepare(`SELECT count(*) AS count FROM stugby_remote_telemetry
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
        .get(stugubyId, authorityNodeId, publicationId) as { count: number }).count);
    },
  promoteRecoveryTelemetry(this: StugubyStoreInternals, stugubyId: string, authorityNodeId: string, publicationId: string): number {
      const result = this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO measurement_samples
        (sensor_id,metric,value,canonical_unit,timestamp,source,quality)
        SELECT projection.local_id,remote.metric_id,remote.value,definition.unit,remote.timestamp,'import',remote.quality
        FROM stugby_remote_telemetry remote
        JOIN stugby_projection_ids projection
          ON projection.stugby_id=remote.stugby_id
         AND projection.authority_node_id=remote.authority_node_id
         AND projection.resource_type='sensor'
         AND projection.remote_id=remote.sensor_publication_id
        JOIN measurement_definitions definition ON definition.id=remote.metric_id
        WHERE remote.stugby_id=? AND remote.authority_node_id=? AND remote.publication_id=?`)
        .run(stugubyId, authorityNodeId, publicationId);
      return Number(result.changes);
    },
  markRemoteStale(this: StugubyStoreInternals, stugubyId: string): void {
      this[stugubyStoreState].db.prepare("UPDATE stugby_remote_resources SET stale=1 WHERE stugby_id=?").run(stugubyId);
    },
  markRemoteCurrent(this: StugubyStoreInternals, stugubyId: string): void {
      this[stugubyStoreState].db.prepare("UPDATE stugby_remote_resources SET stale=0 WHERE stugby_id=?").run(stugubyId);
    },
  purgeDepartedReplicas(this: StugubyStoreInternals, stugubyId: string): void {
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_shared_properties WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.exec("COMMIT");
      } catch (error) {
        this[stugubyStoreState].db.exec("ROLLBACK");
        throw error;
      }
    },
  enforceRetention(this: StugubyStoreInternals, stugubyId: string): void {
      const now = Date.now();
      for (const grant of this.listGrants(stugubyId)) {
        if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= now)) {
          this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
          this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
          continue;
        }
        // A designated full-recovery replica is ownership-transfer material.
        // Keep its complete archive for the lifetime of the active grant instead
        // of aging out the oldest history before a planned decommission.
        if (grant.housePolicy.recoveryMode === "full") continue;
        for (const dataset of grant.datasets) {
          if (!dataset.enabled || !dataset.allowReplicaCache || dataset.retentionDays === 0) {
            this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND schema_name=?")
              .run(stugubyId, grant.id, dataset.dataset);
            if (dataset.dataset === "home.telemetry.v1") {
              this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
            }
            continue;
          }
          const cutoff = new Date(now - dataset.retentionDays * 86_400_000).toISOString();
          this[stugubyStoreState].db.prepare(`DELETE FROM stugby_remote_resources
            WHERE stugby_id=? AND grant_id=? AND schema_name=? AND received_at<?`)
            .run(stugubyId, grant.id, dataset.dataset, cutoff);
          if (dataset.dataset === "home.telemetry.v1") {
            this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND received_at<?")
              .run(stugubyId, grant.id, cutoff);
          }
        }
      }
    },
  pullCursor(this: StugubyStoreInternals, stugubyId: string): number {
      return Number((this[stugubyStoreState].db.prepare("SELECT pull_cursor FROM stugby_federations WHERE id=?").get(stugubyId) as { pull_cursor?: number } | undefined)?.pull_cursor ?? 0);
    },
  recordSync(this: StugubyStoreInternals, stugubyId: string, cursor: number, error: string | null): void {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare(`UPDATE stugby_federations SET pull_cursor=max(pull_cursor,?),
        last_sync_at=CASE WHEN ? IS NULL THEN ? ELSE last_sync_at END,last_sync_error=?,updated_at=? WHERE id=?`)
        .run(cursor, error, now, error, now, stugubyId);
      if (error) this.markRemoteStale(stugubyId);
    },
  acceptRequest(this: StugubyStoreInternals, nodeId: string, requestId: string, expiresAt: string): boolean {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare("DELETE FROM stugby_request_replays WHERE expires_at<=?").run(now);
      const result = this[stugubyStoreState].db.prepare("INSERT OR IGNORE INTO stugby_request_replays(node_id,request_id,expires_at) VALUES (?,?,?)")
        .run(nodeId, requestId, expiresAt);
      return Number(result.changes) === 1;
    },
  registerBlob(this: StugubyStoreInternals, digest: string, byteLength: number, mediaType: string, relativePath: string): void {
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_blob_metadata(digest,byte_length,media_type,relative_path,created_at)
        VALUES (?,?,?,?,?)`).run(digest, byteLength, mediaType, relativePath, new Date().toISOString());
    },
  getBlob(this: StugubyStoreInternals, digest: string): { digest: string; byteLength: number; mediaType: string; relativePath: string } | null {
      const row = this[stugubyStoreState].db.prepare(`SELECT digest,byte_length AS byteLength,media_type AS mediaType,relative_path AS relativePath
        FROM stugby_blob_metadata WHERE digest=?`).get(digest) as unknown as { digest: string; byteLength: number; mediaType: string; relativePath: string } | undefined;
      return row ?? null;
    },
});
