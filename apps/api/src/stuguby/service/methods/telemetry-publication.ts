import type { House, MeasurementSample, Sensor } from "@climate-twin/contracts";
import { type JsonValue, type StugubyDatasetGrant, type StugubyShareGrant, type StugubyTelemetryPayload, canonicalJson, type JsonObject, type StugubyHomeRecoveryKind, type StugubyHomeRecoveryPayload } from "@climate-twin/stuguby-protocol";
import { StugubyError } from "../support/service-types.js";
import { parseIso, sha256, enabledDataset, grantExpired } from "../support/federation-validation.js";
import { registerStugubyServiceMethods, type StugubyServiceInternals } from "../core.js";
import { randomUUID } from "node:crypto";

function* mapRecoveryRows<Row>(rows: Iterable<Row>, mapper: (row: Row) => unknown): IterableIterator<JsonObject> {
  for (const row of rows) yield mapper(row) as JsonObject;
}

declare module "../core.js" {
  interface StugubyServiceInternals {
    publishHistoricalTelemetry(grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): void;
    publishFullRecoveryTelemetry(
        grant: StugubyShareGrant,
        house: House,
        dataset: StugubyDatasetGrant,
      ): number;
    publishRecoveryArchive(
        grant: StugubyShareGrant,
        house: House,
        telemetrySamples: number,
        generation: number,
      ): void;
    publishRecoveryChunks(
        grant: StugubyShareGrant,
        kind: StugubyHomeRecoveryKind,
        records: Iterable<JsonObject>,
        generation: number,
      ): void;
    selectedSensors(grant: StugubyShareGrant, house: House, publications: string[]): Sensor[];
    publishLiveTelemetry(sample: MeasurementSample): void;
  }
}

