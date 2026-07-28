import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  eventPayloadHashValue,
  eventSigningValue,
  serializeSignedEvent,
  validateSignedEvent,
  type JsonObject,
} from "@climate-twin/stuguby-protocol";

describe("Stuguby protocol legacy signed-event compatibility", () => {
  it("normalizes a pre-rename event without changing its signed wire value", () => {
    const payload: JsonObject = {
      stugbyId: "legacy-stugby",
      name: "Shared Property",
      description: null,
      location: null,
      areas: [],
      equipment: [],
      notes: [],
      maintenance: [],
      editPolicy: "collaborative",
      authorityEpoch: 1,
      designatedSuccessorNodeId: null,
      revision: 3,
      updatedAt: "2026-07-26T12:00:00.000Z",
    };
    const legacy = {
      protocolVersion: "2.0",
      stugbyId: "legacy-stugby",
      eventId: "legacy-event",
      eventKind: "shared-property.updated",
      authorityNodeId: "legacy-authority",
      streamId: "legacy-stream",
      sequence: 7,
      schema: "stugby.shared-property.v2",
      resourceId: "legacy-stugby",
      operation: "upsert",
      revision: 3,
      grantId: null,
      grantEpoch: null,
      occurredAt: "2026-07-26T12:00:00.000Z",
      payload,
      payloadHash: "0".repeat(64),
      keyFingerprint: "1".repeat(64),
      signature: "AQ==",
    };
    const legacyEnvelope = {
      protocolVersion: legacy.protocolVersion,
      stugbyId: legacy.stugbyId,
      eventId: legacy.eventId,
      eventKind: legacy.eventKind,
      authorityNodeId: legacy.authorityNodeId,
      streamId: legacy.streamId,
      sequence: legacy.sequence,
      schema: legacy.schema,
      resourceId: legacy.resourceId,
      operation: legacy.operation,
      revision: legacy.revision,
      grantId: legacy.grantId,
      grantEpoch: legacy.grantEpoch,
      occurredAt: legacy.occurredAt,
      payload: legacy.payload,
    };

    const event = validateSignedEvent(legacy);

    expect(event.stugubyId).toBe("legacy-stugby");
    expect(event.schema).toBe("stuguby.shared-property.v2");
    expect(event.payload).toMatchObject({ stugubyId: "legacy-stugby" });
    expect(eventPayloadHashValue(event)).toBe(canonicalJson(payload));
    expect(eventSigningValue(event)).toBe(`${canonicalJson(legacyEnvelope)}\n${legacy.payloadHash}`);
    expect(JSON.parse(serializeSignedEvent(event))).toEqual(legacy);
  });
});
