import { type House, type StugubyHouseLink, automaticWeatherLocation, fixedPlanElementOpeningState, isAutomaticWeatherLocation, openingObservationMatchesElement, type HouseLocation, type HouseMapPlacement } from "@climate-twin/contracts";
import { DEFAULT_PROPERTY_ID } from "../support/domain-limits.js";
import { HouseRow, OpeningStateObservationRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { houseFromRow, openingStateObservationFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import { LocalMaintenanceTaskRevisionActor } from "../support/record-types.js";
import { outdoorLocationKey } from "../support/outdoor-location.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listHouses(propertyId?: string): House[];
    getHouse(id: string): House | null;
    setHouseStugubyLink(id: string, link: StugubyHouseLink | null): House | null;
    clearStugubyLinks(stugubyId: string): {
            properties: number;
            houses: number;
        };
    createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
            id?: string;
            propertyId?: string;
            location?: HouseLocation;
            mapPlacement?: HouseMapPlacement;
            orientationDegrees?: number;
        }): House;
    updateHouse(id: string, patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
            propertyId?: string;
            location?: HouseLocation | null;
            mapPlacement?: HouseMapPlacement | null;
            orientationDegrees?: number | null;
        }, actor?: LocalMaintenanceTaskRevisionActor): House | null;
    purgeSharedHouseProjection(id: string): boolean;
    deleteHouse(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    listHouses(propertyId?: string): House[];
    getHouse(id: string): House | null;
    setHouseStugubyLink(id: string, link: StugubyHouseLink | null): House | null;
    clearStugubyLinks(stugubyId: string): {
            properties: number;
            houses: number;
        };
    createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
            id?: string;
            propertyId?: string;
            location?: HouseLocation;
            mapPlacement?: HouseMapPlacement;
            orientationDegrees?: number;
        }): House;
    updateHouse(id: string, patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
            propertyId?: string;
            location?: HouseLocation | null;
            mapPlacement?: HouseMapPlacement | null;
            orientationDegrees?: number | null;
        }, actor?: LocalMaintenanceTaskRevisionActor): House | null;
    purgeSharedHouseProjection(id: string): boolean;
    deleteHouse(id: string): boolean;
  }
}

