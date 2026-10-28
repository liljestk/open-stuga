import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, type Property, type PropertyCreateInput, type StugubyPropertyLink, automaticWeatherLocation, hasLocalHouseAuthority, isAutomaticWeatherLocation, type PropertyPatch, type StugubyHouseLink } from "@climate-twin/contracts";
import { DEFAULT_COLLECTION_LIMIT, DEFAULT_PROPERTY_ID, boundedCollectionLimit, boundedCollectionOffset, MAX_COLLECTION_LIMIT } from "../support/domain-limits.js";
import { PropertyRow, HouseRow } from "../support/row-types.js";
import { PropertyMigrationResult } from "../support/record-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { propertyFromRow, houseFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { outdoorLocationKey } from "../support/outdoor-location.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listProperties(limit?: number, offset?: number): Property[];
    getProperty(id: string): Property | null;
    setPropertyStugubyLink(id: string, link: StugubyPropertyLink | null): Property | null;
    assertTelemetryResourceIdAvailable(
        resourceType: "property" | "house" | "sensor",
        resourceId: string,
      ): void;
    createProperty(input: PropertyCreateInput): Property;
    updateProperty(id: string, patch: PropertyPatch): Property | null;
    deleteProperty(id: string): boolean;
    propertyRequiredText(value: string, field: string, maximumLength: number): string;
    propertyOptionalText(value: string | null, field: string, maximumLength: number): string | null;
    nextUpdatedAt(previous: string): string;
    ensureDefaultProperty(): Property;
    migratePropertyInto(sourcePropertyId: string, targetPropertyId: string, houseLinks: Readonly<Record<string, StugubyHouseLink>>): PropertyMigrationResult;
  }

  interface ClimateDatabaseCore {
    listProperties(limit?: number, offset?: number): Property[];
    getProperty(id: string): Property | null;
    setPropertyStugubyLink(id: string, link: StugubyPropertyLink | null): Property | null;
    createProperty(input: PropertyCreateInput): Property;
    updateProperty(id: string, patch: PropertyPatch): Property | null;
    deleteProperty(id: string): boolean;
    migratePropertyInto(sourcePropertyId: string, targetPropertyId: string, houseLinks: Readonly<Record<string, StugubyHouseLink>>): PropertyMigrationResult;
  }
}

