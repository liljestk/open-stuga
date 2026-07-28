import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  AreaEquipment,
  Floor,
  House,
  MaintenanceTask,
  MeasurementSample,
  Property,
  PropertyArea,
  PropertyAreaKind,
  PropertyNote,
  Sensor,
  StugubyHouseLink,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import {
  STUGBY_MAX_BATCH_EVENTS,
  STUGBY_MAX_BLOB_BYTES,
  STUGBY_MAX_CLOCK_SKEW_SECONDS,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  canonicalJson,
  eventSigningValue,
  isStugubyDataset,
  isStugubyRole,
  requestSigningValue,
  validateDatasetPayload,
  validateHomeCommand,
  validateHomeCommandResult,
  validatePropertyCommand,
  validatePropertyCommandResult,
  validateShareGrant,
  validateSharedProperty,
  validateSignedEvent,
  type JsonObject,
  type JsonValue,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyDeletionReceipt,
  type StugubyBlobMediaType,
  type StugubyBlobReference,
  type StugubyEventBatch,
  type StugubyEventPage,
  type StugubyGrantAudience,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyHomeCommandSnapshot,
  type StugubyHomeDirectoryPayload,
  type StugubyHomeFloorPlanPayload,
  type StugubyHomeLocationPayload,
  type StugubyHomeNotesPayload,
  type StugubyHomeObservationsPayload,
  type StugubyHomeRecoveryKind,
  type StugubyHomeRecoveryPayload,
  type StugubyHomeStructurePayload,
  type StugubyInvitation,
  type StugubyJoinRequest,
  type StugubyJoinResponse,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRole,
  type StugubySensorCatalogPayload,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
  type StugubyWireEvent,
} from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import type { TelemetryBus } from "../../../events.js";
import type { StugubyNodeKeys } from "../../identity.js";
import { publicKeyFingerprint } from "../../identity.js";
import { durableAtomicWriteFileSync } from "../../durable-write.js";
import {
  StugubyStore,
  type StugubyAuthorityTransfer,
  type StugubyHomeProjection,
  type StugubyLocalInvitation,
  type StugubyLocalMember,
  type StugubyOutboxItem,
  type StugubyPropertyAdoption,
} from "../../store.js";
import { StugubyError, enabledDataset, grantExpired, parseIso, sha256 } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  publishFullRecoveryTelemetry(this: StugubyServiceInternals,
      grant: StugubyShareGrant,
      house: House,
      dataset: StugubyDatasetGrant,
    ): number {
      const policy = dataset.telemetry;
      if (!policy?.historyFrom) throw new StugubyError(400, "RECOVERY_HISTORY_REQUIRED", "Full recovery requires a telemetry history start");
      const from = parseIso(policy.historyFrom, "Telemetry history start");
      if (!this.localTelemetryHistoryComplete()) {
        throw new StugubyError(
          409,
          "ARCHIVED_TELEMETRY_EXPORT_UNAVAILABLE",
          "Full recovery cannot be assembled completely from the bounded SQLite cache; an archive-aware federation export is required",
        );
      }
      const to = new Date().toISOString();
      const sensors = this.database.listSensors(house.id);
      const publications = new Map(sensors.map((sensor) => [
        sensor.id,
        this.store.publicationId(grant.stugubyId, "sensor", sensor.id),
      ]));
      const revision = this.store.homeRevision(grant.stugubyId, this.identity.nodeId, grant.publicationId);
      const statement = sensors.length > 0
        ? this.database.db.prepare(`SELECT sensor_id,metric,timestamp,value,quality
            FROM measurement_samples WHERE timestamp>=? AND timestamp<=?
              AND sensor_id IN (${sensors.map(() => "?").join(",")})
            ORDER BY timestamp,sensor_id,metric,id`)
        : null;
      const rows = statement
        ? statement.iterate(from, to, ...sensors.map((sensor) => sensor.id)) as NodeJS.Iterator<{
          sensor_id: string;
          metric: string;
          timestamp: string;
          value: number;
          quality: "good" | "estimated" | "stale";
        }>
        : [][Symbol.iterator]();
      let samples: StugubyTelemetryPayload["samples"] = [];
      let count = 0;
      let chunkIndex = 0;
      const flush = (): void => {
        if (samples.length === 0) return;
        const chunkId = sha256(`${grant.id}\n${grant.epoch}\nfull-recovery\n${chunkIndex}`);
        this.publishDataset(grant, "home.telemetry.v1", {
          publicationId: grant.publicationId,
          chunkId,
          from: samples[0]!.timestamp,
          to: samples.at(-1)!.timestamp,
          complete: false,
          samples,
        } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:recovery:${chunkIndex}`, revision);
        chunkIndex += 1;
        samples = [];
      };
      for (const row of rows) {
        samples.push({
          sensorPublicationId: publications.get(row.sensor_id)!,
          metricId: row.metric,
          timestamp: row.timestamp,
          value: row.value,
          quality: row.quality,
        });
        count += 1;
        if (samples.length >= 2_000) flush();
      }
      flush();
      const completionId = sha256(`${grant.id}\n${grant.epoch}\nfull-recovery\ncomplete`);
      this.publishDataset(grant, "home.telemetry.v1", {
        publicationId: grant.publicationId,
        chunkId: completionId,
        from,
        to,
        complete: true,
        samples: [],
      } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:recovery:complete`, revision);
      return count;
    },
  publishRecoveryArchive(this: StugubyServiceInternals,
      grant: StugubyShareGrant,
      house: House,
      telemetrySamples: number,
      generation: number,
    ): void {
      if (grant.housePolicy.recoveryMode !== "full") {
        throw new StugubyError(400, "RECOVERY_SUCCESSOR_REQUIRED", "Recovery archives require one designated full-recovery successor");
      }
      const sensorPublication = (sensorId: string) => this.store.publicationId(grant.stugubyId, "sensor", sensorId);
      const floorPublication = (floorId: string) => this.store.publicationId(grant.stugubyId, "floor", floorId);
      const elementPublication = (elementId: string) => this.store.publicationId(grant.stugubyId, "plan-element", elementId);
      const ruleKey = (ruleId: string) => sha256(`stuguby-rule\n${grant.stugubyId}\n${ruleId}`);
      const metricIds = new Set((this.database.db.prepare(`SELECT DISTINCT sample.metric
        FROM measurement_samples sample JOIN sensors sensor ON sensor.id=sample.sensor_id
        WHERE sensor.house_id=?`).all(house.id) as Array<{ metric: string }>).map((row) => row.metric));
      const definitions = this.database.listMeasurementDefinitions()
        .filter((definition) => metricIds.has(definition.id))
        .map((definition) => ({
          id: definition.id,
          labels: definition.labels,
          unit: definition.unit,
          ...(definition.dimension ? { dimension: definition.dimension } : {}),
          ...(definition.allowedUnits ? { allowedUnits: definition.allowedUnits } : {}),
          ...(definition.kind ? { kind: definition.kind } : {}),
          ...(definition.defaultAggregation ? { defaultAggregation: definition.defaultAggregation } : {}),
          precision: definition.precision,
          validMin: definition.validMin,
          validMax: definition.validMax,
          displayMin: definition.displayMin,
          displayMax: definition.displayMax,
          interpolationDelta: definition.interpolationDelta,
          colorScale: definition.colorScale,
          enabled: definition.enabled,
          spatialInterpolation: definition.spatialInterpolation,
          forecastSupported: definition.forecastSupported,
        }));
      const rules = (this.database.db.prepare(`SELECT * FROM alert_rules WHERE sensor_id IN (
        SELECT id FROM sensors WHERE house_id=?) ORDER BY id`).all(house.id) as Array<{
          id: string; name: string; sensor_id: string; metric: string; operator: string; threshold: number;
          duration_seconds: number; severity: string; enabled: number; retired_at: string | null;
        }>).map((rule) => ({
          ruleKey: ruleKey(rule.id),
          name: rule.name,
          sensorPublicationId: sensorPublication(rule.sensor_id),
          metric: rule.metric,
          operator: rule.operator,
          threshold: rule.threshold,
          durationSeconds: rule.duration_seconds,
          severity: rule.severity,
          enabled: Boolean(rule.enabled),
          retiredAt: rule.retired_at,
        }));
      const alertEvents = (this.database.db.prepare(`SELECT event.* FROM alert_events event
        JOIN sensors sensor ON sensor.id=event.sensor_id WHERE sensor.house_id=? ORDER BY event.started_at,event.id`)
        .all(house.id) as Array<{
          id: string; rule_id: string; sensor_id: string; metric: string; value: number; threshold: number;
          severity: string; started_at: string; acknowledged_at: string | null; resolved_at: string | null;
        }>).map((event) => ({
          eventKey: sha256(`stuguby-alert\n${grant.stugubyId}\n${event.id}`),
          ruleKey: ruleKey(event.rule_id),
          sensorPublicationId: sensorPublication(event.sensor_id),
          metric: event.metric,
          value: event.value,
          threshold: event.threshold,
          severity: event.severity,
          startedAt: event.started_at,
          acknowledgedAt: event.acknowledged_at,
          resolvedAt: event.resolved_at,
        }));
      const staticParameters = this.database.listParameters(house.id).map((parameter) => {
        const scopePublicationId = parameter.scopeType === "house"
          ? grant.publicationId
          : parameter.scopeType === "floor"
            ? floorPublication(parameter.scopeId)
            : parameter.scopeType === "room"
              ? this.store.publicationId(grant.stugubyId, "room", parameter.scopeId)
              : sensorPublication(parameter.scopeId);
        return {
          parameterKey: sha256(`stuguby-parameter\n${grant.stugubyId}\n${parameter.id}`),
          scopeType: parameter.scopeType,
          scopePublicationId,
          key: parameter.key,
          value: parameter.value,
          unit: parameter.unit,
          label: parameter.label,
        };
      });
      const openingStates = (this.database.db.prepare(`SELECT id,floor_id,element_id,state,open_fraction,observed_at,valid_until
        FROM opening_state_observations WHERE house_id=? ORDER BY observed_at,id`).all(house.id) as Array<{
          id: string; floor_id: string; element_id: string; state: string; open_fraction: number | null;
          observed_at: string; valid_until: string | null;
        }>).map((item) => ({
          openingKey: sha256(`stuguby-opening\n${grant.stugubyId}\n${item.id}`),
          floorPublicationId: floorPublication(item.floor_id),
          planElementPublicationId: elementPublication(item.element_id),
          state: item.state,
          openFraction: item.open_fraction,
          observedAt: item.observed_at,
          validUntil: item.valid_until,
        }));
      const weather = (this.database.db.prepare(`SELECT location_key,timestamp,temperature_c,source,fetched_at,
        station_id,station_name,conditions_json FROM outdoor_temperature_samples WHERE house_id=?
        ORDER BY timestamp,rowid`).all(house.id) as Array<{
          location_key: string; timestamp: string; temperature_c: number; source: string; fetched_at: string;
          station_id: string | null; station_name: string | null; conditions_json: string | null;
        }>).map((item) => ({
          weatherKey: sha256(`stuguby-weather\n${grant.stugubyId}\n${item.location_key}\n${item.timestamp}\n${item.source}`),
          locationKey: item.location_key,
          timestamp: item.timestamp,
          temperatureC: item.temperature_c,
          source: item.source,
          fetchedAt: item.fetched_at,
          stationId: item.station_id,
          stationName: item.station_name,
          conditions: item.conditions_json ? JSON.parse(item.conditions_json) as JsonValue : null,
        }));
      const electricity = (this.database.db.prepare(`SELECT start_at,end_at,raw_price_cents_per_kwh,
        margin_cents_per_kwh,fetched_at FROM electricity_price_points WHERE property_id=? ORDER BY start_at`)
        .all(house.propertyId) as Array<{
          start_at: string; end_at: string; raw_price_cents_per_kwh: number; margin_cents_per_kwh: number; fetched_at: string;
        }>).map((item) => ({
          priceKey: sha256(`stuguby-price\n${grant.stugubyId}\n${item.start_at}`),
          startAt: item.start_at,
          endAt: item.end_at,
          rawPriceCentsPerKwh: item.raw_price_cents_per_kwh,
          marginCentsPerKwh: item.margin_cents_per_kwh,
          fetchedAt: item.fetched_at,
        }));
      const assets = this.database.listAssets(house.id).map((metadata) => {
        const asset = this.database.getAsset(metadata.id);
        if (!asset) throw new StugubyError(409, "RECOVERY_ASSET_MISSING", `Home asset ${metadata.name} could not be read`);
        const blob = this.storeBlob(asset.data, asset.mimeType);
        this.store.registerBlobReference(grant.stugubyId, blob.digest, grant.id, grant.epoch, "local");
        return {
          assetKey: sha256(`stuguby-asset\n${grant.stugubyId}\n${asset.id}`),
          name: asset.name,
          mimeType: blob.mediaType,
          kind: asset.kind,
          digest: blob.digest,
          byteLength: blob.byteLength,
          createdAt: asset.createdAt,
        };
      });
      const archives: Array<[StugubyHomeRecoveryKind, JsonObject[]]> = [
        ["measurement-definitions", definitions as unknown as JsonObject[]],
        ["alert-rules", rules as unknown as JsonObject[]],
        ["alert-events", alertEvents as unknown as JsonObject[]],
        ["static-parameters", staticParameters as unknown as JsonObject[]],
        ["opening-states", openingStates as unknown as JsonObject[]],
        ["weather-history", weather as unknown as JsonObject[]],
        ["electricity-history", electricity as unknown as JsonObject[]],
        ["assets", assets as unknown as JsonObject[]],
        ["manifest", [{ telemetrySamples, generatedAt: new Date().toISOString() }]],
      ];
      for (const [kind, records] of archives) this.publishRecoveryChunks(grant, kind, records, generation);
    },
  publishRecoveryChunks(this: StugubyServiceInternals,
      grant: StugubyShareGrant,
      kind: StugubyHomeRecoveryKind,
      records: JsonObject[],
      generation: number,
    ): void {
      const chunks: JsonObject[][] = [];
      let current: JsonObject[] = [];
      let bytes = 0;
      for (const record of records) {
        const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
        if (current.length > 0 && (current.length >= 1_000 || bytes + recordBytes > 450_000)) {
          chunks.push(current);
          current = [];
          bytes = 0;
        }
        current.push(record);
        bytes += recordBytes;
      }
      if (current.length > 0 || chunks.length === 0) chunks.push(current);
      chunks.forEach((chunk, index) => {
        const chunkId = sha256(`${grant.id}\n${grant.epoch}\n${generation}\n${kind}\n${index}\n${canonicalJson(chunk)}`);
        const payload: StugubyHomeRecoveryPayload = {
          publicationId: grant.publicationId,
          chunkId,
          generation,
          kind,
          complete: index === chunks.length - 1,
          records: chunk,
        };
        this.publishDataset(
          grant,
          "home.recovery.v1",
          payload,
          `${grant.publicationId}:recovery:${kind}:${index}`,
          generation,
        );
      });
    },
  selectedSensors(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House, publications: string[]): Sensor[] {
      const sensors = this.database.listSensors(house.id);
      if (!publications.length) return sensors;
      const selected = new Set(publications);
      return sensors.filter((sensor) => selected.has(this.store.publicationId(grant.stugubyId, "sensor", sensor.id)));
    },
  publishLiveTelemetry(this: StugubyServiceInternals, sample: MeasurementSample): void {
      const sensor = this.database.db.prepare("SELECT house_id FROM sensors WHERE id=?")
        .get(sample.sensorId) as { house_id: string } | undefined;
      if (!sensor) return;
      for (const stuguby of this.store.listStugubys()) {
        if (stuguby.localMemberState !== "active" || stuguby.localRole === "viewer") continue;
        for (const grant of this.store.listGrants(stuguby.id, this.identity.nodeId)) {
          if (grant.revokedAt || grantExpired(grant) || grant.localHouseId !== sensor.house_id) continue;
          const dataset = enabledDataset(grant, "home.telemetry.v1");
          const policy = dataset?.telemetry;
          if (!dataset || !policy?.live) continue;
          const sensorPublicationId = this.store.publicationId(grant.stugubyId, "sensor", sample.sensorId);
          if (policy.sensorPublicationIds.length && !policy.sensorPublicationIds.includes(sensorPublicationId)) continue;
          if (policy.metricIds.length && !policy.metricIds.includes(sample.metric)) continue;
          const utcHour = new Date(Date.parse(sample.timestamp)).toISOString().slice(0, 13);
          this.atomicPublication(() => {
            if (!this.store.reserveLiveTelemetrySample(grant.stugubyId, grant.id, utcHour, policy.maxSamplesPerHour)) return;
            const chunkId = randomUUID();
            const payload: StugubyTelemetryPayload = {
              publicationId: grant.publicationId,
              chunkId,
              from: sample.timestamp,
              to: sample.timestamp,
              complete: true,
              samples: [{ sensorPublicationId, metricId: sample.metric, timestamp: sample.timestamp, value: sample.value, quality: sample.quality }],
            };
            this.publishDataset(grant, "home.telemetry.v1", payload, `${grant.publicationId}:telemetry:${chunkId}`, 1);
          });
        }
      }
    },
  publishDataset(this: StugubyServiceInternals, grant: StugubyShareGrant, dataset: StugubyDataset, payload: JsonValue, resourceId: string, revision: number): void {
      validateDatasetPayload(dataset, payload);
      const event = this.createEvent({
        stugubyId: grant.stugubyId,
        eventKind: "dataset.published",
        streamId: `dataset:${grant.id}:${dataset}`,
        schema: dataset,
        resourceId,
        operation: "upsert",
        revision: Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, revision)),
        grantId: grant.id,
        grantEpoch: grant.epoch,
        payload,
      });
      this.distribute(event, grant);
    },
  createEvent(this: StugubyServiceInternals, input: Omit<StugubyWireEvent, "protocolVersion" | "eventId" | "authorityNodeId" | "sequence" | "occurredAt" | "payloadHash">): StugubySignedEvent {
      const payload = input.operation === "tombstone" ? null : input.payload;
      const wire: StugubyWireEvent = {
        protocolVersion: STUGBY_PROTOCOL_VERSION,
        stugubyId: input.stugubyId,
        eventId: randomUUID(),
        eventKind: input.eventKind,
        authorityNodeId: this.identity.nodeId,
        streamId: input.streamId,
        sequence: this.store.nextSequence(input.stugubyId, input.streamId),
        schema: input.schema,
        resourceId: input.resourceId,
        operation: input.operation,
        revision: input.revision,
        grantId: input.grantId,
        grantEpoch: input.grantEpoch,
        occurredAt: new Date().toISOString(),
        payload,
        payloadHash: sha256(canonicalJson(payload)),
      };
      return { ...wire, keyFingerprint: this.identity.keyFingerprint, signature: this.keys.sign(eventSigningValue(wire)) };
    },
});
