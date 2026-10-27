import type {
  House,
} from "@climate-twin/contracts";
import {
  type JsonValue,
  type StugubyDatasetGrant,
  type StugubyHomeFloorPlanPayload,
  type StugubyHomeStructurePayload,
  type StugubySensorCatalogPayload,
  type StugubyShareGrant,
} from "@climate-twin/stuguby-protocol";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    atomicPublication<T>(operation: () => T): T;
    publishGrantSnapshots(
        grant: StugubyShareGrant,
        house: House,
        revision?: number,
      ): void;
    projectDataset(grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): JsonValue | null;
    projectStructure(grant: StugubyShareGrant, house: House, local: boolean): StugubyHomeStructurePayload;
    projectFloorPlans(grant: StugubyShareGrant, house: House): StugubyHomeFloorPlanPayload;
    projectSensors(grant: StugubyShareGrant, house: House, local: boolean): StugubySensorCatalogPayload;
    sensorMetrics(sensorId: string): string[];
    publishHistoricalTelemetry(grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): void;
  }
}
