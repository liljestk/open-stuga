import { createHash } from "node:crypto";
import {
  TRACKING_PROFILE_SCHEMA_VERSION,
  type TrackingCompatibilityAssessment,
  type TrackingCompatibilityAssessmentInput,
  type TrackingPlatformCondition,
  type TrackingProfile,
  type TrackingProfileEnvelope,
  type TrackingProfileManifest,
} from "@climate-twin/contracts";

const generatedAt = "2026-07-01T00:00:00.000Z";

const phoneAndGatewaySupport: TrackingPlatformCondition[] = [
  {
    platform: "ios",
    scanContexts: ["foreground", "foreground-find", "background"],
    minimumOsVersion: "17.0",
    requiresServiceFilter: true,
    notes: ["Background discovery is conditional on the profile service filter and current iOS execution state."],
  },
  {
    platform: "android",
    scanContexts: ["foreground", "foreground-find", "background", "dedicated-android-gateway"],
    minimumOsVersion: "10",
    notes: ["Background behavior depends on device power policy and the selected scan delivery mode."],
  },
  {
    platform: "gateway",
    scanContexts: ["fixed-gateway"],
    notes: [],
  },
];

const gatewayOnlySupport: TrackingPlatformCondition[] = [
  {
    platform: "gateway",
    scanContexts: ["fixed-gateway"],
    notes: ["A generic manufacturer frame has no portable mobile background filter."],
  },
  {
    platform: "android",
    scanContexts: ["foreground", "foreground-find", "dedicated-android-gateway"],
    minimumOsVersion: "10",
    notes: ["Generic discovery is intentionally foreground-only outside dedicated gateway mode."],
  },
  {
    platform: "ios",
    scanContexts: ["foreground", "foreground-find"],
    minimumOsVersion: "17.0",
    notes: ["Generic discovery is intentionally foreground-only."],
  },
];

