import type { House } from "@climate-twin/contracts";
import { HttpError, bodyObject, requiredString } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** House layout, floor plans and RoomPlan imports. */
export function registerHouseLayoutRoutes(context: ApiRouteRegistrationContext): void {
  context.app.put(`${context.prefix}/houses/:id/layout`, (request, response) => {
      const houseId = request.params.id as string;
      context.stuguby.assertHouseWriteAllowed(houseId);
      const body = bodyObject(request.body);
      if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
      const floors = context.database.parseFloorDefinitions(body.floors);
      context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, floors);
      const house = context.database.transaction(() => {
        const updated = context.database.updateHouse(houseId, { floors });
        if (!updated) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(updated.id);
        return updated;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        house.id,
        house.propertyId,
        new Date().toISOString(),
        "property-context-changed",
      ));
      response.json({ house });
    });
  context.app.put(`${context.prefix}/houses/:id/floors/:floorId`, (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseWriteAllowed(house.id);
      const body = bodyObject(request.body);
      if (body.id !== request.params.floorId) throw new HttpError(400, "INVALID_FIELD", "Floor id must match the route");
      const index = house.floors.findIndex((candidate) => candidate.id === body.id);
      if (index < 0) throw new HttpError(404, "NOT_FOUND", "Floor not found");
      const floors = context.database.parseFloorDefinitions(replacedFloor(house, index, body));
      const floor = floors[index]!;
      context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(house.id, floors);
      const updated = context.database.transaction(() => {
        const saved = context.database.updateHouse(house.id, { floors });
        if (!saved) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(saved.id);
        return saved;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        updated.id,
        updated.propertyId,
        new Date().toISOString(),
        "property-context-changed",
      ));
      response.json(floor);
    });
  context.app.post(`${context.prefix}/houses/:id/floors/:floorId/roomplan-import`, (request, response) => {
      const houseId = request.params.id as string;
      const floorId = request.params.floorId as string;
      const house = context.database.getHouse(houseId);
      if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseWriteAllowed(house.id);
      const floor = parseRoomPlanImport(bodyObject(request.body), house, floorId);
      const index = house.floors.findIndex((candidate) => candidate.id === floorId);
      if (index < 0) throw new HttpError(404, "NOT_FOUND", "Floor not found");
      const floors = context.database.parseFloorDefinitions(replacedFloor(house, index, floor));
      context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(house.id, floors);
      const updated = context.database.transaction(() => {
        const saved = context.database.updateHouse(house.id, { floors });
        if (!saved) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(saved.id);
        return saved;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        updated.id,
        updated.propertyId,
        new Date().toISOString(),
        "property-context-changed",
      ));
      response.json({ house: updated, floor: updated.floors[index] });
    });
}

/** The Home's floors with the one at `index` replaced by an unvalidated candidate. */
function replacedFloor(house: House, index: number, candidate: Record<string, unknown>): unknown[] {
  return house.floors.map((floor, position) => (position === index ? candidate : floor));
}

/** Rejects any field not listed, so RoomPlan imports carry derived geometry only. */
function assertRoomPlanFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new HttpError(400, "ROOMPLAN_PAYLOAD_NOT_ACCEPTED", `${label} contains unsupported field ${unexpected}`);
  }
}

/**
 * Checks a RoomPlan import body for one floor of the house and returns the floor
 * object; its geometry is validated with the Home's other floors before saving.
 */
