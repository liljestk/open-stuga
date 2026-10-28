import { optionalBoolean, optionalString, requiredNumber, requiredString } from "../../request-fields.js";
import type { HouseLocation, HouseMapPlacement } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";

export function houseLocationValue(value: unknown): HouseLocation;

export function houseLocationValue(value: unknown, allowNull: true): HouseLocation | null;

export function houseLocationValue(value: unknown, allowNull = false): HouseLocation | null {
  if (value === null && allowNull) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_FIELD", "location must be an object with latitude and longitude");
  }
  const body = value as Record<string, unknown>;
  const latitude = requiredNumber(body, "latitude");
  const longitude = requiredNumber(body, "longitude");
  const label = optionalString(body, "label")?.trim();
  const countryCode = optionalString(body, "countryCode")?.trim().toUpperCase();
  const source = optionalString(body, "source")?.trim() as HouseLocation["source"];
  const confidence = optionalString(body, "confidence")?.trim() as HouseLocation["confidence"];
  const discoveredAt = optionalString(body, "discoveredAt")?.trim();
  const userOverridden = optionalBoolean(body, "userOverridden");
  return {
    latitude,
    longitude,
    ...(label ? { label } : {}),
    ...(countryCode ? { countryCode } : {}),
    ...(source ? { source } : {}),
    ...(confidence ? { confidence } : {}),
    ...(discoveredAt ? { discoveredAt } : {}),
    ...(userOverridden !== undefined ? { userOverridden } : {}),
  };
}

export function houseMapPlacementValue(value: unknown): HouseMapPlacement;

export function houseMapPlacementValue(value: unknown, allowNull: true): HouseMapPlacement | null;

export function houseMapPlacementValue(value: unknown, allowNull = false): HouseMapPlacement | null {
  if (value === null && allowNull) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      "mapPlacement must be an object with latitude, longitude, and metersPerPlanUnit",
    );
  }
  const body = value as Record<string, unknown>;
  const latitude = requiredNumber(body, "latitude");
  const longitude = requiredNumber(body, "longitude");
  const metersPerPlanUnit = requiredNumber(body, "metersPerPlanUnit");
  const footprintFloorId = body.footprintFloorId === undefined
    ? undefined
    : requiredString(body, "footprintFloorId");
  return { latitude, longitude, metersPerPlanUnit, ...(footprintFloorId ? { footprintFloorId } : {}) };
}
