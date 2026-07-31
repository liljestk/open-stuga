export type ConnectedDeviceProvider = "tuya-local";

export type ConnectedDeviceKind = "light" | "outlet" | "switch";

export interface ConnectedDeviceCapabilities {
  power: boolean;
  brightness: boolean;
  colorTemperature: boolean;
  color: boolean;
  measuredPower: boolean;
  measuredEnergy: boolean;
}

export interface ConnectedDeviceColor {
  /** Hue in degrees. */
  hue: number;
  /** Saturation from zero to one hundred. */
  saturation: number;
  /** Color value from zero to one hundred. */
  value: number;
}

export interface ConnectedDevicePlacement {
  floorId: string | null;
  roomId: string | null;
  /** Floor-local plan coordinates. Null means the device has not been placed. */
  x: number | null;
  y: number | null;
  /** Absolute height in metres using the same origin as Sensor.z. */
  z: number | null;
}

/**
 * Provider-neutral current state for a controllable device in one Home.
 * Provider credentials, raw datapoints, and Tuya device IDs never enter this
 * response projection.
 */
export interface ConnectedDeviceState extends ConnectedDevicePlacement {
  id: string;
  connectionId: string;
  houseId: string;
  equipmentId: string | null;
  provider: ConnectedDeviceProvider;
  kind: ConnectedDeviceKind;
  profileId: string;
  name: string;
  model: string | null;
  capabilities: ConnectedDeviceCapabilities;
  observedAt: string | null;
  receivedAt: string | null;
  available: boolean;
  power: boolean | null;
  brightnessPercent: number | null;
  colorTemperatureKelvin: number | null;
  color: ConnectedDeviceColor | null;
  workMode: string | null;
  powerWatts: number | null;
  energyKwh: number | null;
  currentAmps: number | null;
  voltageVolts: number | null;
}

export interface ConnectedDeviceCommand {
  /** Client-generated UUID retained for idempotent retries. */
  operationId: string;
  power?: boolean;
  brightnessPercent?: number;
  colorTemperatureKelvin?: number;
  color?: ConnectedDeviceColor;
}

export interface ConnectedDevicePlacementPatch {
  floorId: string | null;
  roomId?: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
}

export interface TuyaDiscoveredDevice {
  host: string;
  deviceId: string;
  protocolVersion: string;
  productKey: string | null;
  mac: string | null;
  /** Present when this physical device already has a saved Stugu connection. */
  configuredConnectionId?: string;
}

export interface TuyaConnectionStatus {
  id: string;
  houseId: string;
  equipmentId: string | null;
  configured: boolean;
  connected: boolean;
  lastPollAt: string | null;
  error: string | null;
  host: string;
  kind: ConnectedDeviceKind;
  profileId: string;
  name: string;
  model: string | null;
  capabilities: ConnectedDeviceCapabilities;
}

export interface TuyaIntegrationStatus {
  configured: boolean;
  connected: boolean;
  lastPollAt: string | null;
  error: string | null;
  connections: TuyaConnectionStatus[];
}

export interface TuyaConfigInput {
  houseId: string;
  host: string;
  deviceId: string;
  localKey: string;
  protocolVersion: string;
  productKey?: string | null;
  mac?: string | null;
  name?: string;
  model?: string | null;
  floorId?: string;
  roomId?: string | null;
  x?: number;
  y?: number;
  z?: number;
}