registerDatabaseMethods({
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
          if (isSqliteFailure(error, "unique", "properties.id")) {
            throw new ClimateDataValidationError(409, "PROPERTY_ID_CONFLICT", `Property ${property.id} already exists`);
          }
          throw error;
        }
        return property;
      });
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
        if (patch.defaultHouseId !== undefined) {
          if (patch.defaultHouseId === null) next.defaultHouseId = null;
          else {
            const defaultHouse = this.getHouse(patch.defaultHouseId);
            if (!defaultHouse || defaultHouse.propertyId !== id) {
              throw new ClimateDataValidationError(
                422,
                "PROPERTY_DEFAULT_HOUSE_INVALID",
                "The default Home must be an active Home in this Property",
              );
            }
            next.defaultHouseId = defaultHouse.id;
          }
        }
        if (patch.location !== undefined) next.location = patch.location;
        if (next.location) this.validateHouseLocation(next.location);
        this.db.prepare(`UPDATE properties SET name = ?, description = ?, default_house_id = ?, location_json = ?, updated_at = ? WHERE id = ?`)
          .run(next.name, next.description, next.defaultHouseId,
            next.location ? JSON.stringify(next.location) : null, next.updatedAt, id);
        if (patch.location !== undefined) {
          const rows = this.db.prepare("SELECT * FROM houses WHERE property_id = ? AND deleted_at IS NULL")
            .all(id) as unknown as HouseRow[];
          for (const row of rows) {
            const house = houseFromRow(row);
            if (!hasLocalHouseAuthority(house)) continue;
            if (house.location && !isAutomaticWeatherLocation(house.location)) continue;
            const inferred = automaticWeatherLocation(next.location, house.mapPlacement);
            const previousKey = outdoorLocationKey(house.location);
            const nextKey = outdoorLocationKey(inferred);
            if (previousKey === nextKey && house.location?.source === inferred?.source) continue;
            const houseUpdatedAt = this.nextUpdatedAt(house.updatedAt);
            this.db.prepare("UPDATE houses SET location_json = ?, updated_at = ? WHERE id = ?")
              .run(inferred ? JSON.stringify(inferred) : null, houseUpdatedAt, house.id);
            this.db.prepare("DELETE FROM analytics_daily_findings WHERE house_id = ?").run(house.id);
          }
        }
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
        if (isSqliteFailure(error, "foreign-key")) {
          throw new ClimateDataValidationError(
            409,
            "PROPERTY_IN_USE",
            `Property ${id} still contains houses, areas, equipment, notes, or maintenance tasks`,
          );
        }
        throw error;
      }
    },
  propertyRequiredText(value: string, field: string, maximumLength: number): string {
      if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > maximumLength) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_PROPERTY_FIELD",
          `${field} must be a non-empty string of at most ${maximumLength} characters`,
        );
      }
      return value.trim();
    },
  propertyOptionalText(value: string | null, field: string, maximumLength: number): string | null {
      if (value === null) return null;
      if (typeof value !== "string" || Array.from(value.trim()).length > maximumLength) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_PROPERTY_FIELD",
          `${field} must be a string of at most ${maximumLength} characters or null`,
        );
      }
      return value.trim() || null;
    },
  nextUpdatedAt(previous: string): string {
      const previousMs = Date.parse(previous);
      const timestamp = Number.isFinite(previousMs) ? Math.max(Date.now(), previousMs + 1) : Date.now();
      return new Date(timestamp).toISOString();
    },
  ensureDefaultProperty(): Property {
      return this.getProperty(DEFAULT_PROPERTY_ID) ?? this.createProperty({ id: DEFAULT_PROPERTY_ID, name: "My property" });
    },
  /**
     * Destructively merges one local Property into an adopted Stuguby Property.
     * Home and telemetry identities are retained; only their Property parent and
     * explicit Stuguby provenance change.
     */
  migratePropertyInto(
      sourcePropertyId: string,
      targetPropertyId: string,
      houseLinks: Readonly<Record<string, StugubyHouseLink>>,
    ): PropertyMigrationResult {
      return this.immediateTransaction(() => {
        if (sourcePropertyId === targetPropertyId) {
          throw new ClimateDataValidationError(409, "PROPERTY_MIGRATION_SAME_TARGET", "Source and target Property must differ");
        }
        if (!this.getProperty(sourcePropertyId)) {
          throw new ClimateDataValidationError(404, "PROPERTY_NOT_FOUND", `Property ${sourcePropertyId} does not exist`);
        }
        if (!this.getProperty(targetPropertyId)) {
          throw new ClimateDataValidationError(404, "PROPERTY_NOT_FOUND", `Property ${targetPropertyId} does not exist`);
        }
        const houseIds = this.listHouses(sourcePropertyId).map((item) => item.id);
        const areaIds = this.listPropertyAreas(sourcePropertyId, MAX_COLLECTION_LIMIT).map((item) => item.id);
        const equipmentIds = this.listAreaEquipment({ propertyId: sourcePropertyId, limit: MAX_COLLECTION_LIMIT }).map((item) => item.id);
        const noteIds = this.listPropertyNotes({ propertyId: sourcePropertyId, limit: MAX_COLLECTION_LIMIT }).map((item) => item.id);
        const maintenanceTaskIds = this.listMaintenanceTasks({ propertyId: sourcePropertyId, limit: MAX_COLLECTION_LIMIT }).map((item) => item.id);
        for (const houseId of houseIds) {
          const link = houseLinks[houseId];
          if (!link) throw new ClimateDataValidationError(400, "HOUSE_STUGBY_LINK_REQUIRED", `Home ${houseId} is missing Stuguby ownership metadata`);
          this.db.prepare("UPDATE houses SET property_id = ?, stugby_json = ?, updated_at = ? WHERE id = ?")
            .run(targetPropertyId, JSON.stringify(link), new Date().toISOString(), houseId);
        }
        this.db.prepare("UPDATE property_areas SET property_id = ? WHERE property_id = ?")
          .run(targetPropertyId, sourcePropertyId);
        this.db.prepare("UPDATE area_equipment SET property_id = ? WHERE property_id = ?")
          .run(targetPropertyId, sourcePropertyId);
        this.db.prepare("UPDATE property_notes SET property_id = ? WHERE property_id = ?")
          .run(targetPropertyId, sourcePropertyId);
        this.db.prepare("UPDATE maintenance_tasks SET property_id = ? WHERE property_id = ?")
          .run(targetPropertyId, sourcePropertyId);
        this.db.prepare(`UPDATE OR IGNORE local_guest_access_grants SET scope_id = ?
          WHERE scope_type = 'property' AND scope_id = ?`).run(targetPropertyId, sourcePropertyId);
        this.db.prepare("DELETE FROM properties WHERE id = ?").run(sourcePropertyId);
        return {
          sourcePropertyId,
          targetPropertyId,
          houseIds,
          areaIds,
          equipmentIds,
          noteIds,
          maintenanceTaskIds,
        };
      });
    },
});
