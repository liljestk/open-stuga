/** Gree's two documented local-protocol encryption variants. */
export type GreeCipherVersion = 1 | 2;

export type HeatPumpMode = "auto" | "cool" | "dry" | "fan" | "heat";

/**
 * Gree/Wilfa reports power and the selected operating mode, but not reliable
 * compressor activity. `unknown` deliberately avoids presenting a selected
 * cooling/heating mode as proof that the compressor is running.
 */
export type HeatPumpActivity = "off" | "unknown";

export interface GreeDiscoveredDevice {
  host: string;
  port: number;
  mac: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
  configuredConnectionId?: string;
}

export interface GreeConnectionStatus {
  id: string;
  houseId: string;
  equipmentId: string | null;
  configured: boolean;
  connected: boolean;
  lastPollAt: string | null;
  error: string | null;
  host: string;
  mac: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
}

export interface GreeIntegrationStatus {
  configured: boolean;
  connected: boolean;
  lastPollAt: string | null;
  error: string | null;
  connections: GreeConnectionStatus[];
}

export interface HeatPumpState {
  connectionId: string;
  houseId: string;
  equipmentId: string | null;
  deviceId: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  observedAt: string;
  receivedAt: string;
  available: boolean;
  power: boolean | null;
  selectedMode: HeatPumpMode | null;
  targetTemperatureC: number | null;
  currentTemperatureC: number | null;
  /** Missing sensor data is never replaced with the target temperature. */
  currentTemperatureSource: "reported" | "unavailable";
  fanSpeed: string | null;
  horizontalSwing: string | null;
  verticalSwing: string | null;
  quiet: boolean | null;
  turbo: boolean | null;
  xfan: boolean | null;
  activity: HeatPumpActivity;
  activityEvidence: "protocol" | "unavailable";
}

export interface GreeConfigInput {
  houseId: string;
  mac: string;
}
