import { existsSync, readFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { MeasurementSample, OpeningState, OpeningStateObservation, Reading } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import type { MeasurementService, RuntimeStatus, TelemetryService } from "../../services.js";
import { HA_LIVENESS_INTERVAL_MS, HA_LIVENESS_TIMEOUT_MS } from "../support/01-home-assistant-measurement-binding-to-validate-entit.js";
import "../core.js";

declare module "../core.js" {
  interface HomeAssistantConnectionBridgeInternals {
    startLivenessWatchdog(): void;
    databaseDataVersion(): number;
  }
}
