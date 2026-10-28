import { createHash } from "node:crypto";
import type { HouseLocation } from "@climate-twin/contracts";

/** Opaque stable key prevents old-location weather entering a new calibration. */
export function outdoorLocationKey(location?: HouseLocation): string {
  if (!location) return "unlocated";
  const normalized = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
  return `geo:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}