registerStugubyServiceMethods({
  publishHistoricalTelemetry(this: StugubyServiceInternals, grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): void {
      const policy = dataset.telemetry;
      if (!policy) return;
      if (!policy.historyFrom) {
        const boundary = new Date().toISOString();
        const completionId = sha256(`${grant.id}\n${grant.epoch}\nhistory-complete\nlive-only`);
        this.publishDataset(grant, "home.telemetry.v1", {
          publicationId: grant.publicationId,
          chunkId: completionId,
          from: boundary,
          to: boundary,
          complete: true,
          samples: [],
        } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:${completionId}`, 1);
        return;
      }
      const from = parseIso(policy.historyFrom, "Telemetry history start");
      const now = Date.now();
      // When live publication is enabled, the current UTC hour belongs solely
      // to the durable live bucket. This prevents the initial history snapshot
      // and live stream from each consuming a full allowance for that hour.
      const to = new Date(policy.live ? Math.floor(now / 3_600_000) * 3_600_000 - 1 : now).toISOString();
      const hasHistoricalRange = Date.parse(from) <= Date.parse(to);
      if (hasHistoricalRange && !this.localTelemetryHistoryComplete(from)) {
        throw new StugubyError(
          409,
          "ARCHIVED_TELEMETRY_EXPORT_UNAVAILABLE",
          "Stuguby cannot synchronously page a complete history snapshot from the bounded SQLite cache; archive-backed federation export is unavailable",
        );
      }
      const sensors = this.selectedSensors(grant, house, policy.sensorPublicationIds);
      const sensorIds = sensors.map((sensor) => sensor.id);
      const sensorPlaceholders = sensorIds.map(() => "?").join(",");
      const metricPlaceholders = policy.metricIds.map(() => "?").join(",");
      const metricClause = metricPlaceholders ? `AND metric IN (${metricPlaceholders})` : "";
      const publications = new Map(sensors.map((sensor) => [
        sensor.id,
        this.store.publicationId(grant.stugubyId, "sensor", sensor.id),
      ]));
      const chunkSize = 2_000;
      if (hasHistoricalRange && sensorIds.length > 0) {
        const listHours = this.database.db.prepare(`SELECT
            strftime('%Y-%m-%dT%H:00:00.000Z', timestamp) AS hour_start
          FROM measurement_samples
          WHERE timestamp>=? AND timestamp<=? AND sensor_id IN (${sensorPlaceholders}) ${metricClause}
            AND strftime('%Y-%m-%dT%H', timestamp) IS NOT NULL
          GROUP BY hour_start ORDER BY hour_start LIMIT ?`);
        const selectHour = this.database.db.prepare(`WITH candidates AS (
            SELECT id,sensor_id,metric,timestamp,value,quality
            FROM measurement_samples
            WHERE timestamp>=? AND timestamp<=? AND sensor_id IN (${sensorPlaceholders}) ${metricClause}
          ), bucketed AS (
            SELECT *,ntile(?) OVER (
              ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id
            ) AS sample_bucket
            FROM candidates
          ), sampled AS (
            SELECT *,row_number() OVER (
              PARTITION BY sample_bucket ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id
            ) AS selected_rank
            FROM bucketed
          )
          SELECT sensor_id,metric,timestamp,value,quality
          FROM sampled WHERE selected_rank=1
          ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id`);
        let hourCursor = from;
        while (Date.parse(hourCursor) <= Date.parse(to)) {
          const hours = listHours.all(
            hourCursor,
            to,
            ...sensorIds,
            ...policy.metricIds,
            500,
          ) as Array<{ hour_start: string }>;
          if (hours.length === 0) break;
          for (const { hour_start: hourStart } of hours) {
            const hourEnd = new Date(Date.parse(hourStart) + 3_600_000 - 1).toISOString();
            const rows = selectHour.all(
              hourStart < from ? from : hourStart,
              hourEnd > to ? to : hourEnd,
              ...sensorIds,
              ...policy.metricIds,
              policy.maxSamplesPerHour,
            ) as Array<{
              sensor_id: string;
              metric: string;
              timestamp: string;
              value: number;
              quality: "good" | "estimated" | "stale";
            }>;
            const hourlySamples: StugubyTelemetryPayload["samples"] = rows.map((sample) => ({
              sensorPublicationId: publications.get(sample.sensor_id)!,
              metricId: sample.metric,
              timestamp: sample.timestamp,
              value: sample.value,
              quality: sample.quality,
            }));
            for (let offset = 0; offset < hourlySamples.length; offset += chunkSize) {
              const selected = hourlySamples.slice(offset, offset + chunkSize);
              const chunkIndex = Math.floor(offset / chunkSize);
              const chunkId = sha256(`${grant.id}\n${grant.epoch}\n${hourStart}\n${chunkIndex}`);
              this.publishDataset(grant, "home.telemetry.v1", {
                publicationId: grant.publicationId,
                chunkId,
                from: selected[0]!.timestamp,
                to: selected.at(-1)!.timestamp,
                complete: false,
                samples: selected,
              } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:${chunkId}`, 1);
            }
          }
          hourCursor = new Date(Date.parse(hours.at(-1)!.hour_start) + 3_600_000).toISOString();
        }
      }
      const completionTo = hasHistoricalRange ? to : from;
      const completionId = sha256(`${grant.id}\n${grant.epoch}\nhistory-complete\n${from}\n${completionTo}`);
      this.publishDataset(grant, "home.telemetry.v1", {
        publicationId: grant.publicationId,
        chunkId: completionId,
        from,
        to: completionTo,
        complete: true,
        samples: [],
      } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:${completionId}`, 1);
    },
  publishFullRecoveryTelemetry(this: StugubyServiceInternals,
      grant: StugubyShareGrant,
      house: House,
      dataset: StugubyDatasetGrant,
    ): number {
      const policy = dataset.telemetry;
      if (!policy?.historyFrom) throw new StugubyError(400, "RECOVERY_HISTORY_REQUIRED", "Full recovery requires a telemetry history start");
      const from = parseIso(policy.historyFrom, "Telemetry history start");
      if (!this.localTelemetryHistoryComplete(from)) {
        throw new StugubyError(
          409,
          "ARCHIVED_TELEMETRY_EXPORT_UNAVAILABLE",
          "Full recovery cannot be synchronously paged from the bounded SQLite cache; archive-backed federation export is unavailable",
        );
      }
      const now = new Date().toISOString();
      const to = Date.parse(from) <= Date.parse(now) ? now : from;
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
      const alertEvents = mapRecoveryRows(this.database.db.prepare(`SELECT event.* FROM alert_events event
        JOIN sensors sensor ON sensor.id=event.sensor_id WHERE sensor.house_id=? ORDER BY event.started_at,event.id`)
        .iterate(house.id) as NodeJS.Iterator<{
          id: string; rule_id: string; sensor_id: string; metric: string; value: number; threshold: number;
          severity: string; started_at: string; acknowledged_at: string | null; resolved_at: string | null;
        }>, (event) => ({
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
      const openingStates = mapRecoveryRows(this.database.db.prepare(`SELECT id,floor_id,element_id,state,open_fraction,observed_at,valid_until
        FROM opening_state_observations WHERE house_id=? ORDER BY observed_at,id`).iterate(house.id) as NodeJS.Iterator<{
          id: string; floor_id: string; element_id: string; state: string; open_fraction: number | null;
          observed_at: string; valid_until: string | null;
        }>, (item) => ({
          openingKey: sha256(`stuguby-opening\n${grant.stugubyId}\n${item.id}`),
          floorPublicationId: floorPublication(item.floor_id),
          planElementPublicationId: elementPublication(item.element_id),
          state: item.state,
          openFraction: item.open_fraction,
          observedAt: item.observed_at,
          validUntil: item.valid_until,
        }));
      const weather = mapRecoveryRows(this.database.db.prepare(`SELECT location_key,timestamp,temperature_c,source,fetched_at,
        station_id,station_name,conditions_json FROM outdoor_temperature_samples WHERE house_id=?
        ORDER BY timestamp,rowid`).iterate(house.id) as NodeJS.Iterator<{
          location_key: string; timestamp: string; temperature_c: number; source: string; fetched_at: string;
          station_id: string | null; station_name: string | null; conditions_json: string | null;
        }>, (item) => ({
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
      const electricity = mapRecoveryRows(this.database.db.prepare(`SELECT start_at,end_at,raw_price_cents_per_kwh,
        margin_cents_per_kwh,fetched_at FROM electricity_price_points WHERE property_id=? ORDER BY start_at`)
        .iterate(house.propertyId) as NodeJS.Iterator<{
          start_at: string; end_at: string; raw_price_cents_per_kwh: number; margin_cents_per_kwh: number; fetched_at: string;
        }>, (item) => ({
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
      const archives: Array<[StugubyHomeRecoveryKind, Iterable<JsonObject>]> = [
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
      records: Iterable<JsonObject>,
      generation: number,
    ): void {
      let pending: JsonObject[] | null = null;
      let current: JsonObject[] = [];
      let bytes = 0;
      let chunkIndex = 0;
      const publish = (chunk: JsonObject[], complete: boolean): void => {
        const chunkId = sha256(`${grant.id}\n${grant.epoch}\n${generation}\n${kind}\n${chunkIndex}\n${canonicalJson(chunk)}`);
        const payload: StugubyHomeRecoveryPayload = {
          publicationId: grant.publicationId,
          chunkId,
          generation,
          kind,
          complete,
          records: chunk,
        };
        this.publishDataset(
          grant,
          "home.recovery.v1",
          payload,
          `${grant.publicationId}:recovery:${kind}:${chunkIndex}`,
          generation,
        );
        chunkIndex += 1;
      };
      for (const record of records) {
        const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
        if (current.length > 0 && (current.length >= 1_000 || bytes + recordBytes > 450_000)) {
          if (pending) publish(pending, false);
          pending = current;
          current = [];
          bytes = 0;
        }
        current.push(record);
        bytes += recordBytes;
      }
      if (current.length > 0) {
        if (pending) publish(pending, false);
        pending = current;
      }
      publish(pending ?? [], true);
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
          if (policy.historyFrom && sample.timestamp < policy.historyFrom) continue;
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
});
