import { bodyObject, enumValue, optionalBoolean, requiredNumber, requiredString } from "../../request-fields.js";
import type { ActionPlaybookInput, ActionRunStartInput } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";
import { measurementId } from "./measurement-fields.js";

export function parseActionPlaybookInput(value: unknown, partial = false): ActionPlaybookInput | Partial<ActionPlaybookInput> {
  const body = bodyObject(value);
  const text = (key: "name" | "description"): string | undefined => {
    if (body[key] === undefined && partial) return undefined;
    const result = requiredString(body, key);
    if (Array.from(result).length > (key === "name" ? 160 : 2_000)) {
      throw new HttpError(400, "INVALID_FIELD", `${key} is too long`);
    }
    return result;
  };
  const instructions = body.instructions === undefined && partial ? undefined : (() => {
    if (!Array.isArray(body.instructions) || body.instructions.length < 1 || body.instructions.length > 20
      || body.instructions.some((item) => typeof item !== "string" || !item.trim() || item.length > 500)) {
      throw new HttpError(400, "INVALID_FIELD", "instructions must contain 1–20 concise steps");
    }
    return body.instructions.map((item) => (item as string).trim());
  })();
  const numeric = (key: "minimumImprovement" | "targetValue" | "waitSeconds" | "verificationWindowSeconds"): number | null | undefined => {
    if (body[key] === undefined) return partial ? undefined : key === "targetValue" ? null : requiredNumber(body, key);
    if (body[key] === null && key === "targetValue") return null;
    return requiredNumber(body, key);
  };
  return {
    ...(body.id !== undefined ? { id: requiredString(body, "id") } : {}),
    ...(text("name") !== undefined ? { name: text("name")! } : {}),
    ...(text("description") !== undefined ? { description: text("description")! } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(body.metric !== undefined || !partial ? { metric: measurementId(body.metric) } : {}),
    ...(body.goal !== undefined || !partial ? { goal: enumValue(body.goal, ["decrease", "increase", "below", "above"] as const, "goal") } : {}),
    ...(numeric("minimumImprovement") !== undefined ? { minimumImprovement: numeric("minimumImprovement")! } : {}),
    ...(numeric("targetValue") !== undefined ? { targetValue: numeric("targetValue") ?? null } : {}),
    ...(numeric("waitSeconds") !== undefined ? { waitSeconds: numeric("waitSeconds")! } : {}),
    ...(numeric("verificationWindowSeconds") !== undefined ? { verificationWindowSeconds: numeric("verificationWindowSeconds")! } : {}),
    ...(body.enabled !== undefined ? { enabled: optionalBoolean(body, "enabled") as boolean } : {}),
  } as ActionPlaybookInput | Partial<ActionPlaybookInput>;
}

export function parseActionRunStart(value: unknown): ActionRunStartInput {
  const body = bodyObject(value);
  return {
    playbookId: requiredString(body, "playbookId"),
    sensorId: requiredString(body, "sensorId"),
    ...(body.alertEventId !== undefined ? { alertEventId: body.alertEventId === null ? null : requiredString(body, "alertEventId") } : {}),
    ...(body.maintenanceTaskId !== undefined ? { maintenanceTaskId: body.maintenanceTaskId === null ? null : requiredString(body, "maintenanceTaskId") } : {}),
    ...(body.operatorNote !== undefined ? { operatorNote: body.operatorNote === null ? null : requiredString(body, "operatorNote") } : {}),
  };
}
