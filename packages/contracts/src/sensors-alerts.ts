import type { Metric } from "./measurement-analytics.js";

/** How an electricity-capable sensor contributes to a Home total. */
export type EnergyMeterRole = "whole_home" | "submeter" | "standalone";

export interface Sensor {
  id: string;
  houseId: string;
  floorId: string;
  name: string;
  /**
   * Stable relationship to a room on `floorId`. `null` (or omission from a
   * legacy client) means the display label has not been linked to floor-plan
   * geometry.
   */
  roomId?: string | null;
  /** Backwards-compatible room label; synchronized from the linked Room name. */
  room: string;
  model: string;
  /** Local position within the selected floor's width coordinate system. */
  x: number;
  /** Local position within the selected floor's height coordinate system. */
  y: number;
  /** Absolute height in metres using the same vertical coordinate system as Floor.elevation. */
  z: number;
  temperatureEntityId?: string;
  humidityEntityId?: string;
  batteryEntityId?: string;
  /** Stable child-device identifier when this sensor is read directly from a TP-Link hub. */
  tpLinkDeviceId?: string;
  /** House-scoped TP-Link connection which owns `tpLinkDeviceId`. */
  tpLinkConnectionId?: string;
  /** Home Assistant entity bindings keyed by a registered measurement id. */
  measurementEntityIds?: Record<Metric, string>;
  /**
   * `whole_home` supersedes submeters in Home totals, while `standalone`
   * sources are summed when no whole-Home meter exists. Omitted legacy values
   * are treated as `standalone`.
   */
  energyMeterRole?: EnergyMeterRole;
  tags: string[];
  enabled: boolean;
}

export type SensorCreateInput = Omit<Sensor, "id"> & { id?: string };

export type SensorPatch = Partial<Omit<Sensor, "id" | "tpLinkDeviceId" | "tpLinkConnectionId">> & {
  tpLinkDeviceId?: string | null;
  tpLinkConnectionId?: string | null;
};

/** Sanitized TP-Link child-device details exposed for local onboarding. */
export interface TpLinkDiscoveredDevice {
  /** House owning the TP-Link connection which discovered this endpoint. */
  houseId?: string;
  /** Stable identifier for the house-scoped TP-Link host/connection. */
  connectionId?: string;
  deviceId: string;
  model: string;
  alias: string | null;
  status: string | null;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
  /** Contact state reported by devices such as Tapo T110; null when unavailable. */
  contactOpen?: boolean | null;
  /**
   * Provider-normalized device purpose. Older servers may omit this, so
   * clients should retain model/capability detection as a compatibility path.
   */
  deviceType?: "climate" | "contact" | "energy" | "unknown";
  /** Instantaneous active power reported by a python-kasa Energy module, in W. */
  power?: number | null;
  /** Device-provided cumulative energy counter, in kWh. Currently total since reboot. */
  energy?: number | null;
  lastSeenAt: string;
  mappedSensorId: string | null;
  /** Architectural opening currently driven by this contact device. */
  mappedOpening?: {
    floorId: string;
    elementId: string;
    kind: "door" | "window" | "vent";
    label: string | null;
  } | null;
}

export interface Reading {
  sensorId: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  source: "mock" | "home-assistant" | "tp-link" | "tuya" | "nexus433" | "api" | "import" | "replay";
  quality: "good" | "estimated" | "stale";
  /** Optional generic projection. Legacy fields remain required for v1 compatibility. */
  measurements?: Record<Metric, number>;
}

export type ReadingInput = Pick<Reading, "sensorId" | "temperature" | "humidity">
  & Partial<Pick<Reading, "timestamp" | "battery" | "quality" | "measurements">>;

export interface SensorSnapshot extends Sensor {
  reading: Reading | null;
}

export interface ForecastPoint {
  sensorId: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  temperatureLow: number;
  temperatureHigh: number;
  humidityLow: number;
  humidityHigh: number;
  measurements?: Record<Metric, { value: number; low: number; high: number }>;
}

export type AlertOperator = "gt" | "gte" | "lt" | "lte";

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertQuietHoursMode = "defer" | "silent";

/**
 * Durable, rule-local delivery policy. Alert detection is never disabled by a
 * delivery schedule: outside a delivery window the event is still recorded
 * and the notification is deferred or made silent according to this policy.
 */
