import { describe, expect, it } from "vitest";
import {
  encodeTrackingAdvertisement,
  parseTrackingAdvertisement,
  rotatingTagId,
  trackingEpochCounter,
  TRACKING_FLAGS,
  verifyTrackingAdvertisement,
} from "../src/tracking/protocol.js";

describe("Stuga BLE tracking protocol", () => {
  it("round-trips and authenticates the compact advertisement", () => {
    const secret = Buffer.alloc(32, 0x42);
    const advertisement = encodeTrackingAdvertisement(secret, {
      flags: TRACKING_FLAGS.moving | TRACKING_FLAGS.lowBattery,
      epochCounter: 12_345,
      eventCounter: 456,
      batteryPercent: 18,
    });

    expect(Buffer.from(advertisement.rawPayload, "base64url")).toHaveLength(18);
    expect(parseTrackingAdvertisement(advertisement.rawPayload)).toEqual(advertisement);
    expect(verifyTrackingAdvertisement(secret, advertisement)).toBe(true);
    expect(verifyTrackingAdvertisement(Buffer.alloc(32, 0x43), advertisement)).toBe(false);
    expect(verifyTrackingAdvertisement(secret, {
      ...advertisement,
      eventCounter: advertisement.eventCounter + 1,
    })).toBe(false);
  });

  it("rotates identifiers by epoch without broadcasting permanent identity", () => {
    const secret = Buffer.alloc(32, 0x11);
    expect(rotatingTagId(secret, 1, 91)).not.toBe(rotatingTagId(secret, 1, 92));
    expect(trackingEpochCounter(new Date("2026-07-25T19:15:00.000Z"), 15))
      .toBe(trackingEpochCounter(new Date("2026-07-25T19:29:59.999Z"), 15));
  });

  it("rejects reserved battery values rather than treating them as percentages", () => {
    const advertisement = encodeTrackingAdvertisement(Buffer.alloc(32, 1), {
      epochCounter: 1,
      eventCounter: 1,
      batteryPercent: 50,
    });
    const bytes = Buffer.from(advertisement.rawPayload, "base64url");
    bytes.writeUInt8(200, 13);
    expect(() => parseTrackingAdvertisement(bytes)).toThrow(/battery/i);
  });
});
