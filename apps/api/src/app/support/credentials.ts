import { HttpError } from "../../http-error.js";
import { timingSafeEqual } from "node:crypto";

export function credentialString(body: Record<string, unknown>, key: string, maximumLength: number, trim = false): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return trim ? value.trim() : value;
}

export function keyMatches(provided: string, expected: string): boolean {
  const first = Buffer.from(provided);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}
