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
import { TpLinkCredentialTestResult, TpLinkDiscoveredSource, TpLinkHelperMessage, TpLinkHostChangeMessage, TpLinkSourceDiscoveryResult, ipv4Octets, isTpLinkHubModel, nonEmptyString, safeTpLinkHistoryFailure, tpLinkDiscoveryTargets } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import { registerTpLinkConnectionBridgeMethods, tpLinkConnectionBridgeState, type TpLinkConnectionBridgeInternals } from "../core.js";

registerTpLinkConnectionBridgeMethods({
  stop(this: TpLinkConnectionBridgeInternals): void {
      this[tpLinkConnectionBridgeState].running = false;
      if (this[tpLinkConnectionBridgeState].restartTimer) clearTimeout(this[tpLinkConnectionBridgeState].restartTimer);
      this[tpLinkConnectionBridgeState].restartTimer = null;
      const child = this[tpLinkConnectionBridgeState].child;
      this[tpLinkConnectionBridgeState].child = null;
      child?.kill();
      this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
    },
  restart(this: TpLinkConnectionBridgeInternals): void {
      this.stop();
      this[tpLinkConnectionBridgeState].attempt = 0;
      this[tpLinkConnectionBridgeState].legacyMappings.clear();
      this[tpLinkConnectionBridgeState].discovered.clear();
      this[tpLinkConnectionBridgeState].currentDevices.clear();
      this[tpLinkConnectionBridgeState].lastIngested.clear();
      this[tpLinkConnectionBridgeState].lastIngestedMeasurements.clear();
      this[tpLinkConnectionBridgeState].lastIngestedOpeningStates.clear();
      this[tpLinkConnectionBridgeState].lastStatusSignature = null;
      this[tpLinkConnectionBridgeState].lastStatusPublishedAt = 0;
      this[tpLinkConnectionBridgeState].lastAvailabilitySignature = null;
      this[tpLinkConnectionBridgeState].mappingWarning = null;
      this[tpLinkConnectionBridgeState].status.value.tpLink.discoveredDevices = 0;
      this[tpLinkConnectionBridgeState].status.value.tpLink.mappedDevices = 0;
      this[tpLinkConnectionBridgeState].status.value.tpLink.hubModel = null;
      this[tpLinkConnectionBridgeState].status.value.tpLink.error = null;
      this.start();
    },
  discoverSources(this: TpLinkConnectionBridgeInternals,
      timeoutMs = 50_000,
      preferredConnection?: { username: string; password: string },
    ): Promise<TpLinkSourceDiscoveryResult> {
      return new Promise((resolve, reject) => {
        const configuredTargets = process.env.TP_LINK_DISCOVERY_TARGETS?.trim();
        const savedConnection = this[tpLinkConnectionBridgeState].config.tpLinkConnections?.[0];
        const recoveryHostList = (this[tpLinkConnectionBridgeState].config.tpLinkConnections ?? []).map((connection) => connection.host)
          .concat(this[tpLinkConnectionBridgeState].config.tpLinkHost ?? []).filter(Boolean);
        const discoveryTargets = configuredTargets || tpLinkDiscoveryTargets(recoveryHostList).join(",");
        const recoveryHosts = recoveryHostList.join(",");
        const username = preferredConnection?.username ?? this[tpLinkConnectionBridgeState].config.tpLinkUsername ?? savedConnection?.username;
        const password = preferredConnection?.password ?? this[tpLinkConnectionBridgeState].config.tpLinkPassword ?? savedConnection?.password;
        const child = spawn(this[tpLinkConnectionBridgeState].config.tpLinkPython, [this[tpLinkConnectionBridgeState].config.tpLinkBridgeScript, "--discover"], {
          env: {
            ...process.env,
            ...(discoveryTargets ? { TP_LINK_DISCOVERY_TARGETS: discoveryTargets } : {}),
            ...(recoveryHosts ? { TP_LINK_RECOVERY_HOSTS: recoveryHosts } : {}),
            ...(username ? { TP_LINK_USERNAME: username } : {}),
            ...(password ? { TP_LINK_PASSWORD: password } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => finish(new Error("TP-Link discovery timed out")), timeoutMs);
        const finish = (error?: Error, result?: TpLinkSourceDiscoveryResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!child.killed) child.kill();
          if (error) reject(error);
          else resolve(result ?? { sources: [], warnings: [] });
        };
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout = `${stdout}${chunk.toString()}`.slice(-65_536);
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
        });
        child.once("error", (error) => finish(error));
        child.once("close", (code) => {
          if (settled) return;
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
          const message = lines.flatMap((line) => {
            try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
          }).find((value) => value.type === "discovery");
          const rawSources = message && Array.isArray(message.sources)
            ? message.sources
            : message && Array.isArray(message.hubs) ? message.hubs : null;
          if (code !== 0 || !message || !rawSources) {
            finish(new Error(stderr.trim().split(/\r?\n/).at(-1) || "TP-Link discovery helper failed"));
            return;
          }
          const sources = rawSources.flatMap((value): TpLinkDiscoveredSource[] => {
            if (!value || typeof value !== "object") return [];
            const item = value as Record<string, unknown>;
            const host = nonEmptyString(item.host);
            const model = nonEmptyString(item.model)?.toUpperCase();
            const declaredSourceType = nonEmptyString(item.sourceType);
            const sourceType = declaredSourceType === "hub" || declaredSourceType === "energy-device"
              ? declaredSourceType
              : model && isTpLinkHubModel(model) ? "hub" : null;
            const rawDeviceId = nonEmptyString(item.deviceId);
            const deviceId = rawDeviceId && rawDeviceId.length <= 1_024 ? rawDeviceId : null;
            if (!host || !model || !sourceType) return [];
            if (sourceType === "hub" && !isTpLinkHubModel(model)) return [];
            return [{ host, model, alias: nonEmptyString(item.alias), sourceType, deviceId }];
          });
          const warnings = Array.isArray(message.warnings)
            ? message.warnings.flatMap((value): string[] => {
              const warning = nonEmptyString(value);
              return warning ? [warning.slice(0, 500)] : [];
            }).slice(0, 20)
            : [];
          finish(undefined, { sources: sources.sort((a, b) => a.host.localeCompare(b.host)), warnings });
        });
      });
    },
  /** Runs one isolated helper poll with draft credentials and never mutates the live bridge. */
  testCredentials(this: TpLinkConnectionBridgeInternals,
      host: string,
      username: string,
      password: string,
      timeoutMs = 15_000,
    ): Promise<TpLinkCredentialTestResult> {
      return new Promise((resolveTest) => {
        const child = spawn(this[tpLinkConnectionBridgeState].config.tpLinkPython, [this[tpLinkConnectionBridgeState].config.tpLinkBridgeScript, "--list"], {
          env: {
            ...process.env,
            TP_LINK_HOST: host,
            TP_LINK_USERNAME: username,
            TP_LINK_PASSWORD: password,
            TP_LINK_POLL_INTERVAL_MS: String(this[tpLinkConnectionBridgeState].config.tpLinkPollIntervalMs),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let settled = false;
        const finish = (result: TpLinkCredentialTestResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!child.killed) child.kill();
          resolveTest(result);
        };
        const timer = setTimeout(() => finish({
          ok: false, connected: false, message: "TP-Link credential validation timed out.",
        }), timeoutMs);
        timer.unref();
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout = `${stdout}${chunk.toString()}`.slice(-65_536);
        });
        child.once("error", () => finish({
          ok: false, connected: false, message: "Could not start the TP-Link validation helper.",
        }));
        child.once("close", (code) => {
          if (settled) return;
          const messages = stdout.trim().split(/\r?\n/).flatMap((line) => {
            try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
          });
          const snapshot = messages.find((message) => message.type === "snapshot");
          if (code === 0 && snapshot && Array.isArray(snapshot.devices)) {
            const deviceIds = snapshot.devices.flatMap((candidate): string[] => {
              if (!candidate || typeof candidate !== "object") return [];
              const deviceId = nonEmptyString((candidate as Record<string, unknown>).deviceId);
              return deviceId && deviceId.length <= 1_024 ? [deviceId] : [];
            });
            const warning = nonEmptyString(snapshot.warning)?.slice(0, 500) ?? null;
            finish({
              ok: true,
              connected: true,
              message: warning ?? "TP-Link credentials and local device polling are available.",
              details: {
                model: nonEmptyString(snapshot.hubModel),
                sourceType: snapshot.sourceType === "hub" || snapshot.sourceType === "energy-device"
                  ? snapshot.sourceType
                  : null,
                sourceAlias: nonEmptyString(snapshot.sourceAlias)?.slice(0, 512),
                deviceCount: snapshot.devices.length,
                sourceDeviceId: nonEmptyString(snapshot.sourceDeviceId),
                deviceIds: [...new Set(deviceIds)].slice(0, 2_048),
                warning,
              },
            });
            return;
          }
          finish({ ok: false, connected: false, message: "TP-Link rejected the draft connection or credentials." });
        });
      });
    },
  spawnHelper(this: TpLinkConnectionBridgeInternals): void {
      if (!this[tpLinkConnectionBridgeState].running || this[tpLinkConnectionBridgeState].child || !this[tpLinkConnectionBridgeState].config.tpLinkHost || !this[tpLinkConnectionBridgeState].config.tpLinkUsername || !this[tpLinkConnectionBridgeState].config.tpLinkPassword) return;
      this[tpLinkConnectionBridgeState].stderr = "";
      const configuredTargets = process.env.TP_LINK_DISCOVERY_TARGETS?.trim();
      const discoveryTargets = configuredTargets
        || tpLinkDiscoveryTargets([this[tpLinkConnectionBridgeState].config.tpLinkHost]).join(",");
      const contactEventsEnabled = this.configuredOpeningTargets().length > 0;
      this[tpLinkConnectionBridgeState].contactEventsEnabled = contactEventsEnabled;
      const child = spawn(this[tpLinkConnectionBridgeState].config.tpLinkPython, [this[tpLinkConnectionBridgeState].config.tpLinkBridgeScript], {
        env: {
          ...process.env,
          TP_LINK_HOST: this[tpLinkConnectionBridgeState].config.tpLinkHost,
          TP_LINK_USERNAME: this[tpLinkConnectionBridgeState].config.tpLinkUsername,
          TP_LINK_PASSWORD: this[tpLinkConnectionBridgeState].config.tpLinkPassword,
          TP_LINK_POLL_INTERVAL_MS: String(this[tpLinkConnectionBridgeState].config.tpLinkPollIntervalMs),
          TP_LINK_CONTACT_EVENTS_ENABLED: contactEventsEnabled ? "1" : "0",
          ...(this[tpLinkConnectionBridgeState].managedConnection?.deviceId ? { TP_LINK_DEVICE_ID: this[tpLinkConnectionBridgeState].managedConnection.deviceId } : {}),
          ...(discoveryTargets ? { TP_LINK_DISCOVERY_TARGETS: discoveryTargets } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this[tpLinkConnectionBridgeState].child = child;
      const lines = child.stdout ? createInterface({ input: child.stdout }) : null;
      lines?.on("line", (line) => {
        if (this[tpLinkConnectionBridgeState].child === child) {
          this.handleLine(line);
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this[tpLinkConnectionBridgeState].stderr = `${this[tpLinkConnectionBridgeState].stderr}${chunk.toString()}`.slice(-2_000);
      });
      child.stdin?.on("error", () => {
        this.failPendingHistory(child, "TP-Link helper input became unavailable");
      });
      child.once("error", (error) => {
        this.failPendingHistory(child, `TP-Link helper failed: ${error.message}`);
        if (this[tpLinkConnectionBridgeState].child !== child) return;
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = `Could not start TP-Link helper: ${error.message}`;
        this.publishStatusIfNeeded();
        this.notifyAvailabilityChangeIfNeeded();
      });
      child.once("close", (code) => {
        lines?.close();
        this.failPendingHistory(child, `TP-Link helper stopped with exit code ${code ?? "unknown"}`);
        if (this[tpLinkConnectionBridgeState].child !== child) return;
        this[tpLinkConnectionBridgeState].child = null;
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        const stderr = this[tpLinkConnectionBridgeState].stderr.trim().split(/\r?\n/).at(-1);
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = stderr || `TP-Link helper stopped${code === null ? "" : ` with exit code ${code}`}`;
        this.publishStatusIfNeeded();
        this.notifyAvailabilityChangeIfNeeded();
        this.scheduleRestart();
      });
    },
  handleLine(this: TpLinkConnectionBridgeInternals, line: string): void {
      if (!this[tpLinkConnectionBridgeState].running) {
        return;
      }

      let message: TpLinkHelperMessage;
      try {
        message = JSON.parse(line) as TpLinkHelperMessage;
      } catch {
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = "TP-Link helper returned malformed data";
        this.publishStatusIfNeeded();
        return;
      }
      if (message.type === "error") {
        const requestId = nonEmptyString(message.requestId);
        if (requestId) {
          const pending = this[tpLinkConnectionBridgeState].pendingHistory.get(requestId);
          if (pending) {
            this.settlePendingHistory(
              pending,
              new Error(safeTpLinkHistoryFailure(message.message) ?? "TP-Link history recovery failed"),
            );
          }
          return;
        }
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = nonEmptyString(message.message) ?? "TP-Link connection failed";
        this.publishStatusIfNeeded();
        this.notifyAvailabilityChangeIfNeeded();
        return;
      }
      if (message.type === "history-result") {
        const requestId = nonEmptyString(message.requestId);
        const pending = requestId ? this[tpLinkConnectionBridgeState].pendingHistory.get(requestId) : undefined;
        if (!pending) return;
        try {
          this.settlePendingHistory(pending, this.validateHistoryResult(
            message,
            pending.requestId,
            pending.deviceId,
            pending.sensorId,
            pending.metric,
            pending.fromMs,
            pending.toMs,
            pending.canonicalUnit,
          ));
        } catch (error) {
          this.settlePendingHistory(
            pending,
            error instanceof Error ? error : new Error("TP-Link history response was invalid"),
          );
        }
        return;
      }
      if (message.type === "host-change") {
        this.handleHostChange(message);
        return;
      }
      if (message.type === "contact-events") {
        if (Array.isArray(message.events)) this.ingestContactEvents(message);
        return;
      }
      if (message.type !== "snapshot" || !Array.isArray(message.devices)) return;
      this.ingestSnapshot(message);
    },
  handleHostChange(this: TpLinkConnectionBridgeInternals, message: TpLinkHostChangeMessage): void {
      const previousHost = nonEmptyString(message.previousHost);
      const host = nonEmptyString(message.host);
      if (!previousHost || !host || !ipv4Octets(host) || previousHost !== this[tpLinkConnectionBridgeState].config.tpLinkHost) return;
      const reportedDeviceId = nonEmptyString(message.sourceDeviceId);
      const knownDeviceId = this[tpLinkConnectionBridgeState].managedConnection?.deviceId;
      if (knownDeviceId && (!reportedDeviceId
        || knownDeviceId.trim().toUpperCase() !== reportedDeviceId.trim().toUpperCase())) {
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = "TP-Link address recovery reported a different source identity; the saved connection was not changed";
        this.publishStatusIfNeeded();
        this.notifyAvailabilityChangeIfNeeded();
        return;
      }
      if (reportedDeviceId && reportedDeviceId.length > 1_024) {
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = "TP-Link address recovery returned an invalid source identity";
        this.publishStatusIfNeeded();
        this.notifyAvailabilityChangeIfNeeded();
        return;
      }
      const deviceId = reportedDeviceId ?? knownDeviceId;
      this[tpLinkConnectionBridgeState].config.tpLinkHost = host;
      this[tpLinkConnectionBridgeState].status.value.tpLink.host = host;
      if (this[tpLinkConnectionBridgeState].managedConnection) {
        this[tpLinkConnectionBridgeState].managedConnection.host = host;
        if (deviceId) this[tpLinkConnectionBridgeState].managedConnection.deviceId = deviceId;
        this[tpLinkConnectionBridgeState].managedConnection.onUpdate?.({
          id: this[tpLinkConnectionBridgeState].managedConnection.id,
          houseId: this[tpLinkConnectionBridgeState].managedConnection.houseId,
          previousHost,
          host,
          ...(deviceId ? { deviceId } : {}),
        });
      }
      this[tpLinkConnectionBridgeState].status.value.tpLink.error = `TP-Link source moved from ${previousHost} to ${host}; connection recovery is in progress`;
      this.publishStatusIfNeeded();
    },
});
