/** Gree's two documented local-protocol encryption variants. */
export type GreeCipherVersion = 1 | 2;

export type GreeTransport = "local" | "ewpe-cloud";

export type HeatPumpMode = "auto" | "cool" | "dry" | "fan" | "heat";

/**
 * Gree/Wilfa reports power and the selected operating mode, but not reliable
 * compressor activity. `unknown` deliberately avoids presenting a selected
 * cooling/heating mode as proof that the compressor is running.
 */
export type HeatPumpActivity = "off" | "unknown";

export interface GreeDiscoveredDevice {
  transport: GreeTransport;
  host: string;
  port: number;
  mac: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
  cloudHomeName?: string | null;
  cloudRoomName?: string | null;
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
  transport: GreeTransport;
  host: string;
  mac: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
}

export interface HeatPumpPlacement {
  floorId: string | null;
  roomId: string | null;
  /** Floor-local plan coordinates. Null means the heat pump has not been placed. */
  x: number | null;
  y: number | null;
  /** Absolute height in metres using the same origin as Floor.elevation. */
  z: number | null;
}

/**
 * Vendor-reported diagnostics whose engineering units have not all been
 * independently calibrated. The `Raw` suffix is intentional.
 */
export interface HeatPumpDiagnostics {
  [key: string]: number | undefined;
  environmentTemperatureRaw?: number;
  indoorCoilTemperatureRaw?: number;
  outdoorTemperatureRaw?: number;
  compressorTemperatureRaw?: number;
  waterSensorRaw?: number;
  totalEnergyRaw?: number;
  energyConsumptionRaw?: number;
  faultCode?: number;
  allErrors?: number;
  shutdownFaults?: number;
  subhealthFaults?: number;
  wifiStatus?: number;
}

export interface GreeIntegrationStatus {
  configured: boolean;
  connected: boolean;
  lastPollAt: string | null;
  error: string | null;
  connections: GreeConnectionStatus[];
}

export interface HeatPumpState extends HeatPumpPlacement {
  connectionId: string;
  houseId: string;
  equipmentId: string | null;
  deviceId: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  transport: GreeTransport;
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
  /** Reported compressor frequency; null when this model does not expose it. */
  compressorFrequencyHz: number | null;
  diagnostics: HeatPumpDiagnostics;
  activity: HeatPumpActivity;
  activityEvidence: "protocol" | "unavailable";
}

export interface GreeConfigInput {
  houseId: string;
  mac: string;
}

export interface GreeCloudDiscoveryInput {
  houseId: string;
  username: string;
  password: string;
}

export interface GreeCloudConfigInput extends GreeCloudDiscoveryInput {
  mac: string;
}

export interface HeatPumpPlacementPatch {
  floorId: string | null;
  roomId?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
}
