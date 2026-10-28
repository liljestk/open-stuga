import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import type { PropertyArea, PropertyAreaInput, PropertyAreaPatch } from "@climate-twin/contracts";
import { DEFAULT_COLLECTION_LIMIT, boundedCollectionLimit, boundedCollectionOffset, MAX_PROPERTY_AREA_VERTICES, PROPERTY_AREA_KINDS } from "../support/domain-limits.js";
import { PropertyAreaRow } from "../support/row-types.js";
import { LocalMaintenanceTaskRevisionActor } from "../support/record-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { propertyAreaFromRow } from "../support/row-mappers.js";
import { roomPolygonSelfIntersects } from "../support/layout-geometry.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listPropertyAreas(propertyId?: string, limit?: number, offset?: number): PropertyArea[];
    getPropertyArea(id: string): PropertyArea | null;
    createPropertyArea(input: PropertyAreaInput): PropertyArea;
    updatePropertyArea(id: string, patch: PropertyAreaPatch, actor?: LocalMaintenanceTaskRevisionActor): PropertyArea | null;
    deletePropertyArea(id: string): boolean;
    validatePropertyArea(area: PropertyArea): void;
  }

  interface ClimateDatabaseCore {
    listPropertyAreas(propertyId?: string, limit?: number, offset?: number): PropertyArea[];
    getPropertyArea(id: string): PropertyArea | null;
    createPropertyArea(input: PropertyAreaInput): PropertyArea;
    updatePropertyArea(id: string, patch: PropertyAreaPatch, actor?: LocalMaintenanceTaskRevisionActor): PropertyArea | null;
    deletePropertyArea(id: string): boolean;
  }
}

registerDatabaseMethods({
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
          if (isSqliteFailure(error, "unique")) {
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
          if (isSqliteFailure(error, "trigger", "TRACKING_BINDING_PROPERTY_MOVE")) {
            throw new ClimateDataValidationError(
              409,
              "TRACKED_EQUIPMENT_PROPERTY_MOVE",
              "Remove active tracking endpoint bindings before moving this area to another Property",
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
        if (isSqliteFailure(error, "foreign-key")) {
          throw new ClimateDataValidationError(
            409,
            "AREA_IN_USE",
            `Area ${id} is referenced by equipment, notes, or maintenance tasks`,
          );
        }
        throw error;
      }
    },
  validatePropertyArea(area: PropertyArea): void {
      if (!PROPERTY_AREA_KINDS.has(area.kind)) {
        throw new ClimateDataValidationError(422, "INVALID_AREA_KIND", "Property area kind is not supported");
      }
      if (area.location && (!Number.isFinite(area.location.latitude) || !Number.isFinite(area.location.longitude)
        || area.location.latitude < -90 || area.location.latitude > 90
        || area.location.longitude < -180 || area.location.longitude > 180)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_ASSET_LOCATION",
          "Fixed asset location must be a finite WGS84 latitude/longitude coordinate",
        );
      }
      const polygon = area.polygon;
      if (!Array.isArray(polygon) || (polygon.length !== 0 && polygon.length < 3) || polygon.length > MAX_PROPERTY_AREA_VERTICES) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_AREA_POLYGON",
          `Area polygon must be empty for a fixed asset or contain between 3 and ${MAX_PROPERTY_AREA_VERTICES} vertices`,
        );
      }
      const keys = new Set<string>();
      for (const point of polygon) {
        if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
          || point.latitude < -90 || point.latitude > 90 || point.longitude < -180 || point.longitude > 180) {
          throw new ClimateDataValidationError(
            422,
            "INVALID_AREA_POLYGON",
            "Every area vertex must be a finite WGS84 latitude/longitude coordinate",
          );
        }
        const key = `${point.latitude},${point.longitude}`;
        if (keys.has(key)) {
          throw new ClimateDataValidationError(
            422,
            "INVALID_AREA_POLYGON",
            "Area polygon vertices must be distinct and the first vertex must not be repeated",
          );
        }
        keys.add(key);
      }
      if (polygon.length === 0) return;
      // Perform topology checks in a local metre-scale projection. Using raw
      // longitude/latitude with a global 360-degree tolerance rejects ordinary
      // garden/well polygons whose sides are only a few metres long. Unwrapping
      // longitudes also keeps valid parcels that cross the antimeridian local.
      const referenceLatitudeRadians = polygon.reduce((sum, point) => sum + point.latitude, 0)
        / polygon.length * Math.PI / 180;
      const longitudeScale = 111_320 * Math.max(Math.abs(Math.cos(referenceLatitudeRadians)), 1e-6);
      const latitudeScale = 110_574;
      const unwrappedLongitudes: number[] = [polygon[0]!.longitude];
      for (let index = 1; index < polygon.length; index += 1) {
        let longitude = polygon[index]!.longitude;
        const previous = unwrappedLongitudes[index - 1]!;
        while (longitude - previous > 180) longitude -= 360;
        while (longitude - previous < -180) longitude += 360;
        unwrappedLongitudes.push(longitude);
      }
      const originLongitude = unwrappedLongitudes[0]!;
      const originLatitude = polygon[0]!.latitude;
      const points = polygon.map((point, index) => ({
        x: (unwrappedLongitudes[index]! - originLongitude) * longitudeScale,
        y: (point.latitude - originLatitude) * latitudeScale,
      }));
      const coordinateScale = Math.max(
        ...points.map((point) => Math.abs(point.x)),
        ...points.map((point) => Math.abs(point.y)),
        1,
      );
      const signedArea = points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length]!;
        return sum + point.x * next.y - next.x * point.y;
      }, 0) / 2;
      const areaTolerance = Math.max(1, coordinateScale * coordinateScale) * 1e-10;
      if (Math.abs(signedArea) <= areaTolerance || roomPolygonSelfIntersects(points, coordinateScale)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_AREA_POLYGON",
          "Area polygon must enclose a non-zero, non-self-intersecting region",
        );
      }
    },
});
