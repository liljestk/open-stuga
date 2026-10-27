import type {
  AreaEquipment,
  House,
  OpeningStateObservation,
  Property,
  PropertyArea,
  PropertyNote,
  StugubyHouseLink,
} from "@climate-twin/contracts";
import { DEFAULT_PROPERTY_ID, EQUIPMENT_STATUSES, HouseRow, MAX_COLLECTION_LIMIT, MAX_PROPERTY_AREA_VERTICES, OpeningStateObservationRow, PROPERTY_AREA_KINDS, PROPERTY_NOTE_KINDS, PropertyMigrationResult } from "../support/01-json-value-to-area-equipment-row.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { houseFromRow, openingStateObservationFromRow, roomPolygonSelfIntersects } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
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
  equipmentLinkUrl(value: string): string {
      const normalized = this.propertyRequiredText(value, "Equipment link URL", 2_048);
      try {
        const parsed = new URL(normalized);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        return parsed.href;
      } catch {
        throw new ClimateDataValidationError(
          422,
          "INVALID_EQUIPMENT_LINK",
          "Equipment link URL must be an HTTP or HTTPS address without embedded credentials",
        );
      }
    },
  nextUpdatedAt(previous: string): string {
      const previousMs = Date.parse(previous);
      const timestamp = Number.isFinite(previousMs) ? Math.max(Date.now(), previousMs + 1) : Date.now();
      return new Date(timestamp).toISOString();
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
  validateAreaEquipment(equipment: AreaEquipment, retainedHiddenHouseId: string | null = null): void {
      if (!this.getProperty(equipment.propertyId)) {
        throw new ClimateDataValidationError(
          404,
          "EQUIPMENT_PROPERTY_NOT_FOUND",
          `Property ${equipment.propertyId} does not exist`,
        );
      }
      const houseId = equipment.houseId ?? null;
      if (equipment.areaId !== null && houseId !== null) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_EQUIPMENT_LOCATION",
          "Equipment may have one expected Area or Home, not both",
        );
      }
      if (equipment.areaId !== null) {
        const area = this.getPropertyArea(equipment.areaId);
        if (!area) {
          throw new ClimateDataValidationError(
            404,
            "EQUIPMENT_AREA_NOT_FOUND",
            `Area ${equipment.areaId} does not exist`,
          );
        }
        if (area.propertyId !== equipment.propertyId) {
          throw new ClimateDataValidationError(
            409,
            "EQUIPMENT_AREA_SCOPE_MISMATCH",
            `Area ${area.id} does not belong to property ${equipment.propertyId}`,
          );
        }
      }
      if (houseId !== null) {
        const house = this.getHouse(houseId);
        const retainingHiddenHouse = !house && houseId === retainedHiddenHouseId;
        if (!house && !retainingHiddenHouse) {
          throw new ClimateDataValidationError(
            404,
            "EQUIPMENT_HOUSE_NOT_FOUND",
            `House ${houseId} does not exist`,
          );
        }
        if (house && house.propertyId !== equipment.propertyId) {
          throw new ClimateDataValidationError(
            409,
            "EQUIPMENT_HOUSE_SCOPE_MISMATCH",
            `House ${house.id} does not belong to property ${equipment.propertyId}`,
          );
        }
      }
      if (equipment.location && (
        !Number.isFinite(equipment.location.latitude)
        || equipment.location.latitude < -90
        || equipment.location.latitude > 90
        || !Number.isFinite(equipment.location.longitude)
        || equipment.location.longitude < -180
        || equipment.location.longitude > 180
      )) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_EQUIPMENT_LOCATION",
          "Equipment location must be a finite WGS84 latitude/longitude coordinate",
        );
      }
      if (!EQUIPMENT_STATUSES.has(equipment.status)) {
        throw new ClimateDataValidationError(422, "INVALID_EQUIPMENT_STATUS", "Equipment status is not supported");
      }
    },
  validatePropertyNote(note: PropertyNote, retainedHiddenHouseId: string | null = null): void {
      if (!this.getProperty(note.propertyId)) {
        throw new ClimateDataValidationError(404, "NOTE_PROPERTY_NOT_FOUND", `Property ${note.propertyId} does not exist`);
      }
      if (!PROPERTY_NOTE_KINDS.has(note.kind)) {
        throw new ClimateDataValidationError(422, "INVALID_PROPERTY_NOTE_KIND", "Property note kind is not supported");
      }
      if ([note.houseId, note.areaId, note.equipmentId].filter((id) => id !== null).length > 1) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_PROPERTY_NOTE_TARGET",
          "A property note may target at most one house, area, or equipment item",
        );
      }
      if (note.houseId !== null) {
        const house = this.getHouse(note.houseId);
        const retainingHiddenHouse = !house && note.houseId === retainedHiddenHouseId;
        if (!house && !retainingHiddenHouse) {
          throw new ClimateDataValidationError(404, "NOTE_HOUSE_NOT_FOUND", `House ${note.houseId} does not exist`);
        }
        if (house && house.propertyId !== note.propertyId) {
          throw new ClimateDataValidationError(409, "PROPERTY_NOTE_SCOPE_MISMATCH", "Note house belongs to another property");
        }
      }
      let area: PropertyArea | null = null;
      if (note.areaId !== null) {
        area = this.getPropertyArea(note.areaId);
        if (!area) throw new ClimateDataValidationError(404, "NOTE_AREA_NOT_FOUND", `Area ${note.areaId} does not exist`);
        if (area.propertyId !== note.propertyId) {
          throw new ClimateDataValidationError(409, "PROPERTY_NOTE_SCOPE_MISMATCH", "Note area belongs to another property");
        }
      }
      if (note.equipmentId !== null) {
        const equipment = this.getAreaEquipment(note.equipmentId);
        if (!equipment) {
          throw new ClimateDataValidationError(404, "NOTE_EQUIPMENT_NOT_FOUND", `Equipment ${note.equipmentId} does not exist`);
        }
        if (equipment.propertyId !== note.propertyId || (area && equipment.areaId !== area.id)) {
          throw new ClimateDataValidationError(
            409,
            "PROPERTY_NOTE_SCOPE_MISMATCH",
            "Note equipment belongs to another property or area",
          );
        }
      }
    },
  ensureDefaultProperty(): Property {
      return this.getProperty(DEFAULT_PROPERTY_ID) ?? this.createProperty({ id: DEFAULT_PROPERTY_ID, name: "My property" });
    },
  listHouses(propertyId?: string): House[] {
      const rows = (propertyId
        ? this.db.prepare("SELECT * FROM houses WHERE property_id = ? AND deleted_at IS NULL ORDER BY name").all(propertyId)
        : this.db.prepare("SELECT * FROM houses WHERE deleted_at IS NULL ORDER BY name").all()) as unknown as HouseRow[];
      return rows.map(houseFromRow);
    },
  getHouse(id: string): House | null {
      const row = this.db.prepare("SELECT * FROM houses WHERE id = ? AND deleted_at IS NULL")
        .get(id) as unknown as HouseRow | undefined;
      return row ? houseFromRow(row) : null;
    },
  setHouseStugubyLink(id: string, link: StugubyHouseLink | null): House | null {
      return this.immediateTransaction(() => {
        const result = this.db.prepare("UPDATE houses SET stugby_json = ? WHERE id = ?")
          .run(link ? JSON.stringify(link) : null, id);
        if (Number(result.changes) !== 1) return null;
        if (link?.ownership === "shared" && link.syncState !== "detached") {
          this.purgeSharedHomeLocalState(id);
        }
        return this.getHouse(id);
      });
    },
  clearStugubyLinks(stugubyId: string): { properties: number; houses: number } {
      return this.immediateTransaction(() => ({
        properties: Number(this.db.prepare(`UPDATE properties SET stugby_json=NULL
          WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugubyId')=?`).run(stugubyId).changes),
        houses: Number(this.db.prepare(`UPDATE houses SET stugby_json=NULL
          WHERE stugby_json IS NOT NULL AND json_extract(stugby_json,'$.stugubyId')=?`).run(stugubyId).changes),
      }));
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
  listOpeningStateObservations(houseId: string, limit = 5_000, at?: string | number | Date): OpeningStateObservation[] {
      if (!this.getHouse(houseId)) return [];
      const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
      if (at === undefined) {
        const rows = this.db.prepare(`SELECT id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id
          FROM opening_state_observations WHERE house_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?`)
          .all(houseId, boundedLimit) as unknown as OpeningStateObservationRow[];
        return rows.map(openingStateObservationFromRow);
      }
      const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
      if (!Number.isFinite(atMs)) return [];
      const atIso = new Date(atMs).toISOString();
      const house = this.getHouse(houseId)!;
      const columns = "id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id";
      const latestBySource = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
        WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ?
          AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY observed_at DESC, id DESC LIMIT 1`);
      const latestProvider = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
        WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ? AND external_id = ?
          AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY observed_at DESC, id DESC LIMIT 1`);
      const latestProviderConnection = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
        WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ? AND external_id = ? AND connection_id = ?
          AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY observed_at DESC, id DESC LIMIT 1`);
      const rows: OpeningStateObservationRow[] = [];
      // Each lookup is bounded and uses the house/element/provider indexes. This
      // remains fast after years of adapter heartbeats while retaining an old,
      // still-valid manual state for replay and fallback resolution.
      for (const floor of house.floors) {
        for (const element of floor.planElements ?? []) {
          if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") continue;
          for (const source of ["manual", "api"] as const) {
            const row = latestBySource.get(houseId, floor.id, element.id, source, atIso, atIso) as unknown as OpeningStateObservationRow | undefined;
            if (row) rows.push(row);
          }
          const binding = element.stateBinding;
          if (!binding) continue;
          const row = binding.connectionId
            ? latestProviderConnection.get(houseId, floor.id, element.id, binding.provider, binding.externalId,
                binding.connectionId, atIso, atIso) as unknown as OpeningStateObservationRow | undefined
            : latestProvider.get(houseId, floor.id, element.id, binding.provider, binding.externalId,
                atIso, atIso) as unknown as OpeningStateObservationRow | undefined;
          if (row) rows.push(row);
        }
      }
      return rows.sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.id.localeCompare(left.id))
        .slice(0, boundedLimit).map(openingStateObservationFromRow);
    },
  listCurrentOpeningStateCandidates(
      houseId: string,
      at: string | number | Date = new Date(),
      limit = 10_000,
    ): OpeningStateObservation[] {
      if (!this.getHouse(houseId)) return [];
      const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
      if (!Number.isFinite(atMs)) return [];
      const atIso = new Date(atMs).toISOString();
      const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
      const rows = this.db.prepare(`SELECT observation.id, observation.house_id, observation.floor_id,
          observation.element_id, observation.state, observation.open_fraction, observation.source,
          observation.observed_at, observation.valid_until, observation.external_id, observation.connection_id
        FROM opening_state_current_candidates AS candidate
        JOIN opening_state_observations AS observation ON observation.id = candidate.observation_id
        WHERE candidate.house_id = ?
          AND candidate.observed_at <= ?
          AND (candidate.effective_until_ceiling IS NULL OR candidate.effective_until_ceiling > ?)
        ORDER BY candidate.observed_at DESC, candidate.observation_id DESC
        LIMIT ?`)
        .all(houseId, atIso, atIso, boundedLimit) as unknown as OpeningStateObservationRow[];
      return rows.map(openingStateObservationFromRow);
    },
});
