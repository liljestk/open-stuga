import { STUGBY_MAX_EVENT_PAGE_BYTES, serializeSignedEvent, type JsonValue, type StugubyDeletionReceipt, type StugubySignedEvent, type StugubyTelemetryPayload } from "@climate-twin/stuguby-protocol";
import { OutboxRow, StugubyEventLogPage, StugubyOutboxItem } from "../support/store-types.js";
import { boundedLimit, eventBlobDigests } from "../support/row-mappers.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    enqueueOutbox(stugubyId: string, destinationNodeId: string, event: StugubySignedEvent): void;
    dueOutbox(limit?: number): StugubyOutboxItem[];
    acknowledgeOutbox(ids: number[]): void;
    discardOutboxGrantEpoch(stugubyId: string, grantId: string, throughEpoch: number): void;
    failOutbox(id: number, attempts: number): void;
    inboxEventStatus(event: StugubySignedEvent): "new" | "duplicate" | "non-monotonic";
    recordInboxEvent(event: StugubySignedEvent): boolean;
    appendEventForMember(stugubyId: string, targetNodeId: string, event: StugubySignedEvent): number | null;
    eventPage(stugubyId: string, targetNodeId: string, afterCursor: number, limit?: number): StugubyEventLogPage;
    applyDatasetEvent(event: StugubySignedEvent): {
            applied: boolean;
            deletionReceipt?: StugubyDeletionReceipt;
        };
    pullCursor(stugubyId: string): number;
    recordSync(stugubyId: string, cursor: number, error: string | null): void;
    acceptRequest(nodeId: string, requestId: string, expiresAt: string): boolean;
    acknowledgeEventCursor(stugubyId: string, nodeId: string, cursor: number): string[];
  }

  interface StugubyStoreCore {
    enqueueOutbox(stugubyId: string, destinationNodeId: string, event: StugubySignedEvent): void;
    dueOutbox(limit?: number): StugubyOutboxItem[];
    acknowledgeOutbox(ids: number[]): void;
    discardOutboxGrantEpoch(stugubyId: string, grantId: string, throughEpoch: number): void;
    failOutbox(id: number, attempts: number): void;
    inboxEventStatus(event: StugubySignedEvent): "new" | "duplicate" | "non-monotonic";
    recordInboxEvent(event: StugubySignedEvent): boolean;
    appendEventForMember(stugubyId: string, targetNodeId: string, event: StugubySignedEvent): number | null;
    eventPage(stugubyId: string, targetNodeId: string, afterCursor: number, limit?: number): StugubyEventLogPage;
    applyDatasetEvent(event: StugubySignedEvent): {
            applied: boolean;
            deletionReceipt?: StugubyDeletionReceipt;
        };
    pullCursor(stugubyId: string): number;
    recordSync(stugubyId: string, cursor: number, error: string | null): void;
    acceptRequest(nodeId: string, requestId: string, expiresAt: string): boolean;
    acknowledgeEventCursor(stugubyId: string, nodeId: string, cursor: number): string[];
  }
}

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
      const state = this[stugubyStoreState];
      const duplicate = state.db.prepare("SELECT 1 AS present FROM stugby_inbox WHERE authority_node_id=? AND event_id=?")
        .get(event.authorityNodeId, event.eventId) as { present: number } | undefined;
      if (duplicate) return "duplicate";
      const current = state.db.prepare(`SELECT sequence FROM stugby_stream_sequences
        WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
        .get(event.stugubyId, event.authorityNodeId, event.streamId) as { sequence: number } | undefined;
      return current && event.sequence <= current.sequence ? "non-monotonic" : "new";
    },
  recordInboxEvent(this: StugubyStoreInternals, event: StugubySignedEvent): boolean {
      const state = this[stugubyStoreState];
      state.db.exec("BEGIN IMMEDIATE");
      try {
        const result = state.db.prepare("INSERT OR IGNORE INTO stugby_inbox(authority_node_id,event_id,received_at) VALUES (?,?,?)")
          .run(event.authorityNodeId, event.eventId, new Date().toISOString());
        if (Number(result.changes) === 1) {
          state.db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
            VALUES (?,?,?,?) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO UPDATE SET sequence=excluded.sequence
            WHERE excluded.sequence > stugby_stream_sequences.sequence`)
            .run(event.stugubyId, event.authorityNodeId, event.streamId, event.sequence);
        }
        state.db.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
    },
  appendEventForMember(this: StugubyStoreInternals, stugubyId: string, targetNodeId: string, event: StugubySignedEvent): number | null {
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      const result = state.db.prepare(`INSERT OR IGNORE INTO stugby_event_log
        (stugby_id,target_node_id,event_id,event_json,created_at) VALUES (?,?,?,?,?)`)
        .run(stugubyId, targetNodeId, event.eventId, serializeSignedEvent(event), now);
      if (Number(result.changes) === 0) return null;
      return Number((state.db.prepare("SELECT cursor FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND event_id=?")
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
      const state = this[stugubyStoreState];
      if (!event.grantId || event.grantEpoch === null) throw new Error("Dataset events require a grant and epoch");
      const grant = this.getGrant(event.grantId);
      if (!grant || grant.epoch !== event.grantEpoch || grant.revokedAt
        || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())) {
        throw new Error("Dataset event refers to an inactive or superseded grant epoch");
      }
      if (grant.stugubyId !== event.stugubyId || grant.authorityNodeId !== event.authorityNodeId) throw new Error("Dataset grant authority mismatch");
      const datasetGrant = grant.datasets.find((item) => item.dataset === event.schema && item.enabled);
      if (!datasetGrant) throw new Error("Dataset is not enabled by this grant");
      if (event.schema === "home.telemetry.v1" && event.operation === "upsert") {
        const payload = event.payload as unknown as StugubyTelemetryPayload;
        const policy = datasetGrant.telemetry;
        if (!policy) throw new Error("Telemetry event requires an active telemetry policy");
        const selectedSensors = new Set(policy.sensorPublicationIds);
        const selectedMetrics = new Set(policy.metricIds);
        for (const sample of payload.samples) {
          if (selectedSensors.size > 0 && !selectedSensors.has(sample.sensorPublicationId)) {
            throw new Error("Telemetry sample sensor is outside the active grant epoch");
          }
          if (selectedMetrics.size > 0 && !selectedMetrics.has(sample.metricId)) {
            throw new Error("Telemetry sample metric is outside the active grant epoch");
          }
          if (policy.historyFrom && sample.timestamp < policy.historyFrom) {
            throw new Error("Telemetry sample precedes the active grant history boundary");
          }
        }
      }
      const existing = state.db.prepare(`SELECT revision FROM stugby_remote_resources
        WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?
          AND grant_id=? AND grant_epoch=?`)
        .get(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId,
          event.grantId, event.grantEpoch) as { revision: number } | undefined;
      if (existing && existing.revision >= event.revision) return { applied: false };
      if (event.operation === "tombstone") {
        state.db.prepare(`DELETE FROM stugby_remote_resources WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?`)
          .run(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId);
        if (event.schema === "home.telemetry.v1") {
          state.db.prepare(`DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND authority_node_id=? AND grant_id=?`)
            .run(event.stugubyId, event.authorityNodeId, event.grantId);
          state.db.prepare(`DELETE FROM stugby_remote_telemetry_staging
            WHERE stugby_id=? AND authority_node_id=? AND grant_id=?`)
            .run(event.stugubyId, event.authorityNodeId, event.grantId);
          state.db.prepare(`DELETE FROM stugby_remote_telemetry_epochs
            WHERE stugby_id=? AND authority_node_id=? AND grant_id=?`)
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
      state.db.prepare(`INSERT INTO stugby_remote_resources
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
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      state.db.prepare("DELETE FROM stugby_request_replays WHERE expires_at<=?").run(now);
      const result = state.db.prepare("INSERT OR IGNORE INTO stugby_request_replays(node_id,request_id,expires_at) VALUES (?,?,?)")
        .run(nodeId, requestId, expiresAt);
      return Number(result.changes) === 1;
    },
  acknowledgeEventCursor(this: StugubyStoreInternals, stugubyId: string, nodeId: string, cursor: number): string[] {
      const state = this[stugubyStoreState];
      if (cursor <= 0) return [];
      const rows = state.db.prepare(`SELECT event_json FROM stugby_event_log
        WHERE stugby_id=? AND target_node_id=? AND cursor<=?`).all(stugubyId, nodeId, cursor) as unknown as Array<{ event_json: string }>;
      const blobEvents = rows.map((row) => JSON.parse(row.event_json) as StugubySignedEvent)
        .filter((event) => eventBlobDigests(event).length > 0 && event.grantId && event.grantEpoch !== null);
      const released = new Set<string>();
      state.db.exec("BEGIN IMMEDIATE");
      try {
        state.db.prepare("DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND cursor<=?")
          .run(stugubyId, nodeId, cursor);
        for (const event of blobEvents) {
          for (const digest of eventBlobDigests(event)) {
            state.db.prepare(`DELETE FROM stugby_blob_access
              WHERE stugby_id=? AND digest=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
              .run(stugubyId, digest, nodeId, event.grantId, event.grantEpoch);
            released.add(digest);
          }
        }
        state.db.exec("COMMIT");
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
      for (const event of blobEvents) this.releaseRelayReferencesWithoutAccess(stugubyId, event.grantId!, event.grantEpoch!);
      return [...released].filter((digest) => !this.hasBlobReferences(digest));
    },
});