export interface AlertDeliveryPolicy {
  /** IANA timezone used for local delivery windows. */
  timeZone: string;
  /** ISO weekday numbers (Monday=1 ... Sunday=7) on which normal delivery is active. */
  activeDays: number[];
  /** Optional local HH:mm window. A window crossing midnight is supported. */
  activeFrom: string | null;
  activeUntil: string | null;
  quietHoursFrom: string | null;
  quietHoursUntil: string | null;
  quietHoursMode: AlertQuietHoursMode;
  /** Critical alerts may bypass deferred quiet hours, but remain marked as such. */
  criticalBypassQuietHours: boolean;
  /** Send one escalation when an event remains open and unacknowledged. */
  escalationAfterSeconds: number | null;
  /** Repeat reminders while an event remains open and unacknowledged. */
  reminderIntervalSeconds: number | null;
  /** Delivery attempts before a row is moved to the durable dead-letter state. */
  maxAttempts: number;
}

export interface AlertRule {
  id: string;
  name: string;
  sensorId: string | null;
  metric: Metric;
  operator: AlertOperator;
  threshold: number;
  durationSeconds: number;
  severity: AlertSeverity;
  enabled: boolean;
  webhookEnabled: boolean;
  /** Send newly opened, non-demo events through the configured Telegram bot. */
  telegramEnabled: boolean;
  /** Optional for older clients; the API always returns the normalized policy. */
  deliveryPolicy?: AlertDeliveryPolicy;
}

export type AlertRuleInput = Omit<AlertRule, "id" | "sensorId" | "enabled" | "webhookEnabled" | "telegramEnabled"> & {
  id?: string;
  sensorId?: string | null;
  enabled?: boolean;
  webhookEnabled?: boolean;
  telegramEnabled?: boolean;
};

export type AlertRulePatch = Partial<Omit<AlertRule, "id">>;

export interface AlertEvent {
  id: string;
  ruleId: string;
  sensorId: string;
  metric: Metric;
  value: number;
  threshold: number;
  severity: AlertSeverity;
  startedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export type NotificationSubjectKind = "alert" | "maintenance" | "action-run";

export type NotificationDeliveryStage = "initial" | "escalation" | "reminder" | "due" | "verification";

export type NotificationChannel = "webhook" | "telegram" | "apns";

export type IOSPushEnvironment = "sandbox" | "production";

export type IOSPushMinimumSeverity = AlertSeverity;

export interface IOSNotificationRegistrationInput {
  deviceToken: string;
  environment: IOSPushEnvironment;
  homeIds: string[];
  minimumSeverity: IOSPushMinimumSeverity;
  includeDetails: boolean;
}

export interface IOSNotificationRegistration {
  id: string;
  environment: IOSPushEnvironment;
  homeIds: string[];
  minimumSeverity: IOSPushMinimumSeverity;
  includeDetails: boolean;
  enabled: boolean;
  updatedAt: string;
}

export interface IOSNotificationStatus {
  configured: boolean;
  registration: IOSNotificationRegistration | null;
}

/** Redacted operational view of the immutable notification delivery ledger. */
export interface NotificationDeliveryStatus {
  id: string;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  stage: NotificationDeliveryStage;
  sequence: number;
  channel: NotificationChannel;
  destinationId: string;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  deliveredAt: string | null;
  deadLetteredAt: string | null;
  abandonedAt: string | null;
  lastError: string | null;
}

export type ActionPlaybookGoal = "decrease" | "increase" | "below" | "above";

/** A reusable, evidence-based response to an alert or observed condition. */
export interface ActionPlaybook {
  id: string;
  name: string;
  description: string;
  instructions: string[];
  metric: Metric;
  goal: ActionPlaybookGoal;
  /** Required absolute improvement for increase/decrease goals. */
  minimumImprovement: number;
  /** Target used by below/above goals. */
  targetValue: number | null;
  waitSeconds: number;
  verificationWindowSeconds: number;
  enabled: boolean;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ActionPlaybookInput = Pick<ActionPlaybook,
  "name" | "description" | "instructions" | "metric" | "goal" | "minimumImprovement" |
  "targetValue" | "waitSeconds" | "verificationWindowSeconds"
> & Partial<Pick<ActionPlaybook, "id" | "enabled">>;

export type ActionRunStatus = "active" | "waiting" | "verified" | "not-improved" | "cancelled";

/** Durable execution and automatic before/after verification evidence. */
export interface ActionRun {
  id: string;
  playbookId: string;
  alertEventId: string | null;
  maintenanceTaskId: string | null;
  sensorId: string;
  metric: Metric;
  status: ActionRunStatus;
  startedAt: string;
  actionCompletedAt: string | null;
  verifyAfter: string | null;
  verificationDeadline: string | null;
  baselineValue: number;
  baselineTimestamp: string;
  resultValue: number | null;
  resultTimestamp: string | null;
  improvement: number | null;
  sampleCount: number;
  operatorNote: string | null;
  verificationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionRunStartInput {
  playbookId: string;
  sensorId: string;
  alertEventId?: string | null;
  maintenanceTaskId?: string | null;
  operatorNote?: string | null;
}
