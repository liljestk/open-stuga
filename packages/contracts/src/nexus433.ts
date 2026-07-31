import type { SensorCreateInput } from "./sensors-alerts.js";

export type Nexus433BatteryState = "ok" | "low";

export type Nexus433RuntimeState =
  | "unavailable"
  | "disabled"
  | "starting"
  | "connected"
  | "disconnected"
  | "error";

export interface Nexus433SamplePreview {
  temperature: number;
  humidity: number;
  battery: Nexus433BatteryState;
  quality: number;
}

export interface Nexus433Candidate {
  id: string;
  providerKey: string;
  senderId: string;
  channel: number;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
  sample: Nexus433SamplePreview;
}

export interface Nexus433Binding {
  id: string;
  sensorId: string;
  providerKey: string;
  senderId: string;
  channel: number;
  revision: number;
  battery: Nexus433BatteryState | null;
  signalQuality: number | null;
  available: boolean;
  lastSeenAt: string | null;
  lastAcceptedAt: string | null;
  createdAt: string;
}

export interface Nexus433HostCapability {
  available: boolean;
  gpioChip: string | null;
  gpioLine: number | null;
}

export interface Nexus433HostOperation {
  id: string;
  enabled: boolean;
  phase: "queued" | "applying" | "complete" | "failed";
  requestedAt: string;
  completedAt: string | null;
  detail: string | null;
}

export interface Nexus433Status {
  houseId: string;
  capability: Nexus433HostCapability;
  enabled: boolean;
  revision: number;
  runtime: Nexus433RuntimeState;
  brokerConnected: boolean;
  receiverOnline: boolean | null;
  receiverIdentity: string | null;
  lastMessageAt: string | null;
  error: string | null;
  operation: Nexus433HostOperation | null;
}

export interface Nexus433ConfigInput {
  houseId: string;
  enabled: boolean;
  expectedRevision?: number;
}

export interface Nexus433BindingCreateInput {
  houseId: string;
  candidateId: string;
  sensorId?: string;
  sensor?: SensorCreateInput;
}

export interface Nexus433ReconnectInput {
  houseId: string;
  candidateId: string;
  expectedRevision: number;
}
