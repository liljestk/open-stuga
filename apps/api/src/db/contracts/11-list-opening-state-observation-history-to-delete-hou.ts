import type {
  DailyAnalyticsFindingsSnapshot,
  House,
  HouseLocation,
  HouseMapPlacement,
  OpeningStateObservation,
  OpeningStateObservationInput,
} from "@climate-twin/contracts";
import { OpeningStateActivityRecord, StoredDailyAnalyticsFindings } from "../support/01-json-value-to-area-equipment-row.js";
import { LocalMaintenanceTaskRevisionActor } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listOpeningStateObservationHistory(houseId: string, window: { from: string | number | Date; to: string | number | Date; limit?: number }): OpeningStateObservation[];
    openingStateActivity(houseId: string, from: string | number | Date, to: string | number | Date): OpeningStateActivityRecord[];
    dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null;
    saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot): void;
    recordDailyAnalyticsFindingsFailure(houseId: string, dataMode: "live" | "demo", attemptedAt: string, error: string): void;
    recordOpeningStateObservation(houseId: string, input: OpeningStateObservationInput): OpeningStateObservation;
    createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
            id?: string;
            propertyId?: string;
            location?: HouseLocation;
            mapPlacement?: HouseMapPlacement;
            orientationDegrees?: number;
        }): House;
    updateHouse(id: string, patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
            propertyId?: string;
            location?: HouseLocation | null;
            mapPlacement?: HouseMapPlacement | null;
            orientationDegrees?: number | null;
        }, actor?: LocalMaintenanceTaskRevisionActor): House | null;
    purgeSharedHouseProjection(id: string): boolean;
    deleteHouse(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    listOpeningStateObservationHistory(houseId: string, window: { from: string | number | Date; to: string | number | Date; limit?: number }): OpeningStateObservation[];
    openingStateActivity(houseId: string, from: string | number | Date, to: string | number | Date): OpeningStateActivityRecord[];
    dailyAnalyticsFindings(houseId: string, dataMode: "live" | "demo"): StoredDailyAnalyticsFindings | null;
    saveDailyAnalyticsFindings(snapshot: DailyAnalyticsFindingsSnapshot): void;
    recordDailyAnalyticsFindingsFailure(houseId: string, dataMode: "live" | "demo", attemptedAt: string, error: string): void;
    recordOpeningStateObservation(houseId: string, input: OpeningStateObservationInput): OpeningStateObservation;
    createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
            id?: string;
            propertyId?: string;
            location?: HouseLocation;
            mapPlacement?: HouseMapPlacement;
            orientationDegrees?: number;
        }): House;
    updateHouse(id: string, patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
            propertyId?: string;
            location?: HouseLocation | null;
            mapPlacement?: HouseMapPlacement | null;
            orientationDegrees?: number | null;
        }, actor?: LocalMaintenanceTaskRevisionActor): House | null;
    purgeSharedHouseProjection(id: string): boolean;
    deleteHouse(id: string): boolean;
  }
}
