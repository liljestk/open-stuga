import type {
  AreaEquipment,
  MaintenanceTask,
  PropertyArea,
  PropertyNote,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import {
  type JsonObject,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyEntityKind,
  type StugubySharedProperty,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { SharedPropertyInput } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    enqueueCorePropertyMutation(
        stugubyId: string,
        entityKind: StugubyPropertyEntityKind,
        entityId: string,
        operation: "upsert" | "delete",
        value: JsonObject | null,
        changedFields?: string[],
      ): StugubyPropertyCommand;
    applyPropertyCommandAs(actorNodeId: string, candidate: unknown): StugubyPropertyCommandResult;
    publishSharedPropertyEvent(property: StugubySharedProperty): void;
    refreshPropertyLink(stugubyId: string, forcedState?: StugubyPropertyLink["syncState"]): void;
    registerLocalPropertyMappings(stuguby: StugubySummary, propertyId: string): void;
    sharedPropertyFromLocal(stugubyId: string, propertyId: string, previous: StugubySharedProperty): SharedPropertyInput;
    sharedArea(area: PropertyArea): StugubySharedProperty["areas"][number];
    sharedEquipment(stugubyId: string, item: AreaEquipment): StugubySharedProperty["equipment"][number];
    sharedNote(note: PropertyNote): StugubySharedProperty["notes"][number];
    sharedMaintenance(task: MaintenanceTask): StugubySharedProperty["maintenance"][number];
  }

  interface StugubyServiceCore {
    applyPropertyCommandAs(actorNodeId: string, candidate: unknown): StugubyPropertyCommandResult;
  }
}
