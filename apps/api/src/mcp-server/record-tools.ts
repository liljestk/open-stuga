import type { MaintenanceTask } from "@climate-twin/contracts";
import type { McpRuntime } from "./runtime.js";
import { mcpBoundedInteger } from "../mcp-validation.js";
import { optionalToolString, requiredToolString } from "./arguments.js";

export function listObservationRevisions(runtime: McpRuntime, args: Record<string, unknown>): unknown[] {
  const { database } = runtime;
  const observationId = requiredToolString(args, "observationId");
  if (!database.getObservation(observationId)) throw new Error(`Unknown observation: ${observationId}`);
  return database.listObservationRevisions(observationId);
}

export function listMaintenanceTasks(runtime: McpRuntime, args: Record<string, unknown>): MaintenanceTask[] {
  const { database } = runtime;
  const propertyId = optionalToolString(args, "propertyId");
  const houseId = optionalToolString(args, "houseId");
  const areaId = optionalToolString(args, "areaId");
  const equipmentId = optionalToolString(args, "equipmentId");
  return database.listMaintenanceTasks({
    ...(propertyId ? { propertyId } : {}),
    ...(houseId ? { houseId } : {}),
    ...(areaId ? { areaId } : {}),
    ...(equipmentId ? { equipmentId } : {}),
  });
}

export function listMaintenanceTaskRevisions(runtime: McpRuntime, args: Record<string, unknown>): unknown[] {
  const { database } = runtime;
  const maintenanceTaskId = requiredToolString(args, "maintenanceTaskId");
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

export function listPropertyNotes(runtime: McpRuntime, args: Record<string, unknown>): unknown {
  const { database } = runtime;
  return database.listPropertyNotes({
    ...(args.propertyId === undefined ? {} : { propertyId: requiredToolString(args, "propertyId") }),
    ...(args.houseId === undefined ? {} : { houseId: requiredToolString(args, "houseId") }),
    ...(args.areaId === undefined ? {} : { areaId: requiredToolString(args, "areaId") }),
    ...(args.equipmentId === undefined ? {} : { equipmentId: requiredToolString(args, "equipmentId") }),
    limit: mcpBoundedInteger(args.limit, "limit", 200, 1, 500),
  });
}
