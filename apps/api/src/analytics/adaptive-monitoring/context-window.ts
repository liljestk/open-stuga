import { HOUR_MS } from "../forecast/models.js";

export const ADAPTIVE_CONTEXT_GUARD_HOURS = 2;

export function contextGuardWindow(occurredAt: number): { from: number; to: number } {
  const from = Math.ceil(occurredAt / HOUR_MS) * HOUR_MS;
  return { from, to: from + ADAPTIVE_CONTEXT_GUARD_HOURS * HOUR_MS };
}
