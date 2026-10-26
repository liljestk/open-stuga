import type { House, StaticParameter } from "@climate-twin/contracts";

/** House-scope static parameter: outdoor °C below which the home needs heating. */
export const HEATING_BASE_TEMPERATURE_PARAMETER = "heating-base-temperature";
/** Room-scope static parameters overriding the comfort band of the room's kind. */
export const COMFORT_TEMPERATURE_LOW_PARAMETER = "comfort-temperature-low";
export const COMFORT_TEMPERATURE_HIGH_PARAMETER = "comfort-temperature-high";
/** Room-scope boolean static parameter: leave this room out of comfort exposure. */
export const COMFORT_EXCLUDED_PARAMETER = "comfort-excluded";

export const DEFAULT_HEATING_BASE_TEMPERATURE_C = 17;

export interface ComfortBand {
  lowC: number;
  highC: number;
}

export const DEFAULT_COMFORT_BAND: ComfortBand = { lowC: 18, highC: 25 };

/** Room kinds with their own expected range; a sauna is meant to leave any comfort band. */
const ROOM_KIND_COMFORT: Readonly<Record<string, ComfortBand | null>> = {
  bedroom: { lowC: 16, highC: 23 },
  bathroom: { lowC: 20, highC: 27 },
  storage: { lowC: 10, highC: 27 },
  garage: { lowC: 5, highC: 30 },
  utility: { lowC: 15, highC: 27 },
  sauna: null,
};

const numericParameter = (parameter: StaticParameter | undefined, minimum: number, maximum: number): number | null => {
  const value = typeof parameter?.value === "number" ? parameter.value : Number(parameter?.value);
  return parameter !== undefined && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
};

const scoped = (parameters: readonly StaticParameter[], scopeType: StaticParameter["scopeType"], scopeId: string, key: string) => (
  parameters.find((parameter) => parameter.scopeType === scopeType && parameter.scopeId === scopeId && parameter.key === key)
);

export function heatingBaseTemperature(parameters: readonly StaticParameter[], houseId: string): number {
  return numericParameter(scoped(parameters, "house", houseId, HEATING_BASE_TEMPERATURE_PARAMETER), 5, 25)
    ?? DEFAULT_HEATING_BASE_TEMPERATURE_C;
}

/**
 * Each room's comfort band: its own parameters first, then its kind's default.
 * Rooms mapped to null are excluded from comfort exposure.
 */
export function roomComfortBands(house: Pick<House, "floors">, parameters: readonly StaticParameter[]): Map<string, ComfortBand | null> {
  const bands = new Map<string, ComfortBand | null>();
  for (const floor of house.floors) {
    for (const room of floor.rooms) {
      const excluded = scoped(parameters, "room", room.id, COMFORT_EXCLUDED_PARAMETER);
      if (excluded?.value === true || excluded?.value === "true") {
        bands.set(room.id, null);
        continue;
      }
      const kind = room.kind ? ROOM_KIND_COMFORT[room.kind] : undefined;
      const fallback = kind === undefined ? DEFAULT_COMFORT_BAND : kind;
      const low = numericParameter(scoped(parameters, "room", room.id, COMFORT_TEMPERATURE_LOW_PARAMETER), -20, 60);
      const high = numericParameter(scoped(parameters, "room", room.id, COMFORT_TEMPERATURE_HIGH_PARAMETER), -20, 60);
      if (fallback === null && low === null && high === null) {
        bands.set(room.id, null);
        continue;
      }
      const lowC = low ?? fallback?.lowC ?? DEFAULT_COMFORT_BAND.lowC;
      const highC = high ?? fallback?.highC ?? DEFAULT_COMFORT_BAND.highC;
      bands.set(room.id, lowC < highC ? { lowC, highC } : fallback);
    }
  }
  return bands;
}