registerDatabaseMethods({
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
  createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
      id?: string;
      propertyId?: string;
      location?: HouseLocation;
      mapPlacement?: HouseMapPlacement;
      orientationDegrees?: number;
    }): House {
      return this.immediateTransaction(() => {
        this.parseFloorDefinitions(input.floors);
        this.validateHouseTimezone(input.timezone);
        if (input.location) this.validateHouseLocation(input.location);
        if (input.mapPlacement) this.validateHouseMapPlacement(input.mapPlacement, input.floors);
        if (input.orientationDegrees !== undefined) this.validateHouseOrientation(input.orientationDegrees);
        const timestamp = new Date().toISOString();
        let propertyId: string;
        if (input.propertyId !== undefined) {
          propertyId = input.propertyId.trim();
          if (!propertyId) {
            throw new ClimateDataValidationError(
              422,
              "HOUSE_PROPERTY_REQUIRED",
              "A non-empty propertyId is required when it is supplied",
            );
          }
        } else {
          const candidates = this.db.prepare("SELECT id FROM properties ORDER BY created_at, id LIMIT 2")
            .all() as Array<{ id: string }>;
          if (candidates.length === 0) propertyId = this.ensureDefaultProperty().id;
          else if (candidates.length === 1) propertyId = candidates[0]!.id;
          else {
            throw new ClimateDataValidationError(
              422,
              "HOUSE_PROPERTY_REQUIRED",
              "propertyId is required when more than one property exists",
            );
          }
        }
        const property = this.getProperty(propertyId);
        if (!property) {
          throw new ClimateDataValidationError(404, "HOUSE_PROPERTY_NOT_FOUND", `Property ${propertyId} does not exist`);
        }
        const location = input.location ?? automaticWeatherLocation(property.location, input.mapPlacement);
        const house: House = {
          id: input.id ?? randomUUID(), propertyId, name: input.name, timezone: input.timezone,
          ...(location ? { location } : {}),
          ...(input.mapPlacement ? { mapPlacement: input.mapPlacement } : {}),
          ...(input.orientationDegrees !== undefined ? { orientationDegrees: input.orientationDegrees } : {}),
          floors: input.floors,
          createdAt: timestamp, updatedAt: timestamp,
        };
        this.assertTelemetryResourceIdAvailable("house", house.id);
        try {
          this.db.prepare(`INSERT INTO houses
            (id, property_id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(house.id, propertyId, house.name, house.timezone, house.location ? JSON.stringify(house.location) : null,
              house.mapPlacement ? JSON.stringify(house.mapPlacement) : null,
              house.orientationDegrees ?? null,
              JSON.stringify(house.floors), house.createdAt, house.updatedAt);
        } catch (error) {
          if (isSqliteFailure(error, "unique", "houses.id")) {
            throw new ClimateDataValidationError(409, "HOUSE_ID_CONFLICT", `House ${house.id} already exists`);
          }
          throw error;
        }
        return house;
      });
    },
  updateHouse(
      id: string,
      patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
        propertyId?: string;
        location?: HouseLocation | null;
        mapPlacement?: HouseMapPlacement | null;
        orientationDegrees?: number | null;
      },
      actor: LocalMaintenanceTaskRevisionActor = "local-rest",
    ): House | null {
      return this.immediateTransaction(() => {
        const current = this.getHouse(id);
        if (!current) return null;
        const affectedTasks = patch.propertyId !== undefined && patch.propertyId !== current.propertyId
          ? this.maintenanceTasksBeforeScopeMove("house_id = ?", [id])
          : [];
        // Apply nullable optional fields explicitly so `null` never leaks into
        // the public House contract (absence is represented by omission).
        const next: House = { ...current, id, updatedAt: this.nextUpdatedAt(current.updatedAt) };
        if (patch.propertyId !== undefined) {
          const propertyId = patch.propertyId.trim();
          if (!propertyId || !this.getProperty(propertyId)) {
            throw new ClimateDataValidationError(
              404,
              "HOUSE_PROPERTY_NOT_FOUND",
              `Property ${patch.propertyId} does not exist`,
            );
          }
          if (propertyId !== current.propertyId) this.requireImmutableTelemetryLineage("house", id);
          next.propertyId = propertyId;
        }
        if (patch.name !== undefined) next.name = patch.name;
        if (patch.timezone !== undefined) {
          // A legacy database may contain a timezone accepted by an older build.
          // Preserve that value when an unrelated full-form update echoes it, but
          // validate every newly introduced timezone.
          if (patch.timezone !== current.timezone) this.validateHouseTimezone(patch.timezone);
          next.timezone = patch.timezone;
        }
        if (patch.floors !== undefined) next.floors = patch.floors;
        if (patch.orientationDegrees === null) delete next.orientationDegrees;
        else if (patch.orientationDegrees !== undefined) next.orientationDegrees = patch.orientationDegrees;
        if (patch.location === null) delete next.location;
        else if (patch.location !== undefined) next.location = patch.location;
        if (patch.mapPlacement === null) delete next.mapPlacement;
        else if (patch.mapPlacement !== undefined) next.mapPlacement = patch.mapPlacement;
        if (patch.location === null
          || (patch.location === undefined && (!next.location || isAutomaticWeatherLocation(current.location)))) {
          const inferred = automaticWeatherLocation(this.getProperty(next.propertyId)?.location, next.mapPlacement);
          if (inferred) next.location = inferred;
          else delete next.location;
        }
        this.parseFloorDefinitions(next.floors);
        if (next.mapPlacement) this.validateHouseMapPlacement(next.mapPlacement, next.floors);
        if (next.location) this.validateHouseLocation(next.location);
        if (next.orientationDegrees !== undefined) this.validateHouseOrientation(next.orientationDegrees);
        this.validateHouseLayoutForSensors(id, next.floors);
        if (patch.floors !== undefined) {
          this.validateHouseLayoutForObservations(id, next.floors);
          this.validateHouseLayoutForConnectedDevices(id, next.floors);
          this.validateHouseLayoutForMaintenanceTasks(id, next.floors);
        }
        this.db.prepare("UPDATE houses SET property_id = ?, name = ?, timezone = ?, location_json = ?, map_placement_json = ?, orientation_degrees = ?, floors_json = ?, updated_at = ? WHERE id = ?")
          .run(next.propertyId ?? DEFAULT_PROPERTY_ID, next.name, next.timezone, next.location ? JSON.stringify(next.location) : null,
            next.mapPlacement ? JSON.stringify(next.mapPlacement) : null,
            next.orientationDegrees ?? null,
            JSON.stringify(next.floors), next.updatedAt, id);
        if (patch.floors !== undefined) {
          const openings = new Map(next.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => (
            element.kind === "door" || element.kind === "window" || element.kind === "vent"
              ? [[`${floor.id}\u0000${element.id}`, element] as const]
              : []
          ))));
          const candidates = this.db.prepare(`SELECT observation.id, observation.house_id, observation.floor_id,
              observation.element_id, observation.state, observation.open_fraction, observation.source,
              observation.observed_at, observation.valid_until, observation.external_id, observation.connection_id
            FROM opening_state_current_candidates candidate
            JOIN opening_state_observations observation ON observation.id = candidate.observation_id
            WHERE candidate.house_id = ?`).all(id) as unknown as OpeningStateObservationRow[];
          const removeCandidate = this.db.prepare(
            "DELETE FROM opening_state_current_candidates WHERE observation_id = ?",
          );
          for (const row of candidates) {
            const observation = openingStateObservationFromRow(row);
            const opening = openings.get(`${observation.floorId}\u0000${observation.elementId}`);
            if (!opening || fixedPlanElementOpeningState(opening) !== null
              || !openingObservationMatchesElement(opening, observation)) removeCandidate.run(observation.id);
          }
        }
        this.recordScopeMoveMaintenanceRevisions(affectedTasks, actor);
        const weatherLocationChanged = outdoorLocationKey(current.location) !== outdoorLocationKey(next.location);
        if (patch.floors !== undefined || weatherLocationChanged || patch.timezone !== undefined) {
          this.db.prepare("DELETE FROM analytics_daily_findings WHERE house_id = ?").run(id);
        }
        return next;
      });
    },
  /**
   * Revoked federation replicas must be erasable even if a local-only producer
   * was accidentally attached before the authority boundary was enforced.
   */
  purgeSharedHouseProjection(id: string): boolean {
      return this.immediateTransaction(() => {
        const house = this.getHouse(id);
        if (!house) return false;
        if (house.stuguby?.ownership !== "shared" || house.stuguby.syncState === "detached") {
          throw new ClimateDataValidationError(
            409,
            "HOUSE_NOT_SHARED_PROJECTION",
            `House ${id} is not an active shared federation projection`,
          );
        }
        while (true) {
          const items = this.listAreaEquipment({ houseId: id, limit: 10_000 });
          if (items.length === 0) break;
          for (const item of items) {
            if (!this.updateAreaEquipment(item.id, { houseId: null }, "system-service")) {
              throw new Error(`Could not detach equipment ${item.id} from shared Home ${id}`);
            }
          }
        }
        while (true) {
          const notes = this.listPropertyNotes({ houseId: id, limit: 10_000 });
          if (notes.length === 0) break;
          for (const note of notes) {
            if (!this.deletePropertyNote(note.id)) {
              throw new Error(`Could not delete note ${note.id} from shared Home ${id}`);
            }
          }
        }
        while (true) {
          const tasks = this.listMaintenanceTasks({ houseId: id, limit: 10_000 });
          if (tasks.length === 0) break;
          for (const task of tasks) {
            if (!this.updateMaintenanceTask(task.id, {
              baseRevision: task.revision,
              houseId: null,
              floorId: null,
              observationIds: task.observationIds.filter((observationId) => (
                this.getObservation(observationId)?.houseId !== id
              )),
            }, "system-service")) {
              throw new Error(`Could not detach maintenance task ${task.id} from shared Home ${id}`);
            }
          }
        }
        return Number(this.db.prepare("DELETE FROM houses WHERE id = ?").run(id).changes) > 0;
      });
    },
  deleteHouse(id: string): boolean {
      const deletedAt = new Date().toISOString();
      return this.immediateTransaction(() => {
        const hidden = Number(this.db.prepare(`UPDATE houses
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`).run(deletedAt, deletedAt, id).changes) > 0;
        if (!hidden) return false;
        this.db.prepare(`UPDATE external_source_gateways
          SET enabled = 0, revision = revision + 1, updated_at = ?
          WHERE house_id = ? AND enabled = 1`).run(deletedAt, id);
        return true;
      });
    },
});
