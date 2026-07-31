import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { Nexus433HostCapability } from "@climate-twin/contracts";

const unavailable = (): Nexus433HostCapability => ({
  available: false,
  gpioChip: null,
  gpioLine: null,
});

export function loadNexus433HostCapability(path: string | null | undefined): Nexus433HostCapability {
  if (!path || !existsSync(path)) return unavailable();
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1_024) {
    throw new Error("STUGA_HOST_CAPABILITIES_FILE must be a small regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("STUGA_HOST_CAPABILITIES_FILE must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("STUGA_HOST_CAPABILITIES_FILE has an invalid document");
  }
  const document = value as Record<string, unknown>;
  if (document.schema !== "stugu-host-capabilities/v1"
    || !document.capabilities || typeof document.capabilities !== "object"
    || Array.isArray(document.capabilities)) {
    throw new Error("STUGA_HOST_CAPABILITIES_FILE uses an unsupported schema");
  }
  const capability = (document.capabilities as Record<string, unknown>).nexus433;
  if (capability === undefined) return unavailable();
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw new Error("The Nexus433 host capability is invalid");
  }
  const record = capability as Record<string, unknown>;
  if (record.state !== "available"
    || typeof record.revision !== "string" || !/^\d{1,10}$/u.test(record.revision)
    || typeof record.gpioChip !== "string" || !/^\/dev\/gpiochip\d{1,3}$/u.test(record.gpioChip)
    || typeof record.gpioLine !== "number" || !Number.isInteger(record.gpioLine)
    || record.gpioLine < 0 || record.gpioLine > 255) {
    throw new Error("The Nexus433 host capability is invalid");
  }
  return { available: true, gpioChip: record.gpioChip, gpioLine: record.gpioLine };
}
