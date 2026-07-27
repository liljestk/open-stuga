import {
  matchTrackingProfiles,
  parseTrackingAdvertisement,
  validateTrackingProfile,
  type TrackingLocalAdvertisementFrame,
  type TrackingProfile,
} from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import { trackingProfile, trackingProfileManifest } from "../src/tracking/profiles.js";

function frame(overrides: Partial<TrackingLocalAdvertisementFrame> = {}): TrackingLocalAdvertisementFrame {
  return {
    serviceUuids: [],
    manufacturerData: {},
    serviceData: {},
    localName: null,
    peripheralIdentifier: null,
    address: null,
    connectable: null,
    rssi: -63,
    observedAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

describe("tracking profile registry and parser", () => {
  it("extracts the declared iBeacon identity without executing profile code", () => {
    const profile = trackingProfile("org.bluetooth.ibeacon", "2026.07")!.profile;
    const bytes = Buffer.concat([
      Buffer.from("0215", "hex"),
      Buffer.from("7f7e4b102f5f4fc9a66a06db0fa042f8", "hex"),
      Buffer.from([0x00, 0x01, 0x00, 0x07, 0xc5]),
    ]);
    const result = parseTrackingAdvertisement(frame({
      manufacturerData: { "004C": bytes.toString("base64url") },
    }), profile);

    expect(result).toEqual({
      profileId: "org.bluetooth.ibeacon",
      profileVersion: "2026.07",
      identityFields: {
        proximityUuid: "7f7e4b10-2f5f-4fc9-a66a-06db0fa042f8",
        major: "1",
        minor: "7",
      },
      canonicalIdentity: "org.bluetooth.ibeacon\u001e1\u001e7f7e4b10-2f5f-4fc9-a66a-06db0fa042f8:1:7",
      telemetry: { txPower: -59 },
    });
  });

  it("does not auto-match generic enrollment profiles", () => {
    const profiles = trackingProfileManifest().profiles.map((item) => item.profile);
    const unknown = frame({
      manufacturerData: { "1234": Buffer.from("01020304", "hex").toString("base64url") },
    });
    expect(matchTrackingProfiles(unknown, profiles)).toEqual([]);
    expect(matchTrackingProfiles(unknown, profiles, true)).toEqual([
      expect.objectContaining({
        profileId: "org.stugu.generic-manufacturer-data",
        identityFields: { companyId: "1234", manufacturerData: "01020304" },
      }),
    ]);
  });

  it("rejects unsafe field ranges and undefined identity fields", () => {
    const valid = trackingProfile("org.eddystone.uid", "2026.07")!.profile;
    const invalid: TrackingProfile = {
      ...valid,
      maximumFrameBytes: 8,
      identity: { ...valid.identity, fields: ["missing"] },
    };
    expect(validateTrackingProfile(invalid)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "identity.fields" }),
      expect.objectContaining({ path: "fields.1" }),
    ]));
    expect(parseTrackingAdvertisement(frame(), invalid)).toBeNull();
  });

  it("publishes detached content digests", () => {
    const manifest = trackingProfileManifest();
    expect(manifest.profiles).not.toHaveLength(0);
    for (const item of manifest.profiles) {
      expect(item.profile).not.toHaveProperty("signature");
      expect(item.integrity.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
  });
});
