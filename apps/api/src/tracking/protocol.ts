import { createHmac, timingSafeEqual } from "node:crypto";

export const TRACKING_PROTOCOL_VERSION = 1;
export const TRACKING_ROTATING_ID_BYTES = 8;
export const TRACKING_AUTHENTICATOR_BYTES = 4;
export const TRACKING_ADVERTISEMENT_BYTES = 18;
export const TRACKING_UNAVAILABLE_BATTERY = 0xff;

export const TRACKING_FLAGS = {
  moving: 1 << 0,
  lowBattery: 1 << 1,
  buttonPressed: 1 << 2,
  searchMode: 1 << 3,
  tamperDetected: 1 << 4,
} as const;

export interface TrackingAdvertisement {
  protocolVersion: number;
  flags: number;
  rotatingTagId: string;
  epochCounter: number;
  eventCounter: number;
  batteryPercent: number | null;
  authenticator: string;
  rawPayload: string;
}

function strictBase64Url(value: string, bytes: number, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${field} must be base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value.replace(/=+$/u, "")) {
    throw new Error(`${field} must encode exactly ${bytes} bytes`);
  }
  return decoded;
}

function unsigned16(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${field} must be an unsigned 16-bit integer`);
  }
  return value;
}

function protocolHeader(protocolVersion: number, flags: number): number {
  if (!Number.isInteger(protocolVersion) || protocolVersion < 0 || protocolVersion > 3) {
    throw new Error("protocolVersion must fit in two bits");
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0x3f) {
    throw new Error("flags must fit in six bits");
  }
  return (protocolVersion << 6) | flags;
}

export function trackingEpochCounter(at: Date, rotationWindowMinutes = 15): number {
  if (!Number.isInteger(rotationWindowMinutes) || rotationWindowMinutes < 5 || rotationWindowMinutes > 60) {
    throw new Error("rotationWindowMinutes must be between 5 and 60");
  }
  return Math.floor(at.getTime() / (rotationWindowMinutes * 60_000)) & 0xffff;
}

export function rotatingTagId(secret: Uint8Array, protocolVersion: number, epochCounter: number): string {
  const input = Buffer.alloc(3);
  input.writeUInt8(protocolVersion, 0);
  input.writeUInt16BE(unsigned16(epochCounter, "epochCounter"), 1);
  return createHmac("sha256", secret).update(input).digest().subarray(0, TRACKING_ROTATING_ID_BYTES)
    .toString("base64url");
}

export function trackingAdvertisementMessage(input: {
  protocolVersion: number;
  flags: number;
  rotatingTagId: string;
  epochCounter: number;
  eventCounter: number;
  batteryPercent: number | null;
}): Buffer {
  const output = Buffer.alloc(TRACKING_ADVERTISEMENT_BYTES - TRACKING_AUTHENTICATOR_BYTES);
  output.writeUInt8(protocolHeader(input.protocolVersion, input.flags), 0);
  strictBase64Url(input.rotatingTagId, TRACKING_ROTATING_ID_BYTES, "rotatingTagId").copy(output, 1);
  output.writeUInt16BE(unsigned16(input.epochCounter, "epochCounter"), 9);
  output.writeUInt16BE(unsigned16(input.eventCounter, "eventCounter"), 11);
  if (input.batteryPercent !== null
    && (!Number.isInteger(input.batteryPercent) || input.batteryPercent < 0 || input.batteryPercent > 100)) {
    throw new Error("batteryPercent must be null or an integer from 0 to 100");
  }
  const battery = input.batteryPercent === null ? TRACKING_UNAVAILABLE_BATTERY : input.batteryPercent;
  output.writeUInt8(battery, 13);
  return output;
}

export function trackingAuthenticator(secret: Uint8Array, message: Uint8Array): string {
  return createHmac("sha256", secret).update(message).digest()
    .subarray(0, TRACKING_AUTHENTICATOR_BYTES).toString("base64url");
}

export function encodeTrackingAdvertisement(
  secret: Uint8Array,
  input: {
    protocolVersion?: number;
    flags?: number;
    epochCounter: number;
    eventCounter: number;
    batteryPercent?: number | null;
  },
): TrackingAdvertisement {
  const protocolVersion = input.protocolVersion ?? TRACKING_PROTOCOL_VERSION;
  const flags = input.flags ?? 0;
  const rotatingId = rotatingTagId(secret, protocolVersion, input.epochCounter);
  const message = trackingAdvertisementMessage({
    protocolVersion,
    flags,
    rotatingTagId: rotatingId,
    epochCounter: input.epochCounter,
    eventCounter: input.eventCounter,
    batteryPercent: input.batteryPercent ?? null,
  });
  const authenticator = trackingAuthenticator(secret, message);
  return {
    protocolVersion,
    flags,
    rotatingTagId: rotatingId,
    epochCounter: input.epochCounter,
    eventCounter: input.eventCounter,
    batteryPercent: input.batteryPercent ?? null,
    authenticator,
    rawPayload: Buffer.concat([
      message,
      strictBase64Url(authenticator, TRACKING_AUTHENTICATOR_BYTES, "authenticator"),
    ]).toString("base64url"),
  };
}

export function parseTrackingAdvertisement(payload: Uint8Array | string): TrackingAdvertisement {
  const bytes = typeof payload === "string"
    ? strictBase64Url(payload, TRACKING_ADVERTISEMENT_BYTES, "rawPayload")
    : Buffer.from(payload);
  if (bytes.length !== TRACKING_ADVERTISEMENT_BYTES) {
    throw new Error(`Tracking advertisements must contain ${TRACKING_ADVERTISEMENT_BYTES} bytes`);
  }
  const header = bytes.readUInt8(0);
  const battery = bytes.readUInt8(13);
  if (battery > 100 && battery !== TRACKING_UNAVAILABLE_BATTERY) {
    throw new Error("Tracking advertisement battery field must be 0 to 100 or unavailable");
  }
  return {
    protocolVersion: header >> 6,
    flags: header & 0x3f,
    rotatingTagId: bytes.subarray(1, 9).toString("base64url"),
    epochCounter: bytes.readUInt16BE(9),
    eventCounter: bytes.readUInt16BE(11),
    batteryPercent: battery === TRACKING_UNAVAILABLE_BATTERY ? null : battery,
    authenticator: bytes.subarray(14, 18).toString("base64url"),
    rawPayload: bytes.toString("base64url"),
  };
}

export function verifyTrackingAdvertisement(
  secret: Uint8Array,
  advertisement: Pick<TrackingAdvertisement,
    "protocolVersion" | "flags" | "rotatingTagId" | "epochCounter" | "eventCounter" | "batteryPercent" | "authenticator">,
): boolean {
  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = strictBase64Url(advertisement.authenticator, TRACKING_AUTHENTICATOR_BYTES, "authenticator");
    expected = Buffer.from(trackingAuthenticator(secret, trackingAdvertisementMessage(advertisement)), "base64url");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
