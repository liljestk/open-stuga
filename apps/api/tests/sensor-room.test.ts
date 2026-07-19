import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ClimateDatabase, ClimateDataValidationError } from "../src/db.js";
import { buildHouseTopology } from "../src/spatial-layers/core-input.js";

const databases: ClimateDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seededDatabase(): ClimateDatabase {
  const database = new ClimateDatabase(":memory:", true);
  databases.push(database);
  return database;
}

function sensorInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "room-test-sensor",
    houseId: "house-main",
    floorId: "floor-ground",
    name: "Room test sensor",
    room: "Kitchen",
    model: "Test",
    x: 10,
    y: 2,
    z: 1.4,
    tags: [],
    enabled: true,
    ...overrides,
  };
}

describe("stable sensor room relationships", () => {
  it("links exact legacy labels and leaves arbitrary labels explicitly unlinked", () => {
    const database = seededDatabase();
    expect(database.getSensor("sensor-01")).toMatchObject({ roomId: "living", room: "Living room" });

    const linked = database.createSensor(sensorInput());
    expect(linked).toMatchObject({ roomId: "kitchen", room: "Kitchen" });

    const unlinked = database.createSensor(sensorInput({ id: "custom-label", room: "Boiler corner" }));
    expect(unlinked).toMatchObject({ roomId: null, room: "Boiler corner" });
  });

  it("validates explicit ids and keeps the id and display label consistent", () => {
    const database = seededDatabase();
    expect(() => database.createSensor(sensorInput({ roomId: "living" }))).toThrowError(
      expect.objectContaining({ code: "SENSOR_ROOM_LABEL_MISMATCH" }),
    );
    expect(() => database.createSensor(sensorInput({ roomId: "bedroom" }))).toThrowError(
      expect.objectContaining({ code: "SENSOR_ROOM_NOT_FOUND" }),
    );

    const created = database.createSensor(sensorInput({ roomId: "kitchen" }));
    expect(created.roomId).toBe("kitchen");
    expect(database.updateSensor(created.id, { roomId: "utility" })).toMatchObject({
      roomId: "utility",
      room: "Utility",
    });
    expect(database.updateSensor(created.id, { roomId: null })).toMatchObject({ roomId: null, room: "Utility" });
    expect(database.updateSensor(created.id, { name: "Still unlinked" })).toMatchObject({ roomId: null });
  });

  it("synchronizes linked labels on rename and rejects room removal atomically", () => {
    const database = seededDatabase();
    const house = database.getHouse("house-main")!;
    const renamedFloors = structuredClone(house.floors);
    renamedFloors[0]!.rooms.find((room) => room.id === "living")!.name = "Family room";

    database.updateHouse(house.id, { floors: renamedFloors });
    expect(database.getSensor("sensor-01")).toMatchObject({ roomId: "living", room: "Family room" });

    const withoutLinkedRoom = structuredClone(renamedFloors);
    withoutLinkedRoom[0]!.rooms = withoutLinkedRoom[0]!.rooms.filter((room) => room.id !== "living");
    try {
      database.updateHouse(house.id, { floors: withoutLinkedRoom });
      expect.fail("linked room removal should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ClimateDataValidationError);
      expect((error as ClimateDataValidationError).code).toBe("LAYOUT_ORPHANS_SENSOR_ROOM");
    }
    expect(database.getHouse(house.id)!.floors[0]!.rooms).toContainEqual(
      expect.objectContaining({ id: "living", name: "Family room" }),
    );
  });

  it("uses the stable room id as the spatial authority", () => {
    const database = seededDatabase();
    const house = database.getHouse("house-main")!;
    const sensor = { ...database.getSensor("sensor-01")!, room: "Kitchen" };
    const built = buildHouseTopology({
      house,
      sensors: [sensor],
      bindings: [],
      at: "2026-07-17T00:00:00.000Z",
    });
    expect(built.topology.sensorBindings).toContainEqual(expect.objectContaining({
      sensorId: sensor.id,
      zoneId: "house:house-main:floor:floor-ground:room:living",
    }));

    const explicitlyUnlinked = buildHouseTopology({
      house,
      sensors: [{ ...sensor, roomId: null, room: "Kitchen" }],
      bindings: [],
      at: "2026-07-17T00:00:00.000Z",
    });
    expect(explicitlyUnlinked.topology.sensorBindings).toEqual([]);
    expect(explicitlyUnlinked.warnings).toContain(`SENSOR_${sensor.id}_ROOM_UNRESOLVED`);

    const { roomId: _legacyMissingRoomId, ...legacySensor } = sensor;
    const legacyFallback = buildHouseTopology({
      house,
      sensors: [legacySensor],
      bindings: [],
      at: "2026-07-17T00:00:00.000Z",
    });
    expect(legacyFallback.topology.sensorBindings).toContainEqual(expect.objectContaining({
      sensorId: sensor.id,
      zoneId: "house:house-main:floor:floor-ground:room:kitchen",
    }));
  });

  it("backfills only one exact legacy match and never recreates an explicitly cleared link", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-sensor-room-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    const floors = JSON.stringify([{
      id: "floor",
      name: "Floor",
      width: 10,
      height: 10,
      elevation: 0,
      walls: [],
      rooms: [
        { id: "exact", name: "Exact", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] },
        { id: "same-a", name: "Same", points: [{ x: 4, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 4 }] },
        { id: "same-b", name: "Same", points: [{ x: 7, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }] },
      ],
    }]);
    legacy.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE houses (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL, floors_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE sensors (id TEXT PRIMARY KEY, house_id TEXT NOT NULL REFERENCES houses(id), floor_id TEXT NOT NULL, name TEXT NOT NULL, room TEXT NOT NULL, model TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, temperature_entity_id TEXT, humidity_entity_id TEXT, battery_entity_id TEXT, tags_json TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE readings (id INTEGER PRIMARY KEY AUTOINCREMENT, sensor_id TEXT NOT NULL REFERENCES sensors(id), timestamp TEXT NOT NULL, temperature REAL NOT NULL, humidity REAL NOT NULL, battery REAL, source TEXT NOT NULL, quality TEXT NOT NULL);
    `);
    legacy.prepare("INSERT INTO houses VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-house", "Legacy", "UTC", floors, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    const insertSensor = legacy.prepare("INSERT INTO sensors VALUES (?, 'legacy-house', 'floor', ?, ?, 'Legacy', 1, 1, 1, NULL, NULL, NULL, '[]', 1)");
    insertSensor.run("exact-sensor", "Exact sensor", "Exact");
    insertSensor.run("ambiguous-sensor", "Ambiguous sensor", "Same");
    legacy.close();

    const migrated = new ClimateDatabase(path, false);
    expect(migrated.getSensor("exact-sensor")).toMatchObject({ roomId: "exact", room: "Exact" });
    expect(migrated.getSensor("ambiguous-sensor")).toMatchObject({ roomId: null, room: "Same" });
    expect(migrated.updateSensor("exact-sensor", { roomId: null })).toMatchObject({ roomId: null });
    migrated.close();

    const reopened = new ClimateDatabase(path, false);
    databases.push(reopened);
    expect(reopened.getSensor("exact-sensor")).toMatchObject({ roomId: null, room: "Exact" });
    expect((reopened.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_room_ids_v1'").get() as { value: string }).value)
      .toBe("complete");
  });
});
