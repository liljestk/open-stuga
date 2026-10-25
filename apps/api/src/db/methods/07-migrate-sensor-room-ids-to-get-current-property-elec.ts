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
import { DEFAULT_COLLECTION_LIMIT, DEFAULT_PROPERTY_ID, ElectricityPricePointRow, PropertyElectricityConfigRow, PropertyRow, boundedCollectionLimit, boundedCollectionOffset } from "../support/01-json-value-to-area-equipment-row.js";
import { ClimateDataValidationError, parseJson } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { electricityConfigFromRow, propertyFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";
import { projectedElectricityConfig, versionsWithLegacyContract } from "../../electricity/legacy-contract.js";
import { withTariffPrice } from "../../electricity/tariff-cost.js";

registerDatabaseMethods({
  /**
     * Links legacy room labels only when one room on the sensor's selected floor
     * has the exact same name. The completion marker is important: an explicitly
     * cleared relationship must not be silently recreated on a later restart.
     */
  migrateSensorRoomIds(): void {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_room_ids_v1'").get()) return;
      const rows = this.db.prepare(`SELECT sensor.id, sensor.floor_id, sensor.room, house.floors_json
        FROM sensors AS sensor
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE sensor.room_id IS NULL
        ORDER BY sensor.id`).all() as unknown as Array<{
          id: string;
          floor_id: string;
          room: string;
          floors_json: string;
        }>;
      const link = this.db.prepare("UPDATE sensors SET room_id = ? WHERE id = ? AND room_id IS NULL");
      for (const row of rows) {
        try {
          const floor = parseJson<Floor[]>(row.floors_json).find((candidate) => candidate.id === row.floor_id);
          const matches = floor?.rooms.filter((candidate) => candidate.name === row.room) ?? [];
          if (matches.length === 1) link.run(matches[0]!.id, row.id);
        } catch {
          // Preserve an unlinked legacy label when old layout JSON cannot be
          // interpreted safely; normal layout validation can repair it later.
        }
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('sensor_room_ids_v1', 'complete')").run();
    },
  seed(): void {
      const seeded = this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_version'").get() as { value: string } | undefined;
      if (seeded) return;
      this.immediateTransaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_version'").get()) return;

      const now = new Date().toISOString();
      const floors: Floor[] = [
        {
          id: "floor-ground",
          name: "Ground floor",
          type: "ground",
          width: 14,
          height: 10,
          elevation: 0,
          ceilingHeight: 2.8,
          wallHeight: 2.8,
          walls: [
            { id: "g-n", from: { x: 0, y: 0 }, to: { x: 14, y: 0 } },
            { id: "g-e", from: { x: 14, y: 0 }, to: { x: 14, y: 10 } },
            { id: "g-s", from: { x: 14, y: 10 }, to: { x: 0, y: 10 } },
            { id: "g-w", from: { x: 0, y: 10 }, to: { x: 0, y: 0 } },
            { id: "g-mid-v", from: { x: 8, y: 0 }, to: { x: 8, y: 10 } },
            { id: "g-mid-h", from: { x: 8, y: 5 }, to: { x: 14, y: 5 } },
          ],
          rooms: [
            { id: "living", name: "Living room", points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 0, y: 10 }] },
            { id: "kitchen", name: "Kitchen", points: [{ x: 8, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 5 }, { x: 8, y: 5 }] },
            { id: "utility", name: "Utility", points: [{ x: 8, y: 5 }, { x: 14, y: 5 }, { x: 14, y: 10 }, { x: 8, y: 10 }] },
          ],
        },
        {
          id: "floor-upper",
          name: "Upper floor",
          type: "upper",
          width: 14,
          height: 10,
          elevation: 3,
          ceilingHeight: 2.6,
          wallHeight: 2.6,
          walls: [
            { id: "u-n", from: { x: 0, y: 0 }, to: { x: 14, y: 0 } },
            { id: "u-e", from: { x: 14, y: 0 }, to: { x: 14, y: 10 } },
            { id: "u-s", from: { x: 14, y: 10 }, to: { x: 0, y: 10 } },
            { id: "u-w", from: { x: 0, y: 10 }, to: { x: 0, y: 0 } },
            { id: "u-mid-v", from: { x: 7, y: 0 }, to: { x: 7, y: 10 } },
            { id: "u-mid-h", from: { x: 7, y: 5 }, to: { x: 14, y: 5 } },
          ],
          rooms: [
            { id: "bedroom", name: "Bedroom", points: [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 10 }, { x: 0, y: 10 }] },
            { id: "office", name: "Office", points: [{ x: 7, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 5 }, { x: 7, y: 5 }] },
            { id: "bathroom", name: "Bathroom", points: [{ x: 7, y: 5 }, { x: 14, y: 5 }, { x: 14, y: 10 }, { x: 7, y: 10 }] },
          ],
        },
      ];
      const sensors: Sensor[] = [
        ["sensor-01", "Living room — window", "floor-ground", "Living room", 1.5, 2, 1.2],
        ["sensor-02", "Living room — hall", "floor-ground", "Living room", 6.5, 7.5, 1.2],
        ["sensor-03", "Kitchen", "floor-ground", "Kitchen", 11, 2.5, 1.3],
        ["sensor-04", "Utility room", "floor-ground", "Utility", 11, 7.5, 1.3],
        ["sensor-05", "Entrance", "floor-ground", "Living room", 4, 8.5, 1.2],
        ["sensor-06", "Bedroom — window", "floor-upper", "Bedroom", 1.5, 2, 4.2],
        ["sensor-07", "Bedroom — hall", "floor-upper", "Bedroom", 5.5, 7.5, 4.2],
        ["sensor-08", "Office", "floor-upper", "Office", 10.5, 2.5, 4.3],
        ["sensor-09", "Bathroom", "floor-upper", "Bathroom", 10.5, 7.5, 4.3],
        ["sensor-10", "Attic access", "floor-upper", "Bathroom", 13, 9, 5.5],
      ].map(([id, name, floorId, room, x, y, z]) => ({
        id: String(id), houseId: "house-main", floorId: String(floorId), name: String(name), room: String(room),
        model: "TP-Link Tapo T310/T315", x: Number(x), y: Number(y), z: Number(z), tags: ["seeded"], enabled: true,
      }));

        this.db.prepare(`INSERT INTO houses
          (id, property_id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run("house-main", DEFAULT_PROPERTY_ID, "My home", "Europe/Helsinki", null, null, null, JSON.stringify(floors), now, now);
        const sensorStatement = this.db.prepare(`INSERT INTO sensors
          (id, house_id, floor_id, name, room_id, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id, tags_json, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const sensor of sensors) {
          const roomId = floors.find((floor) => floor.id === sensor.floorId)?.rooms
            .find((room) => room.name === sensor.room)?.id ?? null;
          sensorStatement.run(sensor.id, sensor.houseId, sensor.floorId, sensor.name, roomId, sensor.room, sensor.model,
            sensor.x, sensor.y, sensor.z, null, null, null, JSON.stringify(sensor.tags), 1);
        }
        const readingStatement = this.db.prepare(`INSERT INTO readings
          (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const end = Date.now();
        for (let step = 288; step >= 0; step -= 1) {
          const timestamp = new Date(end - step * 5 * 60_000).toISOString();
          for (let index = 0; index < sensors.length; index += 1) {
            const phase = (288 - step) / 288 * Math.PI * 2;
            const temperature = 20.4 + Math.sin(phase - 1.1) * 1.25 + (index % 5) * 0.13 + Math.sin(step * 0.31 + index) * 0.12;
            const bathroomPulse = index === 8 && step > 45 && step < 60 ? 17 * Math.sin((step - 45) / 15 * Math.PI) : 0;
            const humidity = 43 + Math.sin(phase + 0.65) * 5 + (index % 3) * 1.4 + bathroomPulse;
            readingStatement.run(sensors[index]!.id, timestamp, Number(temperature.toFixed(2)), Number(humidity.toFixed(2)), 96 - (index % 8), "mock", "good");
          }
        }
        this.db.prepare(`INSERT INTO alert_rules
          (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled, telegram_enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run("rule-high-humidity", "Persistent high humidity", null, "humidity", "gte", 65, 900, "warning", 1, 1, 0);
        this.db.prepare(`INSERT INTO static_parameters
          (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run("parameter-year-built", "house-main", "house", "house-main", "yearBuilt", JSON.stringify(1998), null, "Year built");
        this.db.prepare("INSERT INTO metadata(key, value) VALUES ('seed_version', '1')").run();
      });
    },
  close(): void {
      this.closeCostReader();
      // Make file-backed shutdown deterministic on Windows as well as POSIX.
      // Schema-rebuild migrations can otherwise leave a WAL checkpoint pending
      // briefly after DatabaseSync.close(), which prevents immediate backup or
      // test-directory rotation even though the connection is closed.
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        this.db.exec("PRAGMA journal_mode = DELETE");
      } catch { /* The database may be read-only or already closing. */ }
      this.db.close();
    },
  listProperties(limit = DEFAULT_COLLECTION_LIMIT, offset = 0): Property[] {
      const rows = this.db.prepare("SELECT * FROM properties ORDER BY name, id LIMIT ? OFFSET ?")
        .all(boundedCollectionLimit(limit), boundedCollectionOffset(offset)) as unknown as PropertyRow[];
      return rows.map(propertyFromRow);
    },
  getProperty(id: string): Property | null {
      const row = this.db.prepare("SELECT * FROM properties WHERE id = ?").get(id) as unknown as PropertyRow | undefined;
      return row ? propertyFromRow(row) : null;
    },
  setPropertyStugubyLink(id: string, link: StugubyPropertyLink | null): Property | null {
      const result = this.db.prepare("UPDATE properties SET stugby_json = ? WHERE id = ?")
        .run(link ? JSON.stringify(link) : null, id);
      return Number(result.changes) === 1 ? this.getProperty(id) : null;
    },
  assertTelemetryResourceIdAvailable(
      resourceType: "property" | "house" | "sensor",
      resourceId: string,
    ): void {
      const retired = this.db.prepare(`SELECT 1 FROM retired_telemetry_resource_ids
        WHERE resource_type = ? AND resource_id = ? LIMIT 1`).get(resourceType, resourceId);
      if (!retired) return;
      throw new ClimateDataValidationError(
        409,
        `${resourceType.toUpperCase()}_ID_RETIRED`,
        `The ${resourceType} id ${resourceId} was previously retired and cannot be reused`,
      );
    },
  createProperty(input: PropertyCreateInput): Property {
      const timestamp = new Date().toISOString();
      const property: Property = {
        id: input.id ?? randomUUID(),
        name: this.propertyRequiredText(input.name, "Property name", 200),
        description: this.propertyOptionalText(input.description ?? null, "Property description", 5_000),
        defaultHouseId: null,
        location: input.location ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.assertTelemetryResourceIdAvailable("property", property.id);
      if (property.location) this.validateHouseLocation(property.location);
      return this.immediateTransaction(() => {
        try {
          this.db.prepare(`INSERT INTO properties
            (id, name, description, location_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(property.id, property.name, property.description,
              property.location ? JSON.stringify(property.location) : null, property.createdAt, property.updatedAt);
          this.db.prepare(`INSERT INTO property_electricity_configs
            (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
             contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
            VALUES (?, 'porssisahko', ?, 1, 0, 'spot', NULL, NULL, NULL, NULL, NULL, ?)`)
            .run(property.id, DEFAULT_ELECTRICITY_PRICE_ENDPOINT, timestamp);
        } catch (error) {
          if (error instanceof Error && error.message.includes("UNIQUE constraint failed: properties.id")) {
            throw new ClimateDataValidationError(409, "PROPERTY_ID_CONFLICT", `Property ${property.id} already exists`);
          }
          throw error;
        }
        return property;
      });
    },
  getPropertyElectricityConfig(propertyId: string): PropertyElectricityConfig | null {
      const row = this.db.prepare("SELECT * FROM property_electricity_configs WHERE property_id = ?")
        .get(propertyId) as unknown as PropertyElectricityConfigRow | undefined;
      return row
        ? projectedElectricityConfig(electricityConfigFromRow(row), this.getPropertyElectricityTariff(propertyId))
        : null;
    },
  listPropertyElectricityConfigs(): PropertyElectricityConfig[] {
      const rows = this.db.prepare("SELECT * FROM property_electricity_configs ORDER BY property_id")
        .all() as unknown as PropertyElectricityConfigRow[];
      return rows.map((row) => projectedElectricityConfig(
        electricityConfigFromRow(row),
        this.getPropertyElectricityTariff(row.property_id),
      ));
    },
  updatePropertyElectricityConfig(propertyId: string, input: PropertyElectricityConfigInput): PropertyElectricityConfig | null {
      if (!this.getProperty(propertyId)) return null;
      if (!["porssisahko", "custom"].includes(input.provider)) {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_PROVIDER", "Unsupported electricity price provider");
      }
      let endpoint: URL;
      try { endpoint = new URL(input.endpointUrl); } catch {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_ENDPOINT", "Electricity price endpoint must be a valid URL");
      }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_ENDPOINT", "Electricity price endpoint must use HTTPS without embedded credentials");
      }
      const stored = this.getPropertyElectricityConfig(propertyId);
      const margin = input.marginCentsPerKwh ?? stored?.marginCentsPerKwh ?? 0;
      const contractType = input.contractType ?? stored?.contractType ?? "spot";
      const monthlyFee = input.monthlyFeeEur === undefined ? stored?.monthlyFeeEur ?? null : input.monthlyFeeEur;
      if (!Number.isFinite(margin) || margin < -100 || margin > 100) {
        throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_MARGIN", "Electricity margin must be between -100 and 100 cents/kWh");
      }
      if (!["spot", "fixed", "other"].includes(contractType)) {
        throw new ClimateDataValidationError(400, "INVALID_CONTRACT_TYPE", "Unsupported electricity contract type");
      }
      if (input.monthlyFeeEur !== undefined && input.monthlyFeeEur !== null
        && (!Number.isFinite(input.monthlyFeeEur) || input.monthlyFeeEur < 0 || input.monthlyFeeEur > 100_000)) {
        throw new ClimateDataValidationError(400, "INVALID_MONTHLY_FEE", "Monthly fee must be between 0 and 100000 euros");
      }
      const timestamp = new Date().toISOString();
      const text = (value: string | null | undefined, label: string): string | null => (
        this.propertyOptionalText(value ?? null, label, 200)
      );
      this.db.prepare(`INSERT INTO property_electricity_configs
        (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
         contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(property_id) DO UPDATE SET provider = excluded.provider, endpoint_url = excluded.endpoint_url,
          enabled = excluded.enabled, margin_cents_per_kwh = excluded.margin_cents_per_kwh,
          contract_type = excluded.contract_type, contract_name = excluded.contract_name,
          retailer = excluded.retailer, monthly_fee_eur = excluded.monthly_fee_eur,
          last_error = NULL, updated_at = excluded.updated_at`)
        .run(propertyId, input.provider, endpoint.toString(), input.enabled ? 1 : 0, margin,
          contractType, text(input.contractName, "Contract name"), text(input.retailer, "Retailer"),
          monthlyFee, timestamp);
      this.db.prepare(`UPDATE electricity_price_points SET margin_cents_per_kwh = ?
        WHERE property_id = ? AND end_at > ?`).run(margin, propertyId, timestamp);
      // A saved tariff is authoritative; legacy fields sent by older clients
      // update only the version in force today.
      const tariff = this.getPropertyElectricityTariff(propertyId);
      const contractSent = input.marginCentsPerKwh !== undefined || input.contractType !== undefined
        || input.monthlyFeeEur !== undefined;
      if (tariff && tariff.revision > 0 && contractSent) {
        const versions = versionsWithLegacyContract(tariff, { contractType, marginCentsPerKwh: margin, monthlyFeeEur: monthlyFee });
        if (versions) this.savePropertyElectricityTariff(propertyId, versions);
      }
      return this.getPropertyElectricityConfig(propertyId);
    },
  storePropertyElectricityPrices(
      propertyId: string,
      prices: Array<{ startAt: string; endAt: string; rawPriceCentsPerKwh: number }>,
      fetchedAt: string,
    ): void {
      const margin = this.getPropertyElectricityConfig(propertyId)?.marginCentsPerKwh ?? 0;
      this.immediateTransaction(() => {
        const statement = this.db.prepare(`INSERT INTO electricity_price_points
          (property_id, start_at, end_at, raw_price_cents_per_kwh, margin_cents_per_kwh, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(property_id, start_at) DO UPDATE SET end_at = excluded.end_at,
            raw_price_cents_per_kwh = excluded.raw_price_cents_per_kwh,
            margin_cents_per_kwh = CASE
              WHEN electricity_price_points.end_at <= excluded.fetched_at THEN electricity_price_points.margin_cents_per_kwh
              ELSE excluded.margin_cents_per_kwh
            END,
            fetched_at = excluded.fetched_at`);
        for (const price of prices) {
          statement.run(propertyId, price.startAt, price.endAt, price.rawPriceCentsPerKwh, margin, fetchedAt);
        }
        const overlap = this.db.prepare(`SELECT earlier.start_at, later.start_at AS overlapping_start
          FROM electricity_price_points AS earlier
          JOIN electricity_price_points AS later
            ON later.property_id = earlier.property_id
            AND later.start_at > earlier.start_at
            AND later.start_at < earlier.end_at
          WHERE earlier.property_id = ? LIMIT 1`).get(propertyId) as {
          start_at: string;
          overlapping_start: string;
        } | undefined;
        if (overlap) {
          throw new ClimateDataValidationError(
            422,
            "OVERLAPPING_ELECTRICITY_PRICES",
            `Electricity price intervals ${overlap.start_at} and ${overlap.overlapping_start} overlap`,
          );
        }
        this.db.prepare(`UPDATE property_electricity_configs
          SET last_fetched_at = ?, last_error = NULL, updated_at = ? WHERE property_id = ?`)
          .run(fetchedAt, fetchedAt, propertyId);
      });
    },
  setPropertyElectricityFetchError(propertyId: string, message: string): void {
      this.db.prepare("UPDATE property_electricity_configs SET last_error = ?, updated_at = ? WHERE property_id = ?")
        .run(message.slice(0, 1_000), new Date().toISOString(), propertyId);
    },
  listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[] {
      const tariff = this.getPropertyElectricityTariff(propertyId);
      if (!tariff) return [];
      const timeZone = this.propertyElectricityTimeZone(propertyId);
      const rows = this.db.prepare(`SELECT * FROM electricity_price_points
        WHERE property_id = ? AND end_at >= ? AND start_at <= ? ORDER BY start_at`)
        .all(propertyId, from, to) as unknown as ElectricityPricePointRow[];
      return rows.map((row) => withTariffPrice({
        propertyId: row.property_id,
        startAt: row.start_at,
        endAt: row.end_at,
        rawPriceCentsPerKwh: row.raw_price_cents_per_kwh,
        effectivePriceCentsPerKwh: row.raw_price_cents_per_kwh,
        effectivePriceEurPerKwh: row.raw_price_cents_per_kwh / 100,
        fetchedAt: row.fetched_at,
      }, tariff.versions, timeZone));
    },
  getCurrentPropertyElectricityPrice(propertyId: string, at = new Date().toISOString()): PropertyElectricityPricePoint | null {
      return this.listPropertyElectricityPrices(propertyId, at, at)[0] ?? null;
    },
});
