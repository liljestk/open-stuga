import type {
  House,
} from "@climate-twin/contracts";
import {
  type JsonObject,
  type StugubyHomeCommand,
  type StugubyPropertyCommand,
  type StugubyPropertyEntityKind,
} from "@climate-twin/stuguby-protocol";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    applyEditableHomeSnapshot(command: StugubyHomeCommand, house: House): void;
    capturePropertyMutation(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", value: JsonObject | null, changedFields?: string[]): StugubyPropertyCommand | null;
    captureCurrentPropertyEntity(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", changedFields?: string[]): StugubyPropertyCommand | null;
  }

  interface StugubyServiceCore {
    capturePropertyMutation(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", value: JsonObject | null, changedFields?: string[]): StugubyPropertyCommand | null;
    captureCurrentPropertyEntity(propertyId: string, entityKind: StugubyPropertyEntityKind, entityId: string, operation: "upsert" | "delete", changedFields?: string[]): StugubyPropertyCommand | null;
  }
}
