import type { ClimateDatabase } from "../db.js";
import { propertyPowerProfile } from "../energy-optimizer-power.js";
import type { LocalPowerProfileQuery, PowerProfile } from "../timeseries/read-power-profile.js";

/** Return only the profile; large raw windows and sorting stay in the worker. */
export function localPowerProfile(database: Pick<ClimateDatabase, "measurementWindow">, query: LocalPowerProfileQuery): PowerProfile {
  const samples = database.measurementWindow([...query.sensorIds], ["power"], query.from, query.to, query.limit)
    .filter(sample => !query.excludeSynthetic || (sample.source !== "mock" && sample.source !== "replay"));
  return samples.length >= (query.limit ?? 200_000) ? { baseline: null, peak: null }
    : propertyPowerProfile(query.sensors, samples, Date.parse(query.profileFrom), Date.parse(query.to));
}
