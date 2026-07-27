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
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
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
import { StugubyError } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  detachProperty(this: StugubyServiceInternals, stugubyId: string): StugubyPropertyAdoption {
      const adoption = this.store.getPropertyAdoption(stugubyId);
      if (!adoption || adoption.state !== "adopted") {
        throw new StugubyError(409, "PROPERTY_NOT_ADOPTED", "An adopted Stuguby Property was not found");
      }
      const property = this.database.getProperty(adoption.localPropertyId);
      const propertyLink = property?.stuguby;
      if (!property || !propertyLink) throw new StugubyError(409, "PROPERTY_PROJECTION_MISSING", "The adopted Property projection is missing");
      const detached = this.atomicPublication(() => {
        const now = new Date().toISOString();
        const cancelledPropertyCommands = this.store.cancelPendingPropertyCommands(stugubyId, now);
        const cancelledHomeCommands = this.store.cancelPendingHomeCommands(stugubyId, now);
        const adoptedLocalHouseIds = new Set(this.database.listHouses(property.id)
          .filter((house) => house.stuguby?.stugubyId === stugubyId && house.stuguby.ownership === "local")
          .map((house) => house.id));
        const localGrants = this.store.listGrants(stugubyId, this.identity.nodeId)
          .filter((grant) => !grant.revokedAt && typeof grant.localHouseId === "string"
            && adoptedLocalHouseIds.has(grant.localHouseId));
        for (const grant of localGrants) {
          this.store.discardOutboxGrantEpoch(stugubyId, grant.id, grant.epoch);
          const revoked = this.store.revokeGrant(grant.id);
          this.publishGrant({ ...revoked, audience: grant.audience }, "grant.revoked");
          this.store.retireLocalBlobReferences(stugubyId, grant.id, grant.epoch);
          this.store.audit(stugubyId, "grant.revoked", this.identity.nodeId, grant.id, {
            epoch: revoked.epoch,
            reason: "property-disconnected",
          }, now);
        }
        this.database.setPropertyStugubyLink(property.id, {
          ...propertyLink,
          editPolicy: "collaborative",
          syncState: "detached",
          pendingChangeCount: 0,
          detachedAt: now,
        });
        for (const house of this.database.listHouses(property.id)) {
          if (!house.stuguby || house.stuguby.stugubyId !== stugubyId) continue;
          if (house.stuguby.ownership === "local") {
            this.database.setHouseStugubyLink(house.id, null);
            continue;
          }
          const isReadySuccessor = house.stuguby.recoveryState === "ready"
            && house.stuguby.designatedSuccessorNodeId === this.identity.nodeId;
          if (isReadySuccessor) {
            this.promoteFullRecovery(stugubyId, house);
            this.database.setHouseStugubyLink(house.id, {
              ...house.stuguby,
              authorityNodeId: this.identity.nodeId,
              ownership: "local",
              editPolicy: "editable",
              syncState: "detached",
              authorityEpoch: house.stuguby.authorityEpoch + 1,
              pendingChangeCount: 0,
              conflictCount: 0,
              detachedAt: now,
            });
          } else {
            this.database.deleteHouse(house.id);
          }
        }
        const detached = this.store.detachProperty(stugubyId, now);
        this.store.audit(stugubyId, "property.detached", this.identity.nodeId, property.id, {
          cancelledPropertyCommands,
          cancelledHomeCommands,
          revokedLocalGrants: localGrants.length,
        }, now);
        return detached;
      });
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
      return detached;
    },
  promoteFullRecovery(this: StugubyServiceInternals, stugubyId: string, house: House): void {
      const link = house.stuguby;
      if (!link) throw new StugubyError(409, "RECOVERY_LINK_MISSING", "The Home recovery link is missing");
      const payloads = this.store.listRemoteResources(stugubyId)
        .filter((resource) => resource.authorityNodeId === link.authorityNodeId
          && resource.publicationId === link.publicationId
          && resource.schema === "home.recovery.v1")
        .map((resource) => resource.payload as unknown as StugubyHomeRecoveryPayload);
      const generation = Math.max(0, ...payloads.map((payload) => payload.generation));
      const current = payloads.filter((payload) => payload.generation === generation);
      const records = (kind: StugubyHomeRecoveryKind): JsonObject[] => current
        .filter((payload) => payload.kind === kind)
        .flatMap((payload) => payload.records);
      const projectionMap = (type: "floor" | "room" | "plan-element" | "sensor") => new Map(
        this.store.listProjectionIds(stugubyId, link.authorityNodeId, type)
          .map((projection) => [projection.remoteId, projection.localId]),
      );
      const floorIds = projectionMap("floor");
      const roomIds = projectionMap("room");
      const elementIds = projectionMap("plan-element");
      const sensorIds = projectionMap("sensor");

      this.database.transaction(() => {
        for (const definition of records("measurement-definitions")) {
          const id = String(definition.id);
          if (this.database.getMeasurementDefinition(id)) continue;
          this.database.createMeasurementDefinition({
            id,
            labels: definition.labels as Record<string, string>,
            unit: String(definition.unit),
            ...(typeof definition.dimension === "string" ? { dimension: definition.dimension } : {}),
            ...(Array.isArray(definition.allowedUnits) ? { allowedUnits: definition.allowedUnits as string[] } : {}),
            ...(typeof definition.kind === "string" ? { kind: definition.kind as never } : {}),
            ...(typeof definition.defaultAggregation === "string"
              ? { defaultAggregation: definition.defaultAggregation as never }
              : {}),
            genericHistoryEnabled: true,
            genericStatsEnabled: true,
            precision: Number(definition.precision),
            validMin: definition.validMin === null ? null : Number(definition.validMin),
            validMax: definition.validMax === null ? null : Number(definition.validMax),
            displayMin: definition.displayMin === null ? null : Number(definition.displayMin),
            displayMax: definition.displayMax === null ? null : Number(definition.displayMax),
            interpolationDelta: Number(definition.interpolationDelta),
            colorScale: definition.colorScale as never,
            builtin: false,
            enabled: Boolean(definition.enabled),
            spatialInterpolation: Boolean(definition.spatialInterpolation),
            forecastSupported: Boolean(definition.forecastSupported),
          });
        }

        const restoredRules = new Map<string, string>();
        for (const rule of records("alert-rules")) {
          const sensorId = sensorIds.get(String(rule.sensorPublicationId));
          if (!sensorId || !this.database.getMeasurementDefinition(String(rule.metric))) continue;
          const restored = this.database.saveAlertRule({
            name: String(rule.name),
            sensorId,
            metric: String(rule.metric),
            operator: rule.operator as never,
            threshold: Number(rule.threshold),
            durationSeconds: Number(rule.durationSeconds),
            severity: rule.severity as never,
            enabled: Boolean(rule.enabled),
            webhookEnabled: false,
            telegramEnabled: false,
          });
          restoredRules.set(String(rule.ruleKey), restored.id);
          if (rule.retiredAt) this.database.deleteAlertRule(restored.id);
        }
        const insertAlert = this.database.db.prepare(`INSERT OR IGNORE INTO alert_events
          (id,rule_id,sensor_id,metric,value,threshold,severity,started_at,acknowledged_at,resolved_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        for (const event of records("alert-events")) {
          const ruleId = restoredRules.get(String(event.ruleKey));
          const sensorId = sensorIds.get(String(event.sensorPublicationId));
          if (!ruleId || !sensorId) continue;
          insertAlert.run(
            String(event.eventKey),
            ruleId,
            sensorId,
            String(event.metric),
            Number(event.value),
            Number(event.threshold),
            String(event.severity),
            String(event.startedAt),
            event.acknowledgedAt === null ? null : String(event.acknowledgedAt),
            event.resolvedAt === null ? null : String(event.resolvedAt),
          );
        }

        for (const parameter of records("static-parameters")) {
          const scopeType = String(parameter.scopeType) as "house" | "floor" | "room" | "sensor";
          const remoteScopeId = String(parameter.scopePublicationId);
          const scopeId = scopeType === "house"
            ? house.id
            : scopeType === "floor"
              ? floorIds.get(remoteScopeId)
              : scopeType === "room"
                ? roomIds.get(remoteScopeId)
                : sensorIds.get(remoteScopeId);
          if (!scopeId) continue;
          this.database.saveParameter({
            houseId: house.id,
            scopeType,
            scopeId,
            key: String(parameter.key),
            value: parameter.value as string | number | boolean,
            unit: parameter.unit === null ? null : String(parameter.unit),
            label: String(parameter.label),
          });
        }

        for (const opening of records("opening-states")) {
          const floorId = floorIds.get(String(opening.floorPublicationId));
          const elementId = elementIds.get(String(opening.planElementPublicationId));
          if (!floorId || !elementId) continue;
          this.database.recordOpeningStateObservation(house.id, {
            floorId,
            elementId,
            state: opening.state as never,
            ...(opening.openFraction !== null ? { openFraction: Number(opening.openFraction) } : {}),
            source: "api",
            observedAt: String(opening.observedAt),
            ...(opening.validUntil ? { validUntil: String(opening.validUntil) } : {}),
          });
        }

        this.database.db.prepare("DELETE FROM outdoor_temperature_samples WHERE house_id=?").run(house.id);
        const insertWeather = this.database.db.prepare(`INSERT OR IGNORE INTO outdoor_temperature_samples
          (house_id,location_key,timestamp,temperature_c,source,fetched_at,station_id,station_name,conditions_json)
          VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const weather of records("weather-history")) {
          insertWeather.run(
            house.id,
            String(weather.locationKey),
            String(weather.timestamp),
            Number(weather.temperatureC),
            String(weather.source),
            String(weather.fetchedAt),
            weather.stationId === null ? null : String(weather.stationId),
            weather.stationName === null ? null : String(weather.stationName),
            weather.conditions === null ? null : JSON.stringify(weather.conditions),
          );
        }
        const insertPrice = this.database.db.prepare(`INSERT INTO electricity_price_points
          (property_id,start_at,end_at,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(property_id,start_at) DO UPDATE SET
            end_at=excluded.end_at,raw_price_cents_per_kwh=excluded.raw_price_cents_per_kwh,
            margin_cents_per_kwh=excluded.margin_cents_per_kwh,fetched_at=excluded.fetched_at`);
        for (const price of records("electricity-history")) {
          insertPrice.run(
            house.propertyId,
            String(price.startAt),
            String(price.endAt),
            Number(price.rawPriceCentsPerKwh),
            Number(price.marginCentsPerKwh),
            String(price.fetchedAt),
          );
        }
        this.database.db.prepare("DELETE FROM assets WHERE house_id=?").run(house.id);
        const insertAsset = this.database.db.prepare(`INSERT INTO assets
          (id,house_id,name,mime_type,kind,data,size,created_at) VALUES (?,?,?,?,?,?,?,?)`);
        for (const asset of records("assets")) {
          const digest = String(asset.digest);
          const blob = this.readBlob(digest);
          if (blob.data.byteLength !== Number(asset.byteLength) || blob.mediaType !== String(asset.mimeType)) {
            throw new StugubyError(409, "RECOVERY_ASSET_INCOMPLETE", `Home asset ${String(asset.name)} is incomplete`);
          }
          const localId = this.store.projectionId(
            stugubyId,
            link.authorityNodeId,
            "asset",
            String(asset.assetKey),
          );
          insertAsset.run(
            localId,
            house.id,
            String(asset.name),
            String(asset.mimeType),
            String(asset.kind),
            blob.data,
            blob.data.byteLength,
            String(asset.createdAt),
          );
        }
        this.store.promoteRecoveryTelemetry(stugubyId, link.authorityNodeId, link.publicationId);
      });
      this.store.audit(stugubyId, "home.recovery.promoted", this.identity.nodeId, link.publicationId, {
        generation,
        integrationsTransferred: false,
      });
    },
  assertPropertyWriteAllowed(this: StugubyServiceInternals, propertyId: string): void {
      const property = this.database.getProperty(propertyId);
      // Resource existence and its endpoint-specific error contract belong to
      // the caller. This guard only adds Stuguby authority policy.
      if (!property) return;
      if (!property.stuguby || property.stuguby.syncState === "detached") return;
      const stuguby = this.store.getStuguby(property.stuguby.stugubyId);
      if (!stuguby || stuguby.localMemberState !== "active") {
        throw new StugubyError(403, "MEMBERSHIP_INACTIVE", "An inactive Stuguby member cannot edit shared Property data");
      }
      if (property.stuguby.editPolicy === "read-only" && property.stuguby.authorityNodeId !== this.identity.nodeId) {
        throw new StugubyError(403, "PROPERTY_READ_ONLY", "The Stuguby coordinator has shared this Property as read-only");
      }
    },
  assertHouseWriteAllowed(this: StugubyServiceInternals, houseId: string): void {
      const house = this.database.getHouse(houseId);
      if (!house) return;
      if (!house.stuguby || house.stuguby.syncState === "detached" || house.stuguby.ownership === "local") return;
      if (house.stuguby.editPolicy === "read-only") {
        throw new StugubyError(403, "HOME_READ_ONLY", "This shared Home is read-only. Its owner can explicitly enable editing");
      }
    },
  assertHouseLocalAuthority(this: StugubyServiceInternals, houseId: string): void {
      const house = this.database.getHouse(houseId);
      if (!house) return;
      if (hasLocalHouseAuthority(house)) return;
      throw new StugubyError(
        403,
        "HOME_LOCAL_AUTHORITY_REQUIRED",
        "This setting stays with the authoritative Home and is not shared through Stuguby",
      );
    },
  assertSharedHouseFloorPlanAssetsUnchanged(this: StugubyServiceInternals, houseId: string, floors: Floor[]): void {
      const house = this.database.getHouse(houseId);
      if (!house) return;
      if (!house.stuguby || house.stuguby.syncState === "detached" || house.stuguby.ownership === "local") return;
      const current = new Map(house.floors.map((floor) => [floor.id, floor.backgroundImage]));
      if (floors.some((floor) => floor.backgroundImage !== current.get(floor.id))) {
        throw new StugubyError(
          403,
          "HOME_FLOORPLAN_ASSET_LOCAL_AUTHORITY",
          "Floor-plan images remain with the authoritative Home and are not changed through shared editing",
        );
      }
    },
});
