import { type HouseLocation, type HousePatch, type OpeningStateObservation, type OpeningStateObservationInput, withSignal } from "@climate-twin/contracts";
import { request, requestV2, updateHouseGeoreference } from "./support/request";
import type { CreateHouseInput, OutdoorTemperatureHistoryPage, TimeRangeQuery } from "./support/response-types";
import type { Floor } from "@climate-twin/contracts";
import { coordinateDefaultsShape, floorShape, houseShape, houseWeatherShape, locationSuggestionShape, openingStateObservationShape, openingStateSnapshotShape, outdoorTemperatureHistoryPageShape } from "./support/entity-shapes";
import { noContent, optional, arrayOf, fields } from "./support/response-shapes";

/** Homes, their floors, location and weather, opening states, and location search. */
export const homesApi = {
  houses: async () => (await request("/houses", fields({ houses: arrayOf(houseShape) }))).houses,
  createHouse: async (house: CreateHouseInput) => (await request("/houses", fields({ house: houseShape }), {
      method: "POST",
      body: JSON.stringify(house),
    })).house,
  updateHouse: async (houseId: string, patch: HousePatch) => (await request(`/houses/${encodeURIComponent(houseId)}`, fields({ house: houseShape }), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).house,
  deleteHouse: (houseId: string) => request(`/houses/${encodeURIComponent(houseId)}`, noContent, { method: "DELETE" }),
  openingStates: (houseId: string, at?: string, signal?: AbortSignal) => request(
      `/houses/${encodeURIComponent(houseId)}/opening-states${at ? `?at=${encodeURIComponent(at)}` : ""}`, fields({ snapshot: openingStateSnapshotShape, observations: arrayOf(openingStateObservationShape) }),
      withSignal(signal),
    ),
  openingStateHistory: async (
      houseId: string,
      { from, to, limit = 10_000, signal }: TimeRangeQuery,
    ): Promise<OpeningStateObservation[]> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      const result = await request(`/houses/${encodeURIComponent(houseId)}/opening-states?${query}`, fields({ snapshot: openingStateSnapshotShape, observations: arrayOf(openingStateObservationShape), history: optional(arrayOf(openingStateObservationShape)) }), withSignal(signal));
      return result.history ?? [];
    },
  recordOpeningState: async (houseId: string, observation: Omit<OpeningStateObservationInput, "observedAt"> & { observedAt?: string }) => {
      const response = await request(`/houses/${encodeURIComponent(houseId)}/opening-states`, fields({ observation: openingStateObservationShape }), { method: "POST", body: JSON.stringify(observation) });
      return response.observation;
    },
  updateHouseGeoreference,
  updateHouseLocation: (houseId: string, location: HouseLocation | null) => updateHouseGeoreference(houseId, { location }),
  houseWeather: async (houseId: string, hours = 48, signal?: AbortSignal) => {
      const response = await request(
        `/houses/${encodeURIComponent(houseId)}/weather?hours=${hours}`, fields({ weather: houseWeatherShape }),
        withSignal(signal),
      );
      return response.weather;
    },
  outdoorTemperatureHistory: async (
      houseId: string,
      { from, to, limit = 20_000, signal }: TimeRangeQuery,
    ): Promise<OutdoorTemperatureHistoryPage> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      return requestV2(`/houses/${encodeURIComponent(houseId)}/outdoor-temperature/history?${query}`, outdoorTemperatureHistoryPageShape, withSignal(signal));
    },
  updateFloor: (houseId: string, floorId: string, floor: Floor) => request(`/houses/${encodeURIComponent(houseId)}/floors/${encodeURIComponent(floorId)}`, floorShape, { method: "PUT", body: JSON.stringify(floor) }),
  searchLocations: async (query: string, language = "en", signal?: AbortSignal) => (
      await request(`/locations/search?q=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}`, fields({ results: arrayOf(locationSuggestionShape) }), withSignal(signal))
    ).results,
  coordinateDefaults: (latitude: number, longitude: number) => request(
      `/locations/defaults?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`, coordinateDefaultsShape,
    ),
};
