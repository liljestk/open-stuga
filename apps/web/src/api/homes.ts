import { type House, type HouseLocation, type HousePatch, type HouseWeather, type OpeningStateObservation, type OpeningStateObservationInput, type OpeningStateSnapshot, type OutdoorTemperatureSample, withSignal, type CoordinateDefaults } from "@climate-twin/contracts";
import { list, request, requestV2, updateHouseGeoreference } from "./support/request";
import type { CreateHouseInput, OutdoorTemperatureHistoryPage, LocationSuggestion, TimeRangeQuery } from "./support/response-types";

/** Homes, their floors, location and weather, opening states, and location search. */
export const homesApi = {
  houses: async () => list<House>(await request<unknown>("/houses"), "houses"),
  createHouse: async (house: CreateHouseInput) => (await request<{ house: House }>("/houses", {
      method: "POST",
      body: JSON.stringify(house),
    })).house,
  updateHouse: async (houseId: string, patch: HousePatch) => (await request<{ house: House }>(`/houses/${encodeURIComponent(houseId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).house,
  deleteHouse: (houseId: string) => request<void>(`/houses/${encodeURIComponent(houseId)}`, { method: "DELETE" }),
  openingStates: (houseId: string, at?: string, signal?: AbortSignal) => request<{ snapshot: OpeningStateSnapshot; observations: OpeningStateObservation[] }>(
      `/houses/${encodeURIComponent(houseId)}/opening-states${at ? `?at=${encodeURIComponent(at)}` : ""}`,
      withSignal(signal),
    ),
  openingStateHistory: async (
      houseId: string,
      { from, to, limit = 10_000, signal }: TimeRangeQuery,
    ): Promise<OpeningStateObservation[]> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      const result = await request<{
        snapshot: OpeningStateSnapshot;
        observations: OpeningStateObservation[];
        history?: OpeningStateObservation[];
      }>(`/houses/${encodeURIComponent(houseId)}/opening-states?${query}`, withSignal(signal));
      return result.history ?? [];
    },
  recordOpeningState: async (houseId: string, observation: Omit<OpeningStateObservationInput, "observedAt"> & { observedAt?: string }) => {
      const response = await request<{ observation: OpeningStateObservation }>(`/houses/${encodeURIComponent(houseId)}/opening-states`, { method: "POST", body: JSON.stringify(observation) });
      return response.observation;
    },
  updateHouseGeoreference,
  updateHouseLocation: (houseId: string, location: HouseLocation | null) => updateHouseGeoreference(houseId, { location }),
  houseWeather: async (houseId: string, hours = 48, signal?: AbortSignal) => {
      const response = await request<{ weather: HouseWeather }>(
        `/houses/${encodeURIComponent(houseId)}/weather?hours=${hours}`,
        withSignal(signal),
      );
      return response.weather;
    },
  outdoorTemperatureHistory: async (
      houseId: string,
      { from, to, limit = 20_000, signal }: TimeRangeQuery,
    ): Promise<OutdoorTemperatureHistoryPage> => {
      const query = new URLSearchParams({ from, to, limit: String(limit) });
      const result = await requestV2<Partial<Omit<OutdoorTemperatureHistoryPage, "samples">> & {
        samples: OutdoorTemperatureSample[];
      }>(`/houses/${encodeURIComponent(houseId)}/outdoor-temperature/history?${query}`, withSignal(signal));
      return {
        samples: result.samples,
        from: result.from ?? from,
        to: result.to ?? to,
        truncated: result.truncated ?? result.samples.length >= limit,
      };
    },
  updateFloor: (houseId: string, floorId: string, floor: House["floors"][number]) => request<House["floors"][number]>(`/houses/${encodeURIComponent(houseId)}/floors/${encodeURIComponent(floorId)}`, { method: "PUT", body: JSON.stringify(floor) }),
  searchLocations: async (query: string, language = "en", signal?: AbortSignal) => (
      await request<{ results: LocationSuggestion[] }>(`/locations/search?q=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}`, withSignal(signal))
    ).results,
  coordinateDefaults: (latitude: number, longitude: number) => request<CoordinateDefaults>(
      `/locations/defaults?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
    ),
};
