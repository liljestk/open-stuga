import type { Nexus433SamplePreview } from "@climate-twin/contracts";
import { compareCodeUnits } from "../text-order.js";

export const NEXUS433_MAX_PAYLOAD_BYTES = 2_048;

export type Nexus433Packet =
  | {
      kind: "state";
      receiverIdentity: string;
      providerKey: string;
      senderId: string;
      channel: number;
      sample: Nexus433SamplePreview;
    }
  | {
      kind: "sender-connection";
      receiverIdentity: string;
      providerKey: string;
      senderId: string;
      channel: number;
      online: boolean;
    }
  | {
      kind: "gateway-connection";
      receiverIdentity: string;
      online: boolean;
    };

const STATE_TOPIC = /^nexus433\/sensor\/([0-9a-f]{12})_([0-9a-f]{4})\/state$/iu;
const SENDER_CONNECTION_TOPIC = /^nexus433\/sensor\/([0-9a-f]{12})_([0-9a-f]{4})\/connection$/iu;
const GATEWAY_CONNECTION_TOPIC = /^nexus433\/sensor\/([0-9a-f]{12})\/connection$/iu;

function senderIdentity(providerKey: string): { senderId: string; channel: number } | null {
  const normalized = providerKey.toLowerCase();
  const channel = Number.parseInt(normalized.slice(2), 16);
  if (!Number.isInteger(channel) || channel < 0 || channel > 2) return null;
  return { senderId: normalized.slice(0, 2), channel };
}

function connectionValue(payload: Buffer): boolean | null {
  const value = payload.toString("utf8");
  if (value === "online") return true;
  if (value === "offline") return false;
  return null;
}

function sampleValue(payload: Buffer): Nexus433SamplePreview | null {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodeUnits);
  if (keys.join(",") !== "battery,humidity,quality,temperature") return null;
  const { temperature, humidity, battery, quality } = record;
  if (typeof temperature !== "number" || !Number.isFinite(temperature)
    || temperature < -40 || temperature > 60
    || typeof humidity !== "number" || !Number.isInteger(humidity)
    || humidity < 0 || humidity > 100
    || (battery !== "ok" && battery !== "low")
    || typeof quality !== "number" || !Number.isInteger(quality)
    || quality < 0 || quality > 100) return null;
  return { temperature, humidity, battery, quality };
}

export function parseNexus433Packet(topic: string, payload: Buffer): Nexus433Packet | null {
  if (Buffer.byteLength(topic, "utf8") > 200 || payload.byteLength > NEXUS433_MAX_PAYLOAD_BYTES) return null;
  const stateMatch = STATE_TOPIC.exec(topic);
  if (stateMatch) {
    const providerKey = stateMatch[2]!.toLowerCase();
    const identity = senderIdentity(providerKey);
    const sample = sampleValue(payload);
    if (!identity || !sample) return null;
    return {
      kind: "state",
      receiverIdentity: stateMatch[1]!.toLowerCase(),
      providerKey,
      ...identity,
      sample,
    };
  }
  const senderConnectionMatch = SENDER_CONNECTION_TOPIC.exec(topic);
  if (senderConnectionMatch) {
    const providerKey = senderConnectionMatch[2]!.toLowerCase();
    const identity = senderIdentity(providerKey);
    const online = connectionValue(payload);
    if (!identity || online === null) return null;
    return {
      kind: "sender-connection",
      receiverIdentity: senderConnectionMatch[1]!.toLowerCase(),
      providerKey,
      ...identity,
      online,
    };
  }
  const gatewayConnectionMatch = GATEWAY_CONNECTION_TOPIC.exec(topic);
  if (gatewayConnectionMatch) {
    const online = connectionValue(payload);
    if (online === null) return null;
    return {
      kind: "gateway-connection",
      receiverIdentity: gatewayConnectionMatch[1]!.toLowerCase(),
      online,
    };
  }
  return null;
}
