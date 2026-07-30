import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import type { OpeningStateObservation, Reading, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import { MeasurementService, RuntimeStatus, TelemetryService } from "../../services.js";
import { TpLinkCredentialTestResult, TpLinkDiscoveredSource, TpLinkHelperMessage, TpLinkHostChangeMessage, TpLinkSourceDiscoveryResult, ipv4Octets, nonEmptyString, safeTpLinkHistoryFailure, tpLinkDiscoveryTargets } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import "../core.js";

declare module "../core.js" {
  interface TpLinkConnectionBridgeInternals {
    stop(): void;
    restart(): void;
    discoverSources(
        timeoutMs?: number,
        preferredConnection?: { username: string; password: string },
      ): Promise<TpLinkSourceDiscoveryResult>;
    testCredentials(
        host: string,
        username: string,
        password: string,
        timeoutMs?: number,
      ): Promise<TpLinkCredentialTestResult>;
    spawnHelper(): void;
    handleLine(line: string): void;
    handleHostChange(message: TpLinkHostChangeMessage): void;
  }

  interface TpLinkConnectionBridgeCore {
    stop(): void;
    restart(): void;
    discoverSources(
        timeoutMs?: number,
        preferredConnection?: { username: string; password: string },
      ): Promise<TpLinkSourceDiscoveryResult>;
    testCredentials(
        host: string,
        username: string,
        password: string,
        timeoutMs?: number,
      ): Promise<TpLinkCredentialTestResult>;
  }
}
