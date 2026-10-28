import type { HouseWeather } from "@climate-twin/contracts";
import { ClimateDatabase, outdoorLocationKey } from "../../db.js";
import { DataModeCoordinator } from "../../services.js";

export function persistWeatherObservation(database: ClimateDatabase, weather: HouseWeather, dataMode?: DataModeCoordinator): void {
  if (weather.stale || !weather.current || !Number.isFinite(weather.current.temperatureC)) return;
  database.upsertCurrentOutdoorTemperatureSample({
    houseId: weather.houseId,
    locationKey: outdoorLocationKey(weather.location),
    timestamp: weather.current.timestamp,
    temperatureC: weather.current.temperatureC as number,
    source: weather.provider === "fmi" ? "fmi-observation" : "open-meteo-current",
    fetchedAt: weather.fetchedAt,
    stationId: weather.observationStation?.id ?? null,
    stationName: weather.observationStation?.name ?? null,
    conditions: weather.current,
  });
  // The repository performs the irreversible latch only after verifying the
  // location key. Synchronize runtime listeners after that guarded write.
  dataMode?.synchronize();
}
