import type { GreeDiscoveredDevice, HeatPumpMode, HeatPumpState } from "@climate-twin/contracts";

// Device payload shapes shared by the LAN bridge (gree.ts) and the EWPE cloud
// client (ewpe-cloud.ts), kept apart so neither transport imports the other's
// types.

export interface GreeStatePayload {
  observedAt: string;
  available: boolean;
  power: boolean | null;
  selectedMode: HeatPumpMode | null;
  targetTemperatureC: number | null;
  currentTemperatureC: number | null;
  currentTemperatureSource: "reported" | "unavailable";
  currentHumidityPercent: number | null;
  targetHumidityPercent: number | null;
  fanSpeed: string | null;
  horizontalSwing: string | null;
  verticalSwing: string | null;
  freshAir: boolean | null;
  anion: boolean | null;
  sleep: boolean | null;
  light: boolean | null;
  quiet: boolean | null;
  turbo: boolean | null;
  xfan: boolean | null;
  steadyHeat: boolean | null;
  powerSave: boolean | null;
  cleanFilter: boolean | null;
  waterFull: boolean | null;
  dehumidifierMode: string | null;
  compressorFrequencyHz: number | null;
  diagnostics: HeatPumpState["diagnostics"];
  activity: "off" | "unknown";
  activityEvidence: "protocol" | "unavailable";
}

export interface GreeBindingResult {
  device: GreeDiscoveredDevice;
  key: string;
  cipherVersion: 1 | 2;
  state: GreeStatePayload;
}
