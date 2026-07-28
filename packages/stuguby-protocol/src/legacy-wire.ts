import type { JsonObject, JsonValue, StugubySignedEvent, StugubyWireEvent } from "./protocol-contracts.js";

const legacyEvents = new WeakMap<StugubyWireEvent, JsonObject>();

const LEGACY_SCHEMA_NAMES: Readonly<Record<string, string>> = {
  "stugby.grant.v2": "stuguby.grant.v2",
  "stugby.member.v2": "stuguby.member.v2",
  "stugby.shared-property.v2": "stuguby.shared-property.v2",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renamedIdentity(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "stugbyId") || Object.hasOwn(value, "stugubyId")) return value;
  const normalized: Record<string, unknown> = { ...value, stugubyId: value.stugbyId };
  delete normalized["stugbyId"];
  return normalized;
}

/**
 * Protocol v2 predates the Stuguby spelling correction. Signed legacy events
 * must be validated through a normalized view while retaining their original
 * wire representation because changing a signed key or schema invalidates it.
 */
export function normalizeLegacySignedEvent(value: unknown): {
  normalized: unknown;
  legacy: JsonObject | null;
} {
  if (!isRecord(value) || !Object.hasOwn(value, "stugbyId") || Object.hasOwn(value, "stugubyId")) {
    return { normalized: value, legacy: null };
  }
  const legacySchema = typeof value.schema === "string" ? value.schema : "";
  const normalized: Record<string, unknown> = { ...value, stugubyId: value.stugbyId };
  delete normalized["stugbyId"];
  normalized.schema = LEGACY_SCHEMA_NAMES[legacySchema] ?? value.schema;
  if (Object.hasOwn(LEGACY_SCHEMA_NAMES, legacySchema)) normalized.payload = renamedIdentity(value.payload);
  return {
    normalized,
    legacy: value as unknown as JsonObject,
  };
}

export function rememberLegacySignedEvent(event: StugubySignedEvent, legacy: JsonObject | null): void {
  if (legacy) legacyEvents.set(event, legacy);
}

export function legacySigningEnvelope(event: StugubyWireEvent): JsonObject | null {
  const legacy = legacyEvents.get(event);
  if (!legacy) return null;
  return {
    protocolVersion: legacy.protocolVersion!,
    stugbyId: legacy.stugbyId!,
    eventId: legacy.eventId!,
    eventKind: legacy.eventKind!,
    authorityNodeId: legacy.authorityNodeId!,
    streamId: legacy.streamId!,
    sequence: legacy.sequence!,
    schema: legacy.schema!,
    resourceId: legacy.resourceId!,
    operation: legacy.operation!,
    revision: legacy.revision!,
    grantId: legacy.grantId!,
    grantEpoch: legacy.grantEpoch!,
    occurredAt: legacy.occurredAt!,
    payload: legacy.payload!,
  };
}

export function eventPayloadForHash(event: StugubyWireEvent): JsonValue | null {
  return legacyEvents.get(event)?.payload ?? event.payload;
}

export function serializeSignedEvent(event: StugubySignedEvent): string {
  return JSON.stringify(legacyEvents.get(event) ?? event);
}
