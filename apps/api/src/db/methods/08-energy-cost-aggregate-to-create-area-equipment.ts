import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { AreaEquipmentRow, DEFAULT_COLLECTION_LIMIT, DEFAULT_PROPERTY_ID, EnergyCostAggregateRow, PropertyAreaRow, boundedCollectionLimit, boundedCollectionOffset } from "../support/01-json-value-to-area-equipment-row.js";
import { LocalMaintenanceTaskRevisionActor } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { areaEquipmentFromRow, propertyAreaFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  /**
     * Prices every cumulative-meter delta by the exact price intervals it overlaps.
     * A delta spanning several price intervals is distributed by overlap duration;
     * counter resets contribute the new post-reset counter value.
     */
  energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord {
      const row = this.db.prepare(`WITH boundary_sample AS (
          SELECT id, timestamp, value FROM measurement_samples
          WHERE sensor_id = ? AND metric = 'energy' AND quality <> 'stale' AND timestamp < ?
          ORDER BY timestamp DESC, id DESC LIMIT 1
        ), window_samples AS (
          SELECT id, timestamp, value FROM measurement_samples
          WHERE sensor_id = ? AND metric = 'energy' AND quality <> 'stale'
            AND timestamp >= ? AND timestamp <= ?
        ), deduplicated AS (
          SELECT timestamp, value FROM (
            SELECT id, timestamp, value,
              ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY id DESC) AS sample_rank
            FROM (SELECT * FROM boundary_sample UNION ALL SELECT * FROM window_samples)
          ) WHERE sample_rank = 1
        ), ordered AS (
          SELECT timestamp AS current_at, value AS current_value,
            LAG(timestamp) OVER (ORDER BY timestamp) AS previous_at,
            LAG(value) OVER (ORDER BY timestamp) AS previous_value
          FROM deduplicated
        ), deltas AS (
          SELECT previous_at, current_at,
            CASE WHEN previous_at < ? THEN ? ELSE previous_at END AS window_start,
            CASE WHEN current_value >= previous_value THEN current_value - previous_value
              ELSE MAX(0, current_value) END AS base_delta_kwh,
            (julianday(current_at) - julianday(previous_at)) * 86400000.0 AS full_duration_ms
          FROM ordered
          WHERE previous_at IS NOT NULL AND current_at > ?
            AND current_value >= 0 AND previous_value >= 0
            AND julianday(current_at) > julianday(previous_at)
        ), normalized AS (
          SELECT *,
            base_delta_kwh * ((julianday(current_at) - julianday(window_start)) * 86400000.0)
              / full_duration_ms AS window_delta_kwh,
            (julianday(current_at) - julianday(window_start)) * 86400000.0 AS window_duration_ms
          FROM deltas
        ), priced AS (
          SELECT normalized.*,
            price.raw_price_cents_per_kwh, price.margin_cents_per_kwh,
            (julianday(MIN(normalized.current_at, price.end_at))
              - julianday(MAX(normalized.window_start, price.start_at))) * 86400000.0 AS overlap_ms
          FROM normalized JOIN electricity_price_points AS price
            ON price.property_id = ?
            AND price.start_at < normalized.current_at
            AND price.end_at > normalized.window_start
        ), allocations AS (
          SELECT overlap_ms,
            base_delta_kwh * overlap_ms / full_duration_ms AS allocated_kwh,
            raw_price_cents_per_kwh + margin_cents_per_kwh AS effective_price_cents_per_kwh
          FROM priced WHERE overlap_ms > 0
        )
        SELECT
          (SELECT COUNT(*) FROM normalized) AS delta_count,
          (SELECT COALESCE(SUM(window_delta_kwh), 0) FROM normalized) AS consumption_kwh,
          (SELECT COALESCE(SUM(allocated_kwh), 0) FROM allocations) AS priced_consumption_kwh,
          (SELECT COALESCE(SUM(allocated_kwh * effective_price_cents_per_kwh / 100.0), 0) FROM allocations) AS cost_eur,
          (SELECT COALESCE(SUM(window_duration_ms), 0) FROM normalized) AS total_duration_ms,
          (SELECT COALESCE(SUM(overlap_ms), 0) FROM allocations) AS priced_duration_ms,
          (SELECT MIN(window_start) FROM normalized) AS coverage_from,
          (SELECT MAX(current_at) FROM normalized) AS coverage_until`)
        .get(query.sensorId, query.from, query.sensorId, query.from, query.to,
          query.from, query.from, query.from, query.propertyId) as unknown as EnergyCostAggregateRow;
      return {
        deltaCount: Number(row.delta_count ?? 0),
        consumptionKwh: Number(row.consumption_kwh ?? 0),
        pricedConsumptionKwh: Number(row.priced_consumption_kwh ?? 0),
        costEur: Number(row.cost_eur ?? 0),
        totalDurationMs: Number(row.total_duration_ms ?? 0),
        pricedDurationMs: Number(row.priced_duration_ms ?? 0),
        coverageFrom: row.coverage_from,
        coverageUntil: row.coverage_until,
      };
    },
  updateProperty(id: string, patch: PropertyPatch): Property | null {
      return this.immediateTransaction(() => {
        const current = this.getProperty(id);
        if (!current) return null;
        const next: Property = { ...current, updatedAt: this.nextUpdatedAt(current.updatedAt) };
        if (patch.name !== undefined) next.name = this.propertyRequiredText(patch.name, "Property name", 200);
        if (patch.description !== undefined) {
          next.description = this.propertyOptionalText(patch.description, "Property description", 5_000);
        }
        if (patch.location !== undefined) next.location = patch.location;
        if (next.location) this.validateHouseLocation(next.location);
        this.db.prepare(`UPDATE properties SET name = ?, description = ?, location_json = ?, updated_at = ? WHERE id = ?`)
          .run(next.name, next.description, next.location ? JSON.stringify(next.location) : null, next.updatedAt, id);
        return next;
      });
    },
  deleteProperty(id: string): boolean {
      if (id === DEFAULT_PROPERTY_ID) {
        throw new ClimateDataValidationError(
          409,
          "DEFAULT_PROPERTY_REQUIRED",
          "The local default property cannot be deleted",
        );
      }
      this.requireImmutableTelemetryLineage("property", id);
      try {
        return Number(this.db.prepare("DELETE FROM properties WHERE id = ?").run(id).changes) > 0;
      } catch (error) {
        if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
          throw new ClimateDataValidationError(
            409,
            "PROPERTY_IN_USE",
            `Property ${id} still contains houses, areas, equipment, notes, or maintenance tasks`,
          );
        }
        throw error;
      }
    },
  listPropertyAreas(propertyId?: string, limit = DEFAULT_COLLECTION_LIMIT, offset = 0): PropertyArea[] {
      const rows = (propertyId
        ? this.db.prepare("SELECT * FROM property_areas WHERE property_id = ? ORDER BY name, id LIMIT ? OFFSET ?")
          .all(propertyId, boundedCollectionLimit(limit), boundedCollectionOffset(offset))
        : this.db.prepare("SELECT * FROM property_areas ORDER BY name, id LIMIT ? OFFSET ?")
          .all(boundedCollectionLimit(limit), boundedCollectionOffset(offset))) as unknown as PropertyAreaRow[];
      return rows.map(propertyAreaFromRow);
    },
  getPropertyArea(id: string): PropertyArea | null {
      const row = this.db.prepare("SELECT * FROM property_areas WHERE id = ?").get(id) as unknown as PropertyAreaRow | undefined;
      return row ? propertyAreaFromRow(row) : null;
    },
  createPropertyArea(input: PropertyAreaInput): PropertyArea {
      return this.immediateTransaction(() => {
        if (!this.getProperty(input.propertyId)) {
          throw new ClimateDataValidationError(404, "AREA_PROPERTY_NOT_FOUND", `Property ${input.propertyId} does not exist`);
        }
        const timestamp = new Date().toISOString();
        const area: PropertyArea = {
          id: input.id ?? randomUUID(),
          propertyId: input.propertyId,
          name: this.propertyRequiredText(input.name, "Area name", 200),
          kind: input.kind,
          description: this.propertyOptionalText(input.description ?? null, "Area description", 5_000),
          ...(input.location ? { location: structuredClone(input.location) } : {}),
          polygon: structuredClone(input.polygon),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.validatePropertyArea(area);
        try {
          this.db.prepare(`INSERT INTO property_areas
            (id, property_id, name, kind, description, location_json, polygon_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(area.id, area.propertyId, area.name, area.kind, area.description,
              area.location ? JSON.stringify(area.location) : null, JSON.stringify(area.polygon),
              area.createdAt, area.updatedAt);
        } catch (error) {
          if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
            throw new ClimateDataValidationError(409, "AREA_ID_CONFLICT", `Area ${area.id} already exists`);
          }
          throw error;
        }
        return area;
      });
    },
  updatePropertyArea(
      id: string,
      patch: PropertyAreaPatch,
      actor: LocalMaintenanceTaskRevisionActor = "local-rest",
    ): PropertyArea | null {
      return this.immediateTransaction(() => {
        const current = this.getPropertyArea(id);
        if (!current) return null;
        if (patch.propertyId !== undefined && !this.getProperty(patch.propertyId)) {
          throw new ClimateDataValidationError(404, "AREA_PROPERTY_NOT_FOUND", `Property ${patch.propertyId} does not exist`);
        }
        if (patch.propertyId !== undefined && patch.propertyId !== current.propertyId) {
          this.ensureScopeMoveCanDetachHouses(
            `task.area_id = ? OR task.equipment_id IN (SELECT id FROM area_equipment WHERE area_id = ?)`,
            [id, id],
            patch.propertyId,
          );
        }
        const affectedTasks = patch.propertyId !== undefined && patch.propertyId !== current.propertyId
          ? this.maintenanceTasksBeforeScopeMove(
            `area_id = ? OR equipment_id IN (SELECT id FROM area_equipment WHERE area_id = ?)`,
            [id, id],
          )
          : [];
        const next: PropertyArea = {
          ...current,
          ...(patch.propertyId !== undefined ? { propertyId: patch.propertyId } : {}),
          ...(patch.name !== undefined ? { name: this.propertyRequiredText(patch.name, "Area name", 200) } : {}),
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.description !== undefined
            ? { description: this.propertyOptionalText(patch.description, "Area description", 5_000) }
            : {}),
          ...(patch.polygon !== undefined ? { polygon: structuredClone(patch.polygon) } : {}),
          updatedAt: this.nextUpdatedAt(current.updatedAt),
        };
        if (patch.location === null) delete next.location;
        else if (patch.location !== undefined) next.location = structuredClone(patch.location);
        this.validatePropertyArea(next);
        try {
          this.db.prepare(`UPDATE property_areas
            SET property_id = ?, name = ?, kind = ?, description = ?, location_json = ?, polygon_json = ?, updated_at = ? WHERE id = ?`)
            .run(next.propertyId, next.name, next.kind, next.description,
              next.location ? JSON.stringify(next.location) : null, JSON.stringify(next.polygon), next.updatedAt, id);
        } catch (error) {
          if (error instanceof Error && error.message.includes("TRACKING_ASSIGNMENT_PROPERTY_MOVE")) {
            throw new ClimateDataValidationError(
              409,
              "TRACKED_EQUIPMENT_PROPERTY_MOVE",
              "Remove active tracking-tag assignments before moving this area to another Property",
            );
          }
          throw error;
        }
        this.recordScopeMoveMaintenanceRevisions(affectedTasks, actor);
        return next;
      });
    },
  deletePropertyArea(id: string): boolean {
      try {
        return Number(this.db.prepare("DELETE FROM property_areas WHERE id = ?").run(id).changes) > 0;
      } catch (error) {
        if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
          throw new ClimateDataValidationError(
            409,
            "AREA_IN_USE",
            `Area ${id} is referenced by equipment, notes, or maintenance tasks`,
          );
        }
        throw error;
      }
    },
  listAreaEquipment(filters: {
      propertyId?: string;
      areaId?: string;
      houseId?: string;
      limit?: number;
      offset?: number;
    } = {}): AreaEquipment[] {
      const clauses: string[] = [];
      const values: string[] = [];
      if (filters.propertyId) { clauses.push("property_id = ?"); values.push(filters.propertyId); }
      if (filters.areaId) { clauses.push("area_id = ?"); values.push(filters.areaId); }
      if (filters.houseId) { clauses.push("house_id = ?"); values.push(filters.houseId); }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db.prepare(`SELECT * FROM area_equipment${where} ORDER BY name, id LIMIT ? OFFSET ?`)
        .all(...values, boundedCollectionLimit(filters.limit), boundedCollectionOffset(filters.offset)) as unknown as AreaEquipmentRow[];
      return rows.map(areaEquipmentFromRow);
    },
  getAreaEquipment(id: string): AreaEquipment | null {
      const row = this.db.prepare("SELECT * FROM area_equipment WHERE id = ?").get(id) as unknown as AreaEquipmentRow | undefined;
      return row ? areaEquipmentFromRow(row) : null;
    },
  createAreaEquipment(input: AreaEquipmentInput): AreaEquipment {
      return this.immediateTransaction(() => {
        const areaId = input.areaId ?? null;
        const houseId = input.houseId ?? null;
        if (areaId && houseId) {
          throw new ClimateDataValidationError(
            422,
            "INVALID_EQUIPMENT_LOCATION",
            "Equipment may have one expected Area or Home, not both",
          );
        }
        const area = areaId ? this.getPropertyArea(areaId) : null;
        if (areaId && !area) {
          throw new ClimateDataValidationError(404, "EQUIPMENT_AREA_NOT_FOUND", `Area ${areaId} does not exist`);
        }
        const house = houseId ? this.getHouse(houseId) : null;
        if (houseId && !house) {
          throw new ClimateDataValidationError(404, "EQUIPMENT_HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
        }
        const propertyId = input.propertyId?.trim() || area?.propertyId || house?.propertyId;
        if (!propertyId) {
          throw new ClimateDataValidationError(
            422,
            "EQUIPMENT_PROPERTY_REQUIRED",
            "Unassigned equipment requires a Property",
          );
        }
        const timestamp = new Date().toISOString();
        const equipment: AreaEquipment = {
          id: input.id ?? randomUUID(),
          propertyId,
          areaId,
          houseId,
          ...(input.location ? { location: structuredClone(input.location) } : {}),
          name: this.propertyRequiredText(input.name, "Equipment name", 200),
          kind: this.propertyRequiredText(input.kind, "Equipment kind", 200),
          manufacturer: this.propertyOptionalText(input.manufacturer ?? null, "Equipment manufacturer", 200),
          model: this.propertyOptionalText(input.model ?? null, "Equipment model", 200),
          serialNumber: this.propertyOptionalText(input.serialNumber ?? null, "Equipment serial number", 200),
          status: input.status ?? "active",
          notes: this.propertyOptionalText(input.notes ?? null, "Equipment notes", 5_000),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.validateAreaEquipment(equipment);
        try {
          this.db.prepare(`INSERT INTO area_equipment
            (id, property_id, area_id, house_id, location_json, name, kind, manufacturer, model, serial_number,
             status, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(equipment.id, equipment.propertyId, equipment.areaId, equipment.houseId ?? null,
              equipment.location ? JSON.stringify(equipment.location) : null, equipment.name, equipment.kind,
              equipment.manufacturer, equipment.model, equipment.serialNumber, equipment.status, equipment.notes,
              equipment.createdAt, equipment.updatedAt);
        } catch (error) {
          if (error instanceof Error && error.message.includes("UNIQUE constraint failed: area_equipment.id")) {
            throw new ClimateDataValidationError(409, "EQUIPMENT_ID_CONFLICT", `Equipment ${equipment.id} already exists`);
          }
          throw error;
        }
        return equipment;
      });
    },
});
