import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClimateDatabase, outdoorLocationKey } from "../src/db.js";
import { LocalAuthStore } from "../src/local-auth.js";
import { MockEngine } from "../src/services.js";

describe("SQLite control-plane durability", () => {
  it("rolls property creation back if its required default configuration cannot be stored", () => {
    const database = new ClimateDatabase(":memory:", false);
    try {
      database.db.exec(`CREATE TEMP TRIGGER reject_property_electricity_config
        BEFORE INSERT ON property_electricity_configs
        WHEN NEW.property_id = 'property-atomic'
        BEGIN SELECT RAISE(ABORT, 'forced default configuration failure'); END;`);

      expect(() => database.createProperty({ id: "property-atomic", name: "Atomic property" }))
        .toThrow(/forced default configuration failure/);
      expect(database.getProperty("property-atomic")).toBeNull();
      expect(database.getPropertyElectricityConfig("property-atomic")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("round-trips the complete property graph and durable operational state across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-control-plane-"));
    const path = join(directory, "control-plane.sqlite");
    let database: ClimateDatabase | null = new ClimateDatabase(path, false);
    let sessionToken = "";
    let alertEventId = "";
    let assetId = "";

    try {
      const auth = new LocalAuthStore(database);
      const owner = await auth.createFirstOwner("owner@stuga", "durable-control-plane-password");
      sessionToken = auth.issueSession(owner).token;
      const mock = new MockEngine(database, null as never, null as never, { prepareSources: () => undefined } as never);
      mock.setScenario("shower");

      const location = {
        latitude: 60.17,
        longitude: 24.93,
        label: "Persistent property",
        source: "manual" as const,
        userOverridden: true,
      };
      database.createProperty({
        id: "property-persisted",
        name: "Persistent estate",
        description: "Control-plane restart fixture",
        location,
      });
      auth.inviteMember(owner, "guest@stuga", "guest", [
        { scopeType: "property", scopeId: "property-persisted" },
      ]);
      database.createHouse({
        id: "house-persisted",
        propertyId: "property-persisted",
        name: "Persistent home",
        timezone: "Europe/Helsinki",
        location,
        orientationDegrees: 215,
        mapPlacement: {
          latitude: 60.1701,
          longitude: 24.9301,
          metersPerPlanUnit: 0.25,
          footprintFloorId: "floor-ground",
        },
        floors: [{
          id: "floor-ground",
          name: "Ground",
          width: 12,
          height: 9,
          elevation: 0,
          walls: [],
          rooms: [],
        }],
      });
      database.createPropertyArea({
        id: "area-persisted",
        propertyId: "property-persisted",
        name: "Well",
        kind: "well",
        description: "Drinking-water well",
        location: { latitude: 60.1702, longitude: 24.9302 },
        polygon: [],
      });
      database.createAreaEquipment({
        id: "equipment-persisted",
        propertyId: "property-persisted",
        areaId: "area-persisted",
        name: "Well pump",
        kind: "pump",
        manufacturer: "Example",
        model: "P-1",
        serialNumber: "SERIAL-1",
        status: "active",
        notes: "Winter inspection required",
      });
      database.createPropertyNote({
        id: "note-persisted",
        propertyId: "property-persisted",
        equipmentId: "equipment-persisted",
        kind: "inspection",
        text: "Pressure stable",
      });
      database.updatePropertyElectricityConfig("property-persisted", {
        provider: "custom",
        endpointUrl: "https://energy.example/prices.json",
        enabled: true,
        marginCentsPerKwh: 0.45,
        contractType: "spot",
        contractName: "Persistent spot contract",
        retailer: "Example Energy",
        monthlyFeeEur: 4.99,
      });
      database.createSensor({
        id: "sensor-persisted",
        houseId: "house-persisted",
        floorId: "floor-ground",
        name: "Utility sensor",
        room: "Utility",
        model: "T315",
        x: 2,
        y: 3,
        z: 1.2,
        tags: ["utility", "persistent"],
        enabled: true,
      });
      database.createObservation({
        id: "observation-persisted",
        houseId: "house-persisted",
        floorId: "floor-ground",
        sensorId: "sensor-persisted",
        kind: "inspection",
        severity: "info",
        note: "Restart persistence inspection",
        occurredAt: "2026-07-18T08:00:00.000Z",
        source: "owner",
        confidence: "confirmed",
      });
      database.createMaintenanceTask({
        id: "task-persisted",
        propertyId: "property-persisted",
        houseId: "house-persisted",
        floorId: "floor-ground",
        title: "Inspect utility sensor",
        basis: "scheduled",
        plannedFor: "2026-08-01",
        observationIds: ["observation-persisted"],
      });
      database.saveParameter({
        id: "parameter-persisted",
        houseId: "house-persisted",
        scopeType: "house",
        scopeId: "house-persisted",
        key: "yearBuilt",
        value: 1998,
        unit: null,
        label: "Year built",
      });
      assetId = database.createAsset({
        houseId: "house-persisted",
        name: "floor-plan.png",
        mimeType: "image/png",
        kind: "floor-plan",
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }).id;

      const rule = database.saveAlertRule({
        id: "rule-persisted",
        name: "Persistent temperature alert",
        sensorId: "sensor-persisted",
        metric: "temperature",
        operator: "gte",
        threshold: 30,
        durationSeconds: 0,
        severity: "warning",
        enabled: true,
        webhookEnabled: true,
        telegramEnabled: true,
      });
      const transition = database.applyAlertSample(rule, {
        sensorId: "sensor-persisted",
        metric: "temperature",
        value: 31,
        canonicalUnit: "°C",
        timestamp: "2026-07-18T08:05:00.000Z",
        source: "home-assistant",
        quality: "good",
      }, true);
      alertEventId = transition.created!.id;
      database.noteWeatherOutage(
        "house-persisted",
        outdoorLocationKey(location),
        "fmi",
        "service",
        "Temporary provider outage",
        "2026-07-18T08:10:00.000Z",
      );

      database.close();
      database = new ClimateDatabase(path, false);
      const reopenedAuth = new LocalAuthStore(database);
      const reopenedMock = new MockEngine(database, null as never, null as never, null as never);

      expect(reopenedAuth.sessionForToken(sessionToken)).toMatchObject({ email: "owner@stuga", role: "owner" });
      expect(reopenedAuth.listWorkspaceMembers().invitations).toEqual([
        expect.objectContaining({
          email: "guest@stuga",
          role: "guest",
          grants: [{ scopeType: "property", scopeId: "property-persisted" }],
        }),
      ]);
      expect(reopenedMock.scenario).toBe("shower");
      expect(database.getProperty("property-persisted")).toMatchObject({
        name: "Persistent estate",
        description: "Control-plane restart fixture",
        location,
      });
      expect(database.getHouse("house-persisted")).toMatchObject({
        propertyId: "property-persisted",
        orientationDegrees: 215,
        mapPlacement: { metersPerPlanUnit: 0.25, footprintFloorId: "floor-ground" },
        floors: [{ id: "floor-ground", width: 12, height: 9 }],
      });
      expect(database.getPropertyArea("area-persisted")).toMatchObject({ name: "Well", kind: "well" });
      expect(database.getAreaEquipment("equipment-persisted")).toMatchObject({
        areaId: "area-persisted",
        serialNumber: "SERIAL-1",
      });
      expect(database.getPropertyNote("note-persisted")).toMatchObject({
        equipmentId: "equipment-persisted",
        text: "Pressure stable",
      });
      expect(database.getPropertyElectricityConfig("property-persisted")).toMatchObject({
        provider: "custom",
        marginCentsPerKwh: 0.45,
        contractName: "Persistent spot contract",
      });
      expect(database.getSensor("sensor-persisted")).toMatchObject({ tags: ["utility", "persistent"], enabled: true });
      expect(database.getObservation("observation-persisted")).toMatchObject({
        sensorId: "sensor-persisted",
        source: "owner",
        revision: 1,
      });
      expect(database.listObservationRevisions("observation-persisted")).toHaveLength(1);
      expect(database.getMaintenanceTask("task-persisted")).toMatchObject({
        propertyId: "property-persisted",
        observationIds: ["observation-persisted"],
        revision: 1,
      });
      expect(database.listMaintenanceTaskRevisions("task-persisted")).toHaveLength(1);
      expect(database.listParameters("house-persisted")).toEqual([
        expect.objectContaining({ id: "parameter-persisted", value: 1998 }),
      ]);
      expect(database.getAsset(assetId)).toMatchObject({
        name: "floor-plan.png",
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      });
      expect(database.getAlertRule("rule-persisted")).not.toBeNull();
      expect(database.getAlertEvent(alertEventId)).not.toBeNull();
      expect(database.pendingNotificationCount()).toBe(2);
      expect(database.listWeatherOutages("house-persisted", outdoorLocationKey(location))).toHaveLength(1);
      expect(database.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      try { database?.close(); } catch { /* A failed assertion may follow an explicit close. */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
