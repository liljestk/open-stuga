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
import { registerHomeAssistantConnectionBridgeMethods, homeAssistantConnectionBridgeState, type HomeAssistantConnectionBridgeInternals } from "../core.js";

registerHomeAssistantConnectionBridgeMethods({
  startLivenessWatchdog(this: HomeAssistantConnectionBridgeInternals): void {
      if (this[homeAssistantConnectionBridgeState].livenessTimer) clearInterval(this[homeAssistantConnectionBridgeState].livenessTimer);
      this[homeAssistantConnectionBridgeState].livenessTimer = setInterval(() => {
        const dataVersion = this.databaseDataVersion();
        if (dataVersion !== this[homeAssistantConnectionBridgeState].databaseDataVersion) {
          this[homeAssistantConnectionBridgeState].databaseDataVersion = dataVersion;
          this.refreshMappings();
          return;
        }
        const socket = this[homeAssistantConnectionBridgeState].socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this[homeAssistantConnectionBridgeState].lastMessageAt > HA_LIVENESS_TIMEOUT_MS) {
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected = false;
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = "Home Assistant connection became unresponsive";
          this[homeAssistantConnectionBridgeState].status.changed();
          socket.terminate();
          return;
        }
        try {
          socket.ping();
          this.refreshOpeningStateHeartbeats();
        } catch {
          socket.terminate();
        }
      }, HA_LIVENESS_INTERVAL_MS);
      this[homeAssistantConnectionBridgeState].livenessTimer.unref();
    },
  databaseDataVersion(this: HomeAssistantConnectionBridgeInternals): number {
      try {
        return Number((this[homeAssistantConnectionBridgeState].database.db.prepare("PRAGMA data_version").get() as { data_version?: number }).data_version ?? 0);
      } catch {
        return this[homeAssistantConnectionBridgeState].databaseDataVersion;
      }
    },
});