function parseRoomPlanImport(body: Record<string, unknown>, house: House, floorId: string): RoomPlanFloor {
  assertRoomPlanFields(
    body,
    ["source", "capturedAt", "expectedHouseUpdatedAt", "floor"],
    "RoomPlan import",
  );
  const expectedHouseUpdatedAt = requiredString(body, "expectedHouseUpdatedAt");
  if (house.updatedAt !== expectedHouseUpdatedAt) {
    throw new HttpError(
      409,
      "ROOMPLAN_STALE_HOME",
      "The Home changed after this scan started. Refresh and review the floor again",
    );
  }
  if (body.source !== "apple-roomplan") {
    throw new HttpError(400, "INVALID_FIELD", "source must be apple-roomplan");
  }
  const capturedAt = requiredString(body, "capturedAt");
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new HttpError(400, "INVALID_FIELD", "capturedAt must be an ISO timestamp");
  }
  const floor = bodyObject(body.floor);
  if (floor.id !== floorId) {
    throw new HttpError(400, "INVALID_FIELD", "Floor id must match the route");
  }
  if (floor.backgroundImage !== undefined) {
    throw new HttpError(
      400,
      "ROOMPLAN_IMAGE_NOT_ACCEPTED",
      "RoomPlan imports accept derived geometry only, not images",
    );
  }
  assertRoomPlanFields(
    floor,
    [
      "id", "name", "type", "width", "height", "metersPerPlanUnit",
      "elevation", "ceilingHeight", "wallHeight", "roof", "walls",
      "rooms", "planElements",
    ],
    "RoomPlan floor",
  );
  if (floor.metersPerPlanUnit !== 1) {
    throw new HttpError(
      400,
      "ROOMPLAN_SCALE_INVALID",
      "RoomPlan geometry must use metres as floor-plan units",
    );
  }
  const { rooms, walls, planElements } = floor;
  if (!Array.isArray(rooms) || rooms.length !== 1
    || !Array.isArray(walls) || walls.length < 2 || walls.length > 1_000
    || (Array.isArray(planElements) && planElements.length > 1_000)) {
    throw new HttpError(
      400,
      "ROOMPLAN_GEOMETRY_INVALID",
      "RoomPlan imports require one room, 2-1000 walls, and at most 1000 openings",
    );
  }
  const roomPlanFloor = { ...floor, rooms, walls };
  assertRoomPlanGeometryFields(roomPlanFloor);
  return roomPlanFloor;
}

/** A RoomPlan floor object whose room and wall lists are arrays; the rest is unvalidated. */
type RoomPlanFloor = Record<string, unknown> & { rooms: unknown[]; walls: unknown[] };

/** Walls, rooms, openings and roof may carry only their geometric fields. */
function assertRoomPlanGeometryFields(floor: RoomPlanFloor): void {
  for (const [wallIndex, wallValue] of floor.walls.entries()) {
    const wall = bodyObject(wallValue);
    assertRoomPlanFields(wall, ["id", "from", "to"], `RoomPlan wall ${wallIndex}`);
    assertRoomPlanFields(bodyObject(wall.from), ["x", "y"], `RoomPlan wall ${wallIndex} start`);
    assertRoomPlanFields(bodyObject(wall.to), ["x", "y"], `RoomPlan wall ${wallIndex} end`);
  }
  for (const [roomIndex, roomValue] of floor.rooms.entries()) {
    const room = bodyObject(roomValue);
    assertRoomPlanFields(room, ["id", "name", "kind", "points"], `RoomPlan room ${roomIndex}`);
    if (Array.isArray(room.points)) {
      for (const [pointIndex, pointValue] of room.points.entries()) {
        assertRoomPlanFields(
          bodyObject(pointValue),
          ["x", "y"],
          `RoomPlan room ${roomIndex} point ${pointIndex}`,
        );
      }
    }
  }
  if (Array.isArray(floor.planElements)) {
    for (const [elementIndex, elementValue] of floor.planElements.entries()) {
      const element = bodyObject(elementValue);
      assertRoomPlanFields(
        element,
        [
          "id", "kind", "position", "rotationDegrees", "width", "height",
          "label", "wallId", "variant", "state", "openFraction",
          "bottomOffsetM",
        ],
        `RoomPlan opening ${elementIndex}`,
      );
      assertRoomPlanFields(
        bodyObject(element.position),
        ["x", "y"],
        `RoomPlan opening ${elementIndex} position`,
      );
    }
  }
  if (floor.roof !== undefined) {
    assertRoomPlanFields(
      bodyObject(floor.roof),
      ["style", "pitchDegrees", "ridgeAxis", "overhang", "eavesHeight"],
      "RoomPlan floor roof",
    );
  }
}
