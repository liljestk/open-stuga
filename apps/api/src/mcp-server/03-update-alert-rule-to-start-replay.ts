import type {
  MaintenanceTask,
} from "@climate-twin/contracts";
import { discoverHomeAssistant } from "../discovery.js";
import { database, optionalString, requiredString, status, tpLink } from "./01-config-to-get-house-weather.js";

export function listObservationRevisions(args: Record<string, unknown>): unknown[] {
  const observationId = requiredString(args, "observationId");
  if (!database.getObservation(observationId)) throw new Error(`Unknown observation: ${observationId}`);
  return database.listObservationRevisions(observationId);
}

export function listMaintenanceTasks(args: Record<string, unknown>): MaintenanceTask[] {
  const propertyId = optionalString(args, "propertyId");
  const houseId = optionalString(args, "houseId");
  const areaId = optionalString(args, "areaId");
  const equipmentId = optionalString(args, "equipmentId");
  return database.listMaintenanceTasks({
    ...(propertyId ? { propertyId } : {}),
    ...(houseId ? { houseId } : {}),
    ...(areaId ? { areaId } : {}),
    ...(equipmentId ? { equipmentId } : {}),
  });
}

export function listMaintenanceTaskRevisions(args: Record<string, unknown>): unknown[] {
  const maintenanceTaskId = requiredString(args, "maintenanceTaskId");
  if (!database.getMaintenanceTask(maintenanceTaskId)) {
    throw new Error(`Unknown maintenance task: ${maintenanceTaskId}`);
  }
  return database.listMaintenanceTaskRevisions(maintenanceTaskId);
}

export function assetMetadata(asset: { id: string; houseId: string; name: string; mimeType: string; kind: string; size: number; createdAt: string }): object {
  return {
    id: asset.id,
    houseId: asset.houseId,
    name: asset.name,
    mimeType: asset.mimeType,
    kind: asset.kind,
    size: asset.size,
    createdAt: asset.createdAt,
  };
}

export async function discoverIntegrations(): Promise<object> {
  const [homeAssistantResult, tpLinkResult] = await Promise.allSettled([
    discoverHomeAssistant(),
    tpLink.discoverSources(),
  ]);
  const warnings: string[] = [];
  if (homeAssistantResult.status === "rejected") warnings.push("Home Assistant discovery was unavailable. Enter its address manually.");
  if (tpLinkResult.status === "rejected") warnings.push("TP-Link discovery was unavailable. Enter the hub or energy-device address manually.");
  return {
    homeAssistant: homeAssistantResult.status === "fulfilled" ? homeAssistantResult.value : [],
    tpLink: tpLinkResult.status === "fulfilled" ? tpLinkResult.value.sources : [],
    warnings,
  };
}

export function homeAssistantSetup(): object {
  return {
    configured: status.value.homeAssistant.configured,
    steps: [
      "Create a Home Assistant long-lived access token for a dedicated local user.",
      "Configure its local URL and token in the Stugu web integration screen or the API process's protected environment/secrets file.",
      "Map each Stugu sensor to legacy climate keys and/or a measurements object keyed by registry id.",
      "Verify integration status reports connected=true in the long-running API process.",
    ],
    entityMapSchema: {
      entities: [{
        sensorId: "sensor-01",
        temperature: "sensor.living_room_temperature",
        humidity: "sensor.living_room_humidity",
        battery: "sensor.living_room_battery",
        measurements: { co2: "sensor.living_room_co2" },
      }],
    },
    notes: [
      "Saved credentials are write-only and live outside SQLite.",
      "The MCP server deliberately does not accept or write credentials; keep secrets out of model and tool arguments.",
      "An isolated MCP process does not mirror the separate API process's live WebSocket connection state.",
      "Saving a real integration permanently disables and purges demo telemetry for this database.",
    ],
  };
}

export function tpLinkSetup(): object {
  return {
    configured: status.value.tpLink.configured,
    supportedHubs: ["H100", "H200", "H500"],
    supportedClimateSensors: ["T310", "T315"],
    supportedEnergyDevices: "Configured TP-Link/Kasa hosts that python-kasa exposes through Module.Energy",
    steps: [
      "Install python-kasa from apps/api/python/requirements.txt.",
      "Configure a hub or direct energy device's reserved LAN address and TP-Link credentials in the Stugu web integration screen or the API process's protected environment/secrets file.",
      "Inspect discovered devices in the long-running API process.",
      "Assign a stable child device id to a sensor's tpLinkDeviceId field.",
    ],
    sensorPatchSchema: { tpLinkDeviceId: "hub-child-device-id" },
    deviceMapSchema: { devices: [{ deviceId: "hub-child-device-id", sensorId: "sensor-01" }] },
    notes: [
      "Credentials are never returned and are stored outside SQLite.",
      "The MCP server deliberately does not accept or write credentials; keep secrets out of model and tool arguments.",
      "The isolated MCP process deliberately does not start a second continuous hub poller beside the API process.",
      "LAN discovery includes H100/H200/H500 hubs and energy devices that python-kasa verifies through Module.Energy using saved TP-Link credentials; H500 children are available only when its firmware exposes them over the local API; energy devices expose power, plus cumulative energy only when python-kasa provides consumption_total.",
      "Saving a real integration permanently disables and purges demo telemetry for this database.",
    ],
  };
}

export function homeAssistantConnectionTest(): object {
  return {
    ok: false,
    available: false,
    runtimeScope: "mcp-process",
    message: "Live Home Assistant connection testing belongs to the long-running API process and is unavailable in the isolated MCP process.",
  };
}

export function tpLinkConnectionTest(): object {
  return {
    ok: false,
    available: false,
    runtimeScope: "mcp-process",
    message: "Live TP-Link connection testing belongs to the long-running API process and is unavailable in the isolated MCP process.",
  };
}
