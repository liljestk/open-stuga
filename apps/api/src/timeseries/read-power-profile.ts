import type { Sensor } from "@climate-twin/contracts";
import { propertyPowerProfile } from "../energy-optimizer-power.js";
import type { MeasurementWindowQuery } from "./types.js";
import { IncompleteTelemetryHistoryError } from "./read-support.js";

export type PowerProfile = ReturnType<typeof propertyPowerProfile>;
export interface LocalPowerProfileQuery extends MeasurementWindowQuery {
  sensors: readonly Sensor[];
  profileFrom: string;
  excludeSynthetic: boolean;
}

/** The part of the local telemetry reader a power profile reads from. */
export interface PowerProfileLocalReader {
  isRealDataMode(): boolean;
  optimizerPowerProfileAsync?(query: LocalPowerProfileQuery): Promise<PowerProfile>;
}

export async function readPowerProfile(input: {
  local: PowerProfileLocalReader;
  localOnly: boolean;
  localComplete: boolean;
  query: MeasurementWindowQuery;
  sensors: readonly Sensor[];
  profileFrom: string;
  readWindow: () => Promise<{ records: Parameters<typeof propertyPowerProfile>[1] }>;
}): Promise<PowerProfile> {
  input.query.signal?.throwIfAborted();
  if (input.localOnly && input.local.optimizerPowerProfileAsync) {
    if (!input.localComplete) throw new IncompleteTelemetryHistoryError("not-configured");
    return input.local.optimizerPowerProfileAsync({ ...input.query, sensors: input.sensors,
      profileFrom: input.profileFrom, excludeSynthetic: input.local.isRealDataMode() });
  }
  const { records } = await input.readWindow();
  return records.length >= (input.query.limit ?? 200_000) ? { baseline: null, peak: null }
    : propertyPowerProfile(input.sensors, records, Date.parse(input.profileFrom), Date.parse(input.query.to));
}