const builtins: TrackingProfile[] = [
  {
    schemaVersion: TRACKING_PROFILE_SCHEMA_VERSION,
    id: "org.bluetooth.ibeacon",
    version: "2026.07",
    displayName: "iBeacon",
    description: "Apple manufacturer-data beacon with UUID, major, and minor identity.",
    serviceUuids: [],
    match: [{ source: "manufacturerData", key: "004c", offset: 0, value: "0215" }],
    fields: [
      { name: "proximityUuid", source: "manufacturerData", key: "004c", offset: 2, length: 16, encoding: "uuid" },
      { name: "major", source: "manufacturerData", key: "004c", offset: 18, length: 2, encoding: "uint16be" },
      { name: "minor", source: "manufacturerData", key: "004c", offset: 20, length: 2, encoding: "uint16be" },
      { name: "txPower", source: "manufacturerData", key: "004c", offset: 22, length: 1, encoding: "int8" },
    ],
    identity: {
      namespace: "org.bluetooth.ibeacon",
      namespaceVersion: 1,
      scope: "GLOBAL",
      strength: "STATIC_CLEAR",
      fields: ["proximityUuid", "major", "minor"],
      separator: ":",
    },
    capabilities: {
      trackabilityTier: "PROPERTY_BEACON",
      discoverability: "BACKGROUND_CONDITIONAL",
      backgroundSupport: "CONDITIONAL",
      mapCapability: "ZONE",
      connectable: false,
      reportsBattery: false,
      reportsMotion: false,
      reportsCounter: false,
    },
    platformSupport: gatewayOnlySupport,
    maximumFrameBytes: 31,
    deprecatedAt: null,
  },
  {
    schemaVersion: TRACKING_PROFILE_SCHEMA_VERSION,
    id: "org.eddystone.uid",
    version: "2026.07",
    displayName: "Eddystone UID",
    description: "Eddystone UID service-data beacon with namespace and instance identity.",
    serviceUuids: ["feaa"],
    match: [{ source: "serviceData", key: "feaa", offset: 0, value: "00" }],
    fields: [
      { name: "txPower", source: "serviceData", key: "feaa", offset: 1, length: 1, encoding: "int8" },
      { name: "namespace", source: "serviceData", key: "feaa", offset: 2, length: 10, encoding: "hex" },
      { name: "instance", source: "serviceData", key: "feaa", offset: 12, length: 6, encoding: "hex" },
    ],
    identity: {
      namespace: "org.eddystone.uid",
      namespaceVersion: 1,
      scope: "GLOBAL",
      strength: "STATIC_CLEAR",
      fields: ["namespace", "instance"],
      separator: ":",
    },
    capabilities: {
      trackabilityTier: "PROPERTY_BEACON",
      discoverability: "BACKGROUND_CONDITIONAL",
      backgroundSupport: "CONDITIONAL",
      mapCapability: "ZONE",
      connectable: false,
      reportsBattery: false,
      reportsMotion: false,
      reportsCounter: false,
    },
    platformSupport: phoneAndGatewaySupport,
    maximumFrameBytes: 31,
    deprecatedAt: null,
  },
  {
    schemaVersion: TRACKING_PROFILE_SCHEMA_VERSION,
    id: "org.stugu.generic-service-data",
    version: "2026.07",
    displayName: "Stable service-data beacon",
    description: "Explicit enrollment profile for a stable service UUID and service-data value.",
    serviceUuids: [],
    match: [],
    fields: [
      { name: "serviceUuid", source: "serviceData", key: "*", encoding: "utf8" },
      { name: "serviceData", source: "serviceData", key: "*", encoding: "hex" },
    ],
    identity: {
      namespace: "org.stugu.generic-service-data",
      namespaceVersion: 1,
      scope: "GLOBAL",
      strength: "STATIC_CLEAR",
      fields: ["serviceUuid", "serviceData"],
      separator: ":",
    },
    capabilities: {
      trackabilityTier: "PROPERTY_BEACON",
      discoverability: "FOREGROUND",
      backgroundSupport: "FOREGROUND_ONLY",
      mapCapability: "AREA",
      connectable: false,
      reportsBattery: false,
      reportsMotion: false,
      reportsCounter: false,
    },
    platformSupport: gatewayOnlySupport,
    maximumFrameBytes: 255,
    deprecatedAt: null,
  },
  {
    schemaVersion: TRACKING_PROFILE_SCHEMA_VERSION,
    id: "org.stugu.generic-manufacturer-data",
    version: "2026.07",
    displayName: "Stable manufacturer-data beacon",
    description: "Explicit enrollment profile for a stable company identifier and manufacturer-data value.",
    serviceUuids: [],
    match: [],
    fields: [
      { name: "companyId", source: "manufacturerData", key: "*", encoding: "utf8" },
      { name: "manufacturerData", source: "manufacturerData", key: "*", encoding: "hex" },
    ],
    identity: {
      namespace: "org.stugu.generic-manufacturer-data",
      namespaceVersion: 1,
      scope: "GLOBAL",
      strength: "STATIC_CLEAR",
      fields: ["companyId", "manufacturerData"],
      separator: ":",
    },
    capabilities: {
      trackabilityTier: "PROPERTY_BEACON",
      discoverability: "FOREGROUND",
      backgroundSupport: "FOREGROUND_ONLY",
      mapCapability: "AREA",
      connectable: false,
      reportsBattery: false,
      reportsMotion: false,
      reportsCounter: false,
    },
    platformSupport: gatewayOnlySupport,
    maximumFrameBytes: 255,
    deprecatedAt: null,
  },
  {
    schemaVersion: TRACKING_PROFILE_SCHEMA_VERSION,
    id: "org.stugu.generic-gatt-observer-local",
    version: "2026.07",
    displayName: "Observer-local GATT peripheral",
    description: "Foreground-only identity tied to one observer installation.",
    serviceUuids: [],
    match: [],
    fields: [
      { name: "peripheralIdentifier", source: "peripheralIdentifier", encoding: "utf8" },
    ],
    identity: {
      namespace: "org.stugu.generic-gatt-observer-local",
      namespaceVersion: 1,
      scope: "OBSERVER",
      strength: "HEURISTIC",
      fields: ["peripheralIdentifier"],
    },
    capabilities: {
      trackabilityTier: "OBSERVER_LOCAL",
      discoverability: "FOREGROUND",
      backgroundSupport: "FOREGROUND_ONLY",
      mapCapability: "NEARBY",
      connectable: true,
      reportsBattery: false,
      reportsMotion: false,
      reportsCounter: false,
    },
    platformSupport: [
      {
        platform: "ios",
        scanContexts: ["foreground", "foreground-find"],
        minimumOsVersion: "17.0",
        notes: ["The peripheral identifier is local to one app installation."],
      },
      {
        platform: "android",
        scanContexts: ["foreground", "foreground-find"],
        minimumOsVersion: "10",
        notes: ["The binding is scoped to one observer because addresses may rotate."],
      },
    ],
    maximumFrameBytes: 255,
    deprecatedAt: null,
  },
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function envelope(profile: TrackingProfile): TrackingProfileEnvelope {
  return {
    profile,
    source: "BUILTIN",
    integrity: {
      digestAlgorithm: "SHA-256",
      digest: createHash("sha256").update(canonical(profile)).digest("base64url"),
      signatureAlgorithm: null,
      keyId: null,
      signature: null,
    },
  };
}

export const BUILTIN_TRACKING_PROFILES = builtins.map(envelope);

export function trackingProfileManifest(): TrackingProfileManifest {
  return {
    schemaVersion: TRACKING_PROFILE_SCHEMA_VERSION,
    registryVersion: "2026.07",
    generatedAt,
    profiles: BUILTIN_TRACKING_PROFILES,
  };
}

export function trackingProfile(profileId: string, version?: string): TrackingProfileEnvelope | null {
  return BUILTIN_TRACKING_PROFILES.find((item) => (
    item.profile.id === profileId && (version === undefined || item.profile.version === version)
  )) ?? null;
}

function versionParts(value: string): number[] {
  return value.split(/[._-]/u).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function assessTrackingCompatibility(
  input: TrackingCompatibilityAssessmentInput,
  now = new Date(),
): TrackingCompatibilityAssessment | null {
  const registered = trackingProfile(input.profileId, input.profileVersion);
  if (!registered) return null;
  const profile = registered.profile;
  const platform = profile.platformSupport.find((support) => support.platform === input.platform);
  const contextSupported = platform?.scanContexts.includes(input.scanContext) ?? false;
  const minimumSupported = !platform?.minimumOsVersion
    || !input.osVersion
    || compareVersions(input.osVersion, platform.minimumOsVersion) >= 0;
  const maximumSupported = !platform?.maximumOsVersion
    || !input.osVersion
    || compareVersions(input.osVersion, platform.maximumOsVersion) <= 0;
  let status: TrackingCompatibilityAssessment["status"];
  if (profile.capabilities.trackabilityTier === "DISCOVERED_ONLY") status = "DISCOVERED_ONLY";
  else if (profile.identity.scope === "OBSERVER") status = contextSupported ? "OBSERVER_LOCAL_ONLY" : "UNSUPPORTED";
  else if (!platform || !contextSupported || !minimumSupported || !maximumSupported) status = "UNSUPPORTED";
  else if (profile.capabilities.backgroundSupport === "CONDITIONAL") status = "CONDITIONAL";
  else status = "SUPPORTED";
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    status,
    trackabilityTier: profile.capabilities.trackabilityTier,
    identityScope: profile.identity.scope,
    identityStrength: profile.identity.strength,
    backgroundSupport: profile.capabilities.backgroundSupport,
    mapCapability: profile.capabilities.mapCapability,
    conditions: platform?.notes ?? ["This profile is unavailable on the selected platform."],
    assessedAt: now.toISOString(),
  };
}
