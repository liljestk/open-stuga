import type { HouseWeather } from "@climate-twin/contracts";
import type { StoredWeatherSnapshot } from "../weather-snapshot-types.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    getWeatherSnapshot(houseId: string, locationKey: string): StoredWeatherSnapshot | null;
    saveWeatherSnapshot(weather: HouseWeather, locationKey: string, attemptedAt?: string): StoredWeatherSnapshot;
    noteWeatherSnapshotFailure(
      houseId: string,
      locationKey: string,
      error: unknown,
      attemptedAt?: string,
    ): StoredWeatherSnapshot;
  }

  interface ClimateDatabaseCore {
    getWeatherSnapshot(houseId: string, locationKey: string): StoredWeatherSnapshot | null;
    saveWeatherSnapshot(weather: HouseWeather, locationKey: string, attemptedAt?: string): StoredWeatherSnapshot;
    noteWeatherSnapshotFailure(
      houseId: string,
      locationKey: string,
      error: unknown,
      attemptedAt?: string,
    ): StoredWeatherSnapshot;
  }
}
