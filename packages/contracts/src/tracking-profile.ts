import type {
  TrackingLocalAdvertisementFrame,
  TrackingProfile,
  TrackingProfileField,
  TrackingProfileMatch,
  TrackingProfileMatchRule,
} from "./tracking.js";

export interface TrackingProfileValidationIssue {
  path: string;
  message: string;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-z]/gu, "");
}

function bytesFromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  try {
    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesFromHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(value)) return null;
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function mappedValue(
  values: Record<string, string>,
  requestedKey: string | undefined,
): { key: string; bytes: Uint8Array } | null {
  const entries = Object.entries(values);
  const selected = requestedKey === "*"
    ? entries.length === 1 ? entries[0] : undefined
    : entries.find(([key]) => normalizedKey(key) === normalizedKey(requestedKey ?? ""));
  if (!selected) return null;
  const bytes = bytesFromBase64Url(selected[1]);
  return bytes ? { key: selected[0], bytes } : null;
}

function ruleBytes(
  frame: TrackingLocalAdvertisementFrame,
  rule: TrackingProfileMatchRule,
): Uint8Array | null {
  if (rule.source === "localName") {
    return frame.localName ? new TextEncoder().encode(frame.localName) : null;
  }
  return mappedValue(frame[rule.source], rule.key)?.bytes ?? null;
}

function matchesRule(frame: TrackingLocalAdvertisementFrame, rule: TrackingProfileMatchRule): boolean {
  const source = ruleBytes(frame, rule);
  const expected = bytesFromHex(rule.value);
  const mask = rule.mask ? bytesFromHex(rule.mask) : null;
  const offset = rule.offset ?? 0;
  if (!source || !expected || (rule.mask && !mask) || offset < 0 || offset + expected.length > source.length) return false;
  if (mask && mask.length !== expected.length) return false;
  return expected.every((value, index) => {
    const bitmask = mask?.[index] ?? 0xff;
    return ((source[offset + index] ?? 0) & bitmask) === (value & bitmask);
  });
}

function fieldSource(
  frame: TrackingLocalAdvertisementFrame,
  field: TrackingProfileField,
): { key: string | null; bytes: Uint8Array } | null {
  if (field.source === "manufacturerData" || field.source === "serviceData") {
    const selected = mappedValue(frame[field.source], field.key);
    return selected ? { key: selected.key, bytes: selected.bytes } : null;
  }
  const text = frame[field.source];
  return text === null ? null : { key: null, bytes: new TextEncoder().encode(text) };
}

function decodeField(
  frame: TrackingLocalAdvertisementFrame,
  field: TrackingProfileField,
): string | number | null {
  const source = fieldSource(frame, field);
  if (!source) return null;
  if (field.key === "*" && field.encoding === "utf8") return source.key;
  const offset = field.offset ?? 0;
  const length = field.length ?? (source.bytes.length - offset);
  if (offset < 0 || length < 0 || offset + length > source.bytes.length) return null;
  const bytes = source.bytes.slice(offset, offset + length);
  switch (field.encoding) {
    case "hex": return hex(bytes);
    case "utf8": return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    case "uint8": return bytes.length === 1 ? bytes[0] ?? null : null;
    case "int8": return bytes.length === 1 ? ((bytes[0] ?? 0) << 24) >> 24 : null;
    case "uint16be": return bytes.length === 2 ? ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0) : null;
    case "uint16le": return bytes.length === 2 ? (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) : null;
    case "uuid": {
      if (bytes.length !== 16) return null;
      const value = hex(bytes);
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    }
  }
}

