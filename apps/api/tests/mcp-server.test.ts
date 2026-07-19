import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";

describe("MCP server policy", () => {
  it("crosses the real-data boundary when a complete real integration is configured", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/api/src/mcp-server.ts"],
      cwd: process.cwd().replace(/[\\/]apps[\\/]api$/, ""),
      env: {
        ...getDefaultEnvironment(),
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "true",
        HA_URL: "http://homeassistant.local:8123",
        HA_TOKEN: "configured-token",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "climate-twin-real-mode-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const response = await client.callTool({ name: "get_integration_status", arguments: {} });
      expect((response.structuredContent as { result: { status: { mock: unknown } } }).result.status.mock).toMatchObject({
        enabled: false,
        mode: "real",
      });
      await expect(client.callTool({
        name: "select_mock_scenario",
        arguments: { scenario: "normal" },
      })).rejects.toThrow(/permanently disabled/i);
    } finally {
      await client.close();
    }
  }, 10_000);

  it("advertises the hardened tool contract and returns privacy-safe house summaries", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/api/src/mcp-server.ts"],
      cwd: process.cwd().replace(/[\\/]apps[\\/]api$/, ""),
      env: {
        ...getDefaultEnvironment(),
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        MOCK_ENABLED: "true",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "climate-twin-test", version: "1.0.0" });
    await client.connect(transport);
    let closeDurationMs = Number.POSITIVE_INFINITY;
    try {
      expect(client.getServerVersion()).toEqual({ name: "stuga-local", version: "0.3.0" });
      expect(client.getInstructions()).toContain("not an administration API");
      expect(client.getInstructions()).toContain("Raw integration credentials");
      const listedTools = await client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name);
      expect(listedTools.tools).toHaveLength(73);
      expect(new Set(toolNames).size).toBe(73);
      expect(listedTools.tools.every((tool) => (
        tool.outputSchema?.type === "object"
        && Array.isArray(tool.outputSchema.required)
        && tool.outputSchema.required.includes("result")
        && JSON.stringify(tool.outputSchema.properties?.result) === JSON.stringify({
          oneOf: [{ type: "object" }, { type: "array" }],
        })
      ))).toBe(true);
      expect(toolNames).not.toContain("configure_home_assistant");
      expect(toolNames).not.toContain("configure_tp_link");
      const createHouseTool = listedTools.tools.find((tool) => tool.name === "create_house");
      expect(createHouseTool?.inputSchema.properties).toMatchObject({
        floors: {
          items: {
            properties: {
              planElements: {
                items: {
                  properties: {
                    height: { type: "number", exclusiveMinimum: 0 },
                  },
                },
              },
            },
          },
        },
      });
      const createSensorTool = listedTools.tools.find((tool) => tool.name === "create_sensor");
      const updateSensorTool = listedTools.tools.find((tool) => tool.name === "update_sensor");
      expect(createSensorTool?.inputSchema.required).not.toContain("roomId");
      expect(createSensorTool?.inputSchema.properties).toMatchObject({ roomId: { type: ["string", "null"] } });
      expect(updateSensorTool?.inputSchema.properties).toMatchObject({
        patch: { properties: { roomId: { type: ["string", "null"] } } },
      });
      const weatherTool = listedTools.tools.find((tool) => tool.name === "get_house_weather");
      expect(weatherTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(weatherTool?.inputSchema.properties).toMatchObject({
        persistObservation: { type: "boolean", default: false },
        confirmRealDataPersistence: { const: true },
      });
      expect(listedTools.tools.find((tool) => tool.name === "replace_house_layout")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      expect(listedTools.tools.find((tool) => tool.name === "import_measurements")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
      expect(listedTools.tools.find((tool) => tool.name === "start_replay")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(listedTools.tools.find((tool) => tool.name === "list_properties")?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(listedTools.tools.find((tool) => tool.name === "create_property")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
      expect(listedTools.tools.find((tool) => tool.name === "update_property_area")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      expect(listedTools.tools.find((tool) => tool.name === "update_area_equipment")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      const createEquipmentTool = listedTools.tools.find((tool) => tool.name === "create_area_equipment");
      expect(createEquipmentTool?.inputSchema.properties).not.toHaveProperty("propertyId");
      expect(createEquipmentTool?.inputSchema.required).toEqual(["areaId", "name", "kind"]);
      const updateObservationTool = listedTools.tools.find((tool) => tool.name === "update_observation");
      const createObservationTool = listedTools.tools.find((tool) => tool.name === "create_observation");
      expect(createObservationTool?.inputSchema.properties).not.toHaveProperty("status");
      expect(createObservationTool?.inputSchema.properties).not.toHaveProperty("resolutionNote");
      expect(updateObservationTool?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(updateObservationTool?.inputSchema.required).toEqual(["observationId", "baseRevision", "patch"]);
      expect(updateObservationTool?.inputSchema.properties).toMatchObject({
        patch: {
          properties: {
            status: { enum: ["open", "resolved"] },
            resolutionNote: {
              type: ["string", "null"],
              minLength: 1,
              maxLength: MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
            },
          },
        },
      });
      expect(listedTools.tools.find((tool) => tool.name === "list_observation_revisions")?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      const createMaintenanceTool = listedTools.tools.find((tool) => tool.name === "create_maintenance_task");
      const updateMaintenanceTool = listedTools.tools.find((tool) => tool.name === "update_maintenance_task");
      const listMaintenanceTool = listedTools.tools.find((tool) => tool.name === "list_maintenance_tasks");
      expect(createMaintenanceTool?.annotations).toMatchObject({
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      });
      expect(listMaintenanceTool?.inputSchema.properties).toMatchObject({
        propertyId: { type: "string", minLength: 1, maxLength: 200 },
        houseId: { type: "string", minLength: 1, maxLength: 200 },
        areaId: { type: "string", minLength: 1, maxLength: 200 },
        equipmentId: { type: "string", minLength: 1, maxLength: 200 },
      });
      expect(createMaintenanceTool?.inputSchema.required).toEqual(["title", "basis"]);
      expect(createMaintenanceTool?.inputSchema.anyOf).toEqual([
        { required: ["propertyId"] },
        {
          required: ["houseId"],
          properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } },
        },
      ]);
      expect(createMaintenanceTool?.inputSchema.properties).toMatchObject({
        propertyId: { type: "string", minLength: 1, maxLength: 200 },
        houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
        areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
        equipmentId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
      });
      expect(updateMaintenanceTool?.inputSchema.required)
        .toEqual(["maintenanceTaskId", "baseRevision", "patch"]);
      expect(updateMaintenanceTool?.inputSchema.properties).toMatchObject({
        patch: {
          properties: {
            houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
            areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
            equipmentId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
            observationIds: {
              type: "array", maxItems: 100,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
            status: { enum: ["planned", "in-progress", "completed", "verified", "cancelled"] },
            completionNote: { type: ["string", "null"], maxLength: 5_000 },
            verificationNote: { type: ["string", "null"], maxLength: 5_000 },
          },
        },
      });
      expect(listedTools.tools.find((tool) => tool.name === "delete_maintenance_task")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
      await expect(client.callTool({
        name: "get_house_weather",
        arguments: { houseId: "house-main", persistObservation: true },
      })).rejects.toThrow("confirmRealDataPersistence must be true");

      const callStructured = async (name: string, arguments_: Record<string, unknown> = {}): Promise<unknown> => {
        const response = await client.callTool({ name, arguments: arguments_ });
        expect(response.structuredContent).toHaveProperty("result");
        const result = (response.structuredContent as { result: unknown }).result;
        const text = response.content.find((item) => item.type === "text");
        expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual(result);
        return result;
      };

      await expect(client.callTool({
        name: "create_house",
        arguments: { propertyId: "   ", name: "Invalid", timezone: "Europe/Helsinki", floors: [] },
      })).rejects.toThrow("propertyId is required");

      const roomLinkedSensor = await callStructured("create_sensor", {
        id: "mcp-room-sensor",
        houseId: "house-main",
        floorId: "floor-ground",
        name: "MCP room sensor",
        roomId: "kitchen",
        room: "Kitchen",
        model: "Test",
        x: 10,
        y: 2,
        z: 1.4,
      }) as { roomId: string | null; room: string };
      expect(roomLinkedSensor).toMatchObject({ roomId: "kitchen", room: "Kitchen" });
      const movedRoomSensor = await callStructured("update_sensor", {
        sensorId: "mcp-room-sensor",
        patch: { roomId: "living" },
      }) as { roomId: string | null; room: string };
      expect(movedRoomSensor).toMatchObject({ roomId: "living", room: "Living room" });

      await callStructured("create_house", {
          id: "mcp-private-house",
          name: "Private cabin",
          timezone: "Europe/Helsinki",
          location: { latitude: 60.123456, longitude: 24.654321, label: "Precise private address" },
          mapPlacement: { latitude: 60.123456, longitude: 24.654321, metersPerPlanUnit: 0.25 },
          floors: [{
            id: "private-floor",
            name: "Ground",
            width: 10,
            height: 8,
            elevation: 0,
            walls: [],
            rooms: [],
            planElements: [{
              id: "private-fireplace", kind: "fireplace", position: { x: 2, y: 2 },
              rotationDegrees: 0, width: .8, height: 1.4,
            }],
            backgroundImage: "data:image/png;base64,PRIVATE_FLOOR_PLAN",
          }],
      });
      const privateHouse = await callStructured("get_house", { houseId: "mcp-private-house" }) as {
        floors: Array<{ planElements?: Array<{ height?: number }> }>;
      };
      expect(privateHouse.floors[0]?.planElements?.[0]?.height).toBe(1.4);
      const houses = await callStructured("list_houses");
      const serialized = JSON.stringify(houses);
      expect(serialized).toContain("mcp-private-house");
      expect(serialized).toContain('"propertyId":"property-main"');
      expect(serialized).toContain("visualReferenceConfigured");
      expect(serialized).not.toContain("60.123456");
      expect(serialized).not.toContain("24.654321");
      expect(serialized).not.toContain("Precise private address");
      expect(serialized).not.toContain("PRIVATE_FLOOR_PLAN");
      const propertyHouses = await callStructured("list_houses", { propertyId: "property-main" }) as Array<{ propertyId: string }>;
      expect(propertyHouses.every((house) => house.propertyId === "property-main")).toBe(true);

      await callStructured("create_property", {
        id: "mcp-target-property",
        name: "MCP target property",
        description: "Private property directions",
        location: { latitude: 61.123456, longitude: 25.654321, label: "Private property centre" },
      });
      const properties = await callStructured("list_properties") as Array<{
        id: string; descriptionConfigured: boolean; locationConfigured: boolean;
      }>;
      expect(properties).toContainEqual(expect.objectContaining({
        id: "mcp-target-property", descriptionConfigured: true, locationConfigured: true,
      }));
      const serializedProperties = JSON.stringify(properties);
      expect(serializedProperties).not.toContain("61.123456");
      expect(serializedProperties).not.toContain("25.654321");
      expect(serializedProperties).not.toContain("Private property directions");
      expect(serializedProperties).not.toContain("Private property centre");

      const propertyMaintenance = await callStructured("create_maintenance_task", {
        id: "mcp-property-maintenance",
        propertyId: "mcp-target-property",
        title: "Inspect the estate drainage",
        basis: "scheduled",
      }) as { propertyId: string; houseId: string | null; revision: number };
      expect(propertyMaintenance).toMatchObject({
        propertyId: "mcp-target-property", houseId: null, revision: 1,
      });
      const propertyMaintenanceTasks = await callStructured("list_maintenance_tasks", {
        propertyId: "mcp-target-property",
      }) as Array<{ id: string; propertyId: string }>;
      expect(propertyMaintenanceTasks).toContainEqual(expect.objectContaining({
        id: "mcp-property-maintenance", propertyId: "mcp-target-property",
      }));

      await callStructured("update_house", { houseId: "mcp-private-house", propertyId: "mcp-target-property" });
      const movedPropertyHouses = await callStructured("list_houses", {
        propertyId: "mcp-target-property",
      }) as Array<{ id: string; propertyId: string }>;
      expect(movedPropertyHouses).toContainEqual(expect.objectContaining({
        id: "mcp-private-house", propertyId: "mcp-target-property",
      }));

      await callStructured("create_property_area", {
        id: "mcp-moving-area",
        propertyId: "property-main",
        name: "Moving area",
        kind: "yard",
        description: "Private boundary note",
        polygon: [
          { latitude: 60.001, longitude: 24.001 },
          { latitude: 60.001, longitude: 24.002 },
          { latitude: 60.002, longitude: 24.001 },
        ],
      });
      await callStructured("create_maintenance_task", {
        id: "mcp-area-move-task",
        houseId: "house-main",
        areaId: "mcp-moving-area",
        title: "Area move context",
        basis: "scheduled",
      });
      const listedAreas = await callStructured("list_property_areas", {
        propertyId: "property-main",
      }) as Array<{ id: string; propertyId: string; boundaryPointCount: number }>;
      expect(listedAreas).toContainEqual(expect.objectContaining({
        id: "mcp-moving-area", propertyId: "property-main", boundaryPointCount: 3,
      }));
      const serializedAreas = JSON.stringify(listedAreas);
      expect(serializedAreas).not.toContain("60.001");
      expect(serializedAreas).not.toContain("Private boundary note");
      const movedArea = await callStructured("update_property_area", {
        areaId: "mcp-moving-area",
        patch: { propertyId: "mcp-target-property" },
      }) as { propertyId: string };
      expect(movedArea.propertyId).toBe("mcp-target-property");
      const areaMoveRevisions = await callStructured("list_maintenance_task_revisions", {
        maintenanceTaskId: "mcp-area-move-task",
      }) as Array<{ actor: string; changedFields: string[] }>;
      expect(areaMoveRevisions.at(-1)).toMatchObject({ actor: "local-mcp" });
      expect(areaMoveRevisions.at(-1)?.changedFields).toContain("propertyId");

      await callStructured("create_property_area", {
        id: "mcp-equipment-source-area",
        propertyId: "property-main",
        name: "Equipment source",
        kind: "garage",
        polygon: [
          { latitude: 60.003, longitude: 24.003 },
          { latitude: 60.003, longitude: 24.004 },
          { latitude: 60.004, longitude: 24.003 },
        ],
      });
      await callStructured("create_property_area", {
        id: "mcp-equipment-target-area",
        propertyId: "mcp-target-property",
        name: "Equipment target",
        kind: "garage",
        polygon: [
          { latitude: 61.003, longitude: 25.003 },
          { latitude: 61.003, longitude: 25.004 },
          { latitude: 61.004, longitude: 25.003 },
        ],
      });
      await callStructured("create_area_equipment", {
        id: "mcp-moving-equipment",
        areaId: "mcp-equipment-source-area",
        name: "Moving pump",
        kind: "pump",
        serialNumber: "PRIVATE-SERIAL-123",
        notes: "Private maintenance note",
      });
      await callStructured("create_maintenance_task", {
        id: "mcp-equipment-move-task",
        houseId: "house-main",
        areaId: "mcp-equipment-source-area",
        equipmentId: "mcp-moving-equipment",
        title: "Equipment move context",
        basis: "scheduled",
      });
      const listedEquipment = await callStructured("list_area_equipment", {
        propertyId: "property-main",
        areaId: "mcp-equipment-source-area",
      }) as Array<{
        id: string; propertyId: string; areaId: string; serialNumberConfigured: boolean; notesConfigured: boolean;
      }>;
      expect(listedEquipment).toContainEqual(expect.objectContaining({
        id: "mcp-moving-equipment",
        propertyId: "property-main",
        areaId: "mcp-equipment-source-area",
        serialNumberConfigured: true,
        notesConfigured: true,
      }));
      const serializedEquipment = JSON.stringify(listedEquipment);
      expect(serializedEquipment).not.toContain("PRIVATE-SERIAL-123");
      expect(serializedEquipment).not.toContain("Private maintenance note");
      const movedEquipment = await callStructured("update_area_equipment", {
        equipmentId: "mcp-moving-equipment",
        patch: { areaId: "mcp-equipment-target-area" },
      }) as { propertyId: string; areaId: string };
      expect(movedEquipment).toMatchObject({
        propertyId: "mcp-target-property",
        areaId: "mcp-equipment-target-area",
      });
      const equipmentMoveRevisions = await callStructured("list_maintenance_task_revisions", {
        maintenanceTaskId: "mcp-equipment-move-task",
      }) as Array<{ actor: string; changedFields: string[] }>;
      expect(equipmentMoveRevisions.at(-1)).toMatchObject({ actor: "local-mcp" });
      expect(equipmentMoveRevisions.at(-1)?.changedFields).toContain("propertyId");

      const targetedPropertyMaintenance = await callStructured("update_maintenance_task", {
        maintenanceTaskId: "mcp-property-maintenance",
        baseRevision: 1,
        patch: { areaId: "mcp-equipment-target-area", equipmentId: "mcp-moving-equipment" },
      }) as { propertyId: string; houseId: string | null; areaId: string; equipmentId: string; revision: number };
      expect(targetedPropertyMaintenance).toMatchObject({
        propertyId: "mcp-target-property",
        houseId: null,
        areaId: "mcp-equipment-target-area",
        equipmentId: "mcp-moving-equipment",
        revision: 2,
      });
      const equipmentMaintenanceTasks = await callStructured("list_maintenance_tasks", {
        propertyId: "mcp-target-property",
        equipmentId: "mcp-moving-equipment",
      }) as Array<{ id: string }>;
      expect(equipmentMaintenanceTasks).toContainEqual(expect.objectContaining({ id: "mcp-property-maintenance" }));

      await callStructured("get_house", { houseId: "house-main" });
      await callStructured("list_sensors", { houseId: "house-main" });
      await callStructured("get_sensor_snapshot", { sensorId: "sensor-01" });
      await callStructured("list_measurement_definitions");
      await callStructured("select_mock_scenario", { scenario: "normal" });
      await callStructured("list_mock_scenarios");

      const from = new Date(Date.now() - 60_000).toISOString();
      await callStructured("ingest_measurements", { samples: [{
        sensorId: "sensor-01", metric: "temperature", value: 21.25, canonicalUnit: "°C", source: "api",
      }] });
      const to = new Date(Date.now() + 60_000).toISOString();
      await callStructured("get_measurement_snapshot", { houseId: "house-main" });
      await callStructured("query_measurement_history", { sensorId: "sensor-01", metric: "temperature", from, to });
      await callStructured("forecast_measurement", { sensorId: "sensor-01", metric: "temperature", hours: 1 });
      await callStructured("run_thermal_simulation", { houseId: "house-main", sensorId: "sensor-01", from, to, horizonHours: 0 });

      await callStructured("create_alert_rule", { rule: {
        id: "mcp-smoke-rule", name: "MCP smoke rule", sensorId: "sensor-01", metric: "temperature",
        operator: "gte", threshold: 99, durationSeconds: 60, severity: "warning",
      } });
      await callStructured("list_alert_rules");
      await callStructured("list_alert_events", { limit: 10 });

      const observation = await callStructured("create_observation", {
        id: "mcp-smoke-observation", houseId: "house-main", floorId: "floor-ground",
        kind: "note", severity: "info", note: "MCP structured-output smoke test",
      }) as { createdAt: string; revision: number };
      const updatedObservation = await callStructured("update_observation", {
        observationId: "mcp-smoke-observation",
        baseRevision: 1,
        patch: { note: "MCP revision history smoke test", confidence: "confirmed" },
      }) as { createdAt: string; revision: number };
      expect(updatedObservation).toMatchObject({ createdAt: observation.createdAt, revision: 2 });
      const resolvedObservation = await callStructured("update_observation", {
        observationId: "mcp-smoke-observation",
        baseRevision: 2,
        patch: { status: "resolved", resolutionNote: "Fixed leak" },
      }) as { status: string; resolutionNote: string | null; resolvedAt: string | null; revision: number };
      expect(resolvedObservation).toMatchObject({
        status: "resolved",
        resolutionNote: "Fixed leak",
        revision: 3,
      });
      expect(resolvedObservation.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const reopenedObservation = await callStructured("update_observation", {
        observationId: "mcp-smoke-observation",
        baseRevision: 3,
        patch: { status: "open" },
      }) as { status: string; resolutionNote: string | null; resolvedAt: string | null; revision: number };
      expect(reopenedObservation).toMatchObject({
        status: "open",
        resolutionNote: null,
        resolvedAt: null,
        revision: 4,
      });
      const revisions = await callStructured("list_observation_revisions", {
        observationId: "mcp-smoke-observation",
      }) as Array<{ revision: number; actor: string; changedFields: string[] }>;
      expect(revisions).toHaveLength(4);
      expect(revisions[1]).toMatchObject({
        revision: 2,
        actor: "local-mcp",
        changedFields: ["note", "confidence"],
      });
      expect(revisions[2]).toMatchObject({
        revision: 3,
        actor: "local-mcp",
        changedFields: ["status", "resolutionNote", "resolvedAt"],
      });
      expect(revisions[3]).toMatchObject({
        revision: 4,
        actor: "local-mcp",
        changedFields: ["status", "resolutionNote", "resolvedAt"],
      });
      await expect(client.callTool({
        name: "update_observation",
        arguments: {
          observationId: "mcp-smoke-observation",
          baseRevision: 4,
          patch: {
            status: "resolved",
            resolutionNote: "x".repeat(MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH + 1),
          },
        },
      })).rejects.toThrow();
      const maximumResolution = await callStructured("update_observation", {
        observationId: "mcp-smoke-observation",
        baseRevision: 4,
        patch: {
          status: "resolved",
          resolutionNote: "x".repeat(MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH),
        },
      }) as { resolutionNote: string; revision: number };
      expect(maximumResolution).toMatchObject({ revision: 5 });
      expect(maximumResolution.resolutionNote).toHaveLength(MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH);
      await expect(client.callTool({
        name: "update_observation",
        arguments: { observationId: "mcp-smoke-observation", baseRevision: 1, patch: { note: "stale" } },
      })).rejects.toThrow("reload it before applying this change");
      await callStructured("list_observations", { houseId: "house-main" });

      const maintenance = await callStructured("create_maintenance_task", {
        id: "mcp-maintenance", houseId: "house-main", floorId: "floor-ground",
        title: "Repair observed issue", basis: "condition-based", priority: "high",
        plannedFor: "2026-07-18", dueBy: "2026-07-20",
        observationIds: ["mcp-smoke-observation"],
      }) as { revision: number; status: string; observationIds: string[] };
      expect(maintenance).toMatchObject({
        revision: 1, status: "planned", observationIds: ["mcp-smoke-observation"],
      });
      const completedMaintenance = await callStructured("update_maintenance_task", {
        maintenanceTaskId: "mcp-maintenance",
        baseRevision: 1,
        patch: { status: "completed", completionNote: "Repaired and tested" },
      }) as { revision: number; status: string; completedAt: string };
      expect(completedMaintenance).toMatchObject({ revision: 2, status: "completed" });
      expect(completedMaintenance.completedAt).toMatch(/Z$/);
      const verifiedMaintenance = await callStructured("update_maintenance_task", {
        maintenanceTaskId: "mcp-maintenance",
        baseRevision: 2,
        patch: { status: "verified", verificationNote: "Dry after follow-up" },
      }) as { revision: number; status: string; verifiedAt: string };
      expect(verifiedMaintenance).toMatchObject({ revision: 3, status: "verified" });
      expect(verifiedMaintenance.verifiedAt).toMatch(/Z$/);
      const maintenanceRevisions = await callStructured("list_maintenance_task_revisions", {
        maintenanceTaskId: "mcp-maintenance",
      }) as Array<{ actor: string; revision: number }>;
      expect(maintenanceRevisions).toHaveLength(3);
      expect(maintenanceRevisions.every((revision) => revision.actor === "local-mcp")).toBe(true);
      await callStructured("list_maintenance_tasks", { houseId: "house-main" });
      await expect(client.callTool({
        name: "delete_maintenance_task",
        arguments: { maintenanceTaskId: "mcp-maintenance" },
      })).rejects.toThrow("confirm must be true");
      await callStructured("delete_maintenance_task", { maintenanceTaskId: "mcp-maintenance", confirm: true });

      await callStructured("upsert_static_parameter", {
        id: "mcp-smoke-parameter", houseId: "house-main", scopeType: "house", scopeId: "house-main",
        key: "mcpSmoke", value: true, label: "MCP smoke",
      });
      await callStructured("list_static_parameters", { houseId: "house-main" });

      const asset = await callStructured("upload_asset", {
        houseId: "house-main", name: "mcp-smoke.png", mimeType: "image/png", kind: "other", data: "AA==",
      }) as { id: string };
      await callStructured("list_assets", { houseId: "house-main" });
      await callStructured("get_asset_metadata", { assetId: asset.id });
      await expect(client.callTool({ name: "delete_asset", arguments: { assetId: asset.id } }))
        .rejects.toThrow("confirm must be true");
      await callStructured("delete_asset", { assetId: asset.id, confirm: true });

      await callStructured("get_integration_status");
      await callStructured("get_home_assistant_setup");
      await callStructured("get_tp_link_setup");
      await callStructured("get_replay_status");
      await callStructured("start_replay", { sensorIds: ["sensor-01"], from, to, speed: 10_000 });
      await callStructured("stop_replay");
    } finally {
      const closeStartedAt = Date.now();
      await client.close();
      closeDurationMs = Date.now() - closeStartedAt;
    }

    // Closing stdin should let the server drain and exit without the client's
    // two-second SIGTERM fallback.
    expect(closeDurationMs).toBeLessThan(1_500);
  }, 15_000);
});
