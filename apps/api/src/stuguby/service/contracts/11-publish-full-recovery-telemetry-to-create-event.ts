import type {
  House,
  MeasurementSample,
  Sensor,
} from "@climate-twin/contracts";
import {
  type JsonObject,
  type JsonValue,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyHomeRecoveryKind,
  type StugubyShareGrant,
  type StugubySignedEvent,
  type StugubyWireEvent,
} from "@climate-twin/stuguby-protocol";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    publishFullRecoveryTelemetry(
        grant: StugubyShareGrant,
        house: House,
        dataset: StugubyDatasetGrant,
      ): number;
    publishRecoveryArchive(
        grant: StugubyShareGrant,
        house: House,
        telemetrySamples: number,
        generation: number,
      ): void;
    publishRecoveryChunks(
        grant: StugubyShareGrant,
        kind: StugubyHomeRecoveryKind,
        records: Iterable<JsonObject>,
        generation: number,
      ): void;
    selectedSensors(grant: StugubyShareGrant, house: House, publications: string[]): Sensor[];
    publishLiveTelemetry(sample: MeasurementSample): void;
    publishDataset(grant: StugubyShareGrant, dataset: StugubyDataset, payload: JsonValue, resourceId: string, revision: number): void;
    createEvent(input: Omit<StugubyWireEvent, "protocolVersion" | "eventId" | "authorityNodeId" | "sequence" | "occurredAt" | "payloadHash">): StugubySignedEvent;
  }
}