export function validateTrackingProfile(profile: TrackingProfile): TrackingProfileValidationIssue[] {
  const issues: TrackingProfileValidationIssue[] = [];
  const names = new Set<string>();
  if (!profile.id.trim()) issues.push({ path: "id", message: "Profile id is required." });
  if (!profile.version.trim()) issues.push({ path: "version", message: "Profile version is required." });
  if (!Number.isSafeInteger(profile.identity.namespaceVersion) || profile.identity.namespaceVersion < 1) {
    issues.push({ path: "identity.namespaceVersion", message: "Namespace version must be a positive integer." });
  }
  if (!Number.isSafeInteger(profile.maximumFrameBytes)
    || profile.maximumFrameBytes < 1
    || profile.maximumFrameBytes > 512) {
    issues.push({ path: "maximumFrameBytes", message: "Frame limit must be from 1 to 512 bytes." });
  }
  profile.fields.forEach((field, index) => {
    if (!field.name.trim() || names.has(field.name)) {
      issues.push({ path: `fields.${index}.name`, message: "Field names must be non-empty and unique." });
    }
    names.add(field.name);
    if ((field.offset ?? 0) < 0 || (field.length ?? 0) < 0) {
      issues.push({ path: `fields.${index}`, message: "Field ranges cannot be negative." });
    }
    if ((field.offset ?? 0) + (field.length ?? 0) > profile.maximumFrameBytes) {
      issues.push({ path: `fields.${index}`, message: "Field exceeds the declared frame limit." });
    }
    if ((field.source === "manufacturerData" || field.source === "serviceData") && !field.key) {
      issues.push({ path: `fields.${index}.key`, message: "Mapped advertisement fields require a key." });
    }
  });
  for (const name of profile.identity.fields) {
    if (!names.has(name)) issues.push({ path: "identity.fields", message: `Unknown identity field ${name}.` });
  }
  profile.match.forEach((rule, index) => {
    const value = bytesFromHex(rule.value);
    const mask = rule.mask ? bytesFromHex(rule.mask) : null;
    if (!value || (rule.mask && (!mask || mask.length !== value.length))) {
      issues.push({ path: `match.${index}`, message: "Match values and masks must be equal-length hexadecimal bytes." });
    }
    if ((rule.source === "manufacturerData" || rule.source === "serviceData") && !rule.key) {
      issues.push({ path: `match.${index}.key`, message: "Mapped match rules require a key." });
    }
  });
  return issues;
}

export function parseTrackingAdvertisement(
  frame: TrackingLocalAdvertisementFrame,
  profile: TrackingProfile,
): TrackingProfileMatch | null {
  if (validateTrackingProfile(profile).length > 0 || !profile.match.every((rule) => matchesRule(frame, rule))) {
    return null;
  }
  const parsed = new Map<string, string | number>();
  for (const field of profile.fields) {
    try {
      const value = decodeField(frame, field);
      if (value === null) {
        if (!field.optional) return null;
      } else {
        parsed.set(field.name, typeof value === "number" && field.scale ? value * field.scale : value);
      }
    } catch {
      if (!field.optional) return null;
    }
  }
  const identityFields: Record<string, string> = {};
  for (const field of profile.identity.fields) {
    const value = parsed.get(field);
    if (value === undefined) return null;
    identityFields[field] = String(value);
  }
  const identityValues = profile.identity.fields.map((field) => identityFields[field] ?? "");
  const canonicalIdentity = profile.identity.scope === "NONE"
    ? null
    : [
      profile.identity.namespace,
      String(profile.identity.namespaceVersion),
      identityValues.join(profile.identity.separator ?? "\u001f"),
    ].join("\u001e");
  const telemetry = Object.fromEntries(
    [...parsed].filter(([name]) => !profile.identity.fields.includes(name)),
  );
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    identityFields,
    canonicalIdentity,
    telemetry,
  };
}

/** Generic empty-match profiles are excluded unless the caller is in an explicit enrollment flow. */
export function matchTrackingProfiles(
  frame: TrackingLocalAdvertisementFrame,
  profiles: TrackingProfile[],
  includeEnrollmentProfiles = false,
): TrackingProfileMatch[] {
  return profiles.flatMap((profile) => {
    if (!includeEnrollmentProfiles && profile.match.length === 0) return [];
    const match = parseTrackingAdvertisement(frame, profile);
    return match ? [match] : [];
  });
}
