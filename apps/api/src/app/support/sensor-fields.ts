import { bodyObject, enumValue, optionalBoolean, presentFields, requiredNumber, requiredString } from "../../request-fields.js";
import type { SensorUpdate } from "../../db.js";
import { HttpError } from "../../http-error.js";
import { measurementStringMap } from "./measurement-fields.js";

const text = (body: Record<string, unknown>, key: string) => requiredString(body, key);
const nullableText = (body: Record<string, unknown>, key: string) => (body[key] === null ? null : requiredString(body, key));
const number = (body: Record<string, unknown>, key: string) => requiredNumber(body, key);

/** Every field a sensor patch may change, with its validation. */
const SENSOR_PATCH_FIELDS = {
  houseId: text, floorId: text, name: text, room: text, model: text,
  x: number, y: number, z: number,
  roomId: nullableText,
  temperatureEntityId: text, humidityEntityId: text, batteryEntityId: text,
  tpLinkDeviceId: nullableText, tpLinkConnectionId: nullableText,
  measurementEntityIds: (body: Record<string, unknown>) => measurementStringMap(body.measurementEntityIds, "measurementEntityIds"),
  energyMeterRole: (body: Record<string, unknown>) => enumValue(body.energyMeterRole, ["whole_home", "submeter", "standalone"] as const, "energyMeterRole"),
  tags: (body: Record<string, unknown>) => {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
    return body.tags as string[];
  },
  enabled: (body: Record<string, unknown>) => optionalBoolean(body, "enabled") as boolean,
};

export function parseSensorPatch(value: unknown): SensorUpdate {
  return presentFields(bodyObject(value), SENSOR_PATCH_FIELDS);
}
