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
import { PendingTpLinkHistoryRequest, TapoOpeningTarget, TpLinkHistoryResultMessage, importTpLinkMappingFile, nonEmptyString, safeTpLinkHistoryFailure, validateTpLinkDeviceMappings } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import { registerTpLinkConnectionBridgeMethods, tpLinkConnectionBridgeState, type TpLinkConnectionBridgeInternals } from "../core.js";

registerTpLinkConnectionBridgeMethods({
  start(this: TpLinkConnectionBridgeInternals): void {
      if (this[tpLinkConnectionBridgeState].running) return;
      this[tpLinkConnectionBridgeState].running = true;
      if (!this[tpLinkConnectionBridgeState].status.value.tpLink.configured) return;
      try {
        if (this[tpLinkConnectionBridgeState].connection === undefined) {
          const path = this[tpLinkConnectionBridgeState].config.tpLinkDeviceMapFile;
          const fromFile = Boolean(path && existsSync(path));
          const stored = fromFile ? null : this[tpLinkConnectionBridgeState].database.getIntegrationMappingSet<unknown>("tp-link");
          const legacyMappings = fromFile
            ? importTpLinkMappingFile(this[tpLinkConnectionBridgeState].database, path!)
            : stored ? validateTpLinkDeviceMappings(stored.mappings) : [];
          const missingSensorIds = [...new Set(legacyMappings
            .filter((mapping) => !this[tpLinkConnectionBridgeState].database.getSensor(mapping.sensorId))
            .map((mapping) => mapping.sensorId))].sort();
          this[tpLinkConnectionBridgeState].mappingWarning = missingSensorIds.length > 0
            ? `Ignored TP-Link mappings for unknown sensors: ${missingSensorIds.join(", ")}`
            : null;
          for (const mapping of legacyMappings) {
            this[tpLinkConnectionBridgeState].legacyMappings.set(mapping.deviceId, mapping.sensorId);
          }
        }
        this[tpLinkConnectionBridgeState].status.value.tpLink.mappedDevices = new Set([...this.resolvedMappings().keys(), ...this.configuredOpeningTargets().map((target) => target.deviceId)]).size;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = this[tpLinkConnectionBridgeState].mappingWarning;
        this[tpLinkConnectionBridgeState].status.changed();
        this.spawnHelper();
      } catch (error) {
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = error instanceof Error ? error.message : "Could not load TP-Link device mappings";
        this[tpLinkConnectionBridgeState].status.changed();
      }
    },
  listDiscoveredDevices(this: TpLinkConnectionBridgeInternals): TpLinkDiscoveredDevice[] {
      const mappings = this.resolvedMappings();
      return [...this[tpLinkConnectionBridgeState].discovered.values()]
        .map((device) => ({
          ...device,
          ...(this[tpLinkConnectionBridgeState].connection ? { connectionId: this[tpLinkConnectionBridgeState].connection.id, houseId: this[tpLinkConnectionBridgeState].connection.houseId } : {}),
          mappedSensorId: mappings.get(device.deviceId) ?? null,
        }))
        .sort((first, second) => (first.alias ?? first.deviceId).localeCompare(second.alias ?? second.deviceId));
    },
  ownsSensor(this: TpLinkConnectionBridgeInternals, sensorId: string): boolean {
      return [...this.resolvedMappings().values()].includes(sensorId);
    },
  recoverHistory(this: TpLinkConnectionBridgeInternals, sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
      const operation = this[tpLinkConnectionBridgeState].historyQueue.then(() => this.recoverHistoryIsolated(sensorId, metric, from, to));
      this[tpLinkConnectionBridgeState].historyQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  async recoverHistoryIsolated(this: TpLinkConnectionBridgeInternals,
      sensorId: string,
      metric: string,
      from: string,
      to: string,
    ): Promise<SensorHistoryRecoveryResult> {
      const mapping = [...this.resolvedMappings()].find(([, mappedSensorId]) => mappedSensorId === sensorId);
      if (!mapping || !this[tpLinkConnectionBridgeState].config.tpLinkHost || !this[tpLinkConnectionBridgeState].config.tpLinkUsername || !this[tpLinkConnectionBridgeState].config.tpLinkPassword) {
        return {
          state: "not-supported", samples: [], error: "The sensor has no active local TP-Link history binding",
        };
      }
      const definition = this[tpLinkConnectionBridgeState].database.getMeasurementDefinition(metric);
      if (!definition?.enabled) {
        return { state: "not-supported", samples: [], error: `Measurement metric ${metric} is unavailable` };
      }
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
        return { state: "complete", samples: [], error: null };
      }
      const requestId = randomUUID();
      const deviceId = mapping[0];
      const liveChild = this[tpLinkConnectionBridgeState].child;
      if (liveChild?.stdin?.writable) {
        return this.runLiveHistoryRequest(
          liveChild, requestId, deviceId, sensorId, metric, fromMs, toMs, definition.unit,
        );
      }

      await this.pausePollingForHistory();
      try {
        return await this.runHistoryHelper(requestId, deviceId, sensorId, metric, fromMs, toMs, definition.unit);
      } finally {
        // SSL/AES hubs may keep only one usable encrypted session per client.
        // Resume live polling only after the one-shot history process has exited.
        if (this[tpLinkConnectionBridgeState].running) this.spawnHelper();
      }
    },
  runLiveHistoryRequest(this: TpLinkConnectionBridgeInternals,
      child: ChildProcess,
      requestId: string,
      deviceId: string,
      sensorId: string,
      metric: string,
      fromMs: number,
      toMs: number,
      canonicalUnit: string,
    ): Promise<SensorHistoryRecoveryResult> {
      return new Promise((resolve, reject) => {
        let pending!: PendingTpLinkHistoryRequest;
        const timer = setTimeout(() => {
          this.settlePendingHistory(pending, new Error("TP-Link local history request timed out"));
          if (this[tpLinkConnectionBridgeState].child === child) child.kill();
        }, 45_000);
        timer.unref();
        pending = {
          child, requestId, deviceId, sensorId, metric, fromMs, toMs, canonicalUnit,
          timer, resolve, reject,
        };
        this[tpLinkConnectionBridgeState].pendingHistory.set(requestId, pending);
        const line = `${JSON.stringify({
          type: "history-request", requestId, deviceId, metric,
          from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
        })}\n`;
        try {
          child.stdin!.write(line, (error) => {
            if (error) this.settlePendingHistory(pending, new Error(`Could not send TP-Link history request: ${error.message}`));
          });
        } catch (error) {
          this.settlePendingHistory(pending, error instanceof Error ? error : new Error("Could not send TP-Link history request"));
        }
      });
    },
  settlePendingHistory(this: TpLinkConnectionBridgeInternals,
      pending: PendingTpLinkHistoryRequest,
      result: SensorHistoryRecoveryResult | Error,
    ): void {
      if (this[tpLinkConnectionBridgeState].pendingHistory.get(pending.requestId) !== pending) return;
      this[tpLinkConnectionBridgeState].pendingHistory.delete(pending.requestId);
      clearTimeout(pending.timer);
      if (result instanceof Error) pending.reject(result);
      else pending.resolve(result);
    },
  failPendingHistory(this: TpLinkConnectionBridgeInternals, child: ChildProcess, message: string): void {
      for (const pending of this[tpLinkConnectionBridgeState].pendingHistory.values()) {
        if (pending.child === child) this.settlePendingHistory(pending, new Error(message));
      }
    },
  runHistoryHelper(this: TpLinkConnectionBridgeInternals,
      requestId: string,
      deviceId: string,
      sensorId: string,
      metric: string,
      fromMs: number,
      toMs: number,
      canonicalUnit: string,
    ): Promise<SensorHistoryRecoveryResult> {
      return new Promise((resolve, reject) => {
        const child = spawn(this[tpLinkConnectionBridgeState].config.tpLinkPython, [this[tpLinkConnectionBridgeState].config.tpLinkBridgeScript, "--history"], {
          env: {
            ...process.env,
            TP_LINK_HOST: this[tpLinkConnectionBridgeState].config.tpLinkHost!,
            TP_LINK_USERNAME: this[tpLinkConnectionBridgeState].config.tpLinkUsername!,
            TP_LINK_PASSWORD: this[tpLinkConnectionBridgeState].config.tpLinkPassword!,
            ...(this[tpLinkConnectionBridgeState].managedConnection?.deviceId ? { TP_LINK_DEVICE_ID: this[tpLinkConnectionBridgeState].managedConnection.deviceId } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let settled = false;
        let stdout = "";
        let stderr = "";
        const finish = (result: SensorHistoryRecoveryResult | Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (!child.killed) child.kill();
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const timeout = setTimeout(() => finish(new Error("TP-Link local history request timed out")), 45_000);
        timeout.unref();
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
          if (Buffer.byteLength(stdout, "utf8") > 2 * 1024 * 1024) {
            finish(new Error("TP-Link local history response exceeded 2 MiB"));
          }
        });
        child.stderr?.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${chunk.toString()}`.slice(-2_000); });
        child.once("error", (error) => finish(new Error(`Could not start TP-Link history helper: ${error.message}`)));
        child.once("close", (code) => {
          if (settled) return;
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
          let message: TpLinkHistoryResultMessage | null = null;
          let helperError: string | null = null;
          for (const line of lines) {
            try {
              const candidate = JSON.parse(line) as {
                type?: string;
                requestId?: string;
                message?: unknown;
              };
              if (candidate.type === "history-result") message = candidate as TpLinkHistoryResultMessage;
              if (candidate.type === "error" && (candidate.requestId === undefined || candidate.requestId === requestId)) {
                helperError = safeTpLinkHistoryFailure(candidate.message);
              }
            } catch { /* Reject below with a non-sensitive protocol error. */ }
          }
          if (!message || code !== 0) {
            const stderrDetail = safeTpLinkHistoryFailure(stderr.trim().split(/\r?\n/).at(-1));
            finish(new Error(helperError || stderrDetail || `TP-Link history helper stopped with exit code ${code ?? "unknown"}`));
            return;
          }
          try { finish(this.validateHistoryResult(message, requestId, deviceId, sensorId, metric, fromMs, toMs, canonicalUnit)); }
          catch (error) { finish(error instanceof Error ? error : new Error("TP-Link history response was invalid")); }
        });
        child.stdin?.end(`${JSON.stringify({
          type: "history-request", requestId, deviceId, metric,
          from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
        })}\n`);
      });
    },
  async pausePollingForHistory(this: TpLinkConnectionBridgeInternals): Promise<void> {
      if (this[tpLinkConnectionBridgeState].restartTimer) clearTimeout(this[tpLinkConnectionBridgeState].restartTimer);
      this[tpLinkConnectionBridgeState].restartTimer = null;
      const child = this[tpLinkConnectionBridgeState].child;
      if (!child) return;
      this[tpLinkConnectionBridgeState].child = null;
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            clearTimeout(failureTimer);
            child.off("close", closed);
            child.off("error", failed);
            if (error) reject(error);
            else resolve();
          };
          const closed = (): void => finish();
          const failed = (): void => finish();
          const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
          const failureTimer = setTimeout(() => finish(new Error(
            "TP-Link live polling helper could not be paused for local history recovery",
          )), 5_000);
          forceTimer.unref();
          failureTimer.unref();
          child.once("close", closed);
          child.once("error", failed);
          if (child.exitCode !== null || child.signalCode !== null) finish();
          else child.kill();
        });
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) this[tpLinkConnectionBridgeState].child = child;
        throw error;
      }
    },
  validateHistoryResult(this: TpLinkConnectionBridgeInternals,
      message: TpLinkHistoryResultMessage,
      requestId: string,
      deviceId: string,
      sensorId: string,
      metric: string,
      fromMs: number,
      toMs: number,
      canonicalUnit: string,
    ): SensorHistoryRecoveryResult {
      if (message.requestId !== requestId || nonEmptyString(message.deviceId)?.toUpperCase() !== deviceId.toUpperCase()
        || message.metric !== metric || !["complete", "partial", "not-supported"].includes(message.state)
        || !Array.isArray(message.samples) || message.samples.length > 100_000) {
        throw new Error("TP-Link history helper returned a mismatched response identity");
      }
      const definition = this[tpLinkConnectionBridgeState].database.getMeasurementDefinition(metric);
      const samples = new Map<string, SensorHistoryRecoveryResult["samples"][number]>();
      for (const sample of message.samples) {
        const timestampMs = typeof sample.timestamp === "string" ? Date.parse(sample.timestamp) : NaN;
        if (nonEmptyString(sample.deviceId)?.toUpperCase() !== deviceId.toUpperCase() || sample.metric !== metric
          || typeof sample.value !== "number" || !Number.isFinite(sample.value)
          || !Number.isFinite(timestampMs) || timestampMs < fromMs || timestampMs > toMs
          || !["good", "estimated", "stale"].includes(sample.quality)
          || definition?.validMin !== null && definition?.validMin !== undefined && sample.value < definition.validMin
          || definition?.validMax !== null && definition?.validMax !== undefined && sample.value > definition.validMax) {
          throw new Error("TP-Link history helper returned an invalid measurement sample");
        }
        const timestamp = new Date(timestampMs).toISOString();
        samples.set(timestamp, {
          sensorId, metric, value: sample.value, canonicalUnit, timestamp,
          source: "tp-link", quality: sample.quality,
        });
      }
      return {
        state: message.state,
        samples: [...samples.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
        error: message.error === null ? null : nonEmptyString(message.error)?.slice(0, 1_000) ?? "Local TP-Link history is incomplete",
      };
    },
  resolvedMappings(this: TpLinkConnectionBridgeInternals): Map<string, string> {
      const mappings = new Map<string, string>();
      const mappedSensors = new Set<string>();
      for (const sensor of this[tpLinkConnectionBridgeState].database.listSensors(this[tpLinkConnectionBridgeState].connection?.houseId)) {
        if (!sensor.tpLinkDeviceId) continue;
        if (this[tpLinkConnectionBridgeState].connection && sensor.tpLinkConnectionId !== this[tpLinkConnectionBridgeState].connection.id
          && !(this[tpLinkConnectionBridgeState].connection.acceptUnscoped && sensor.tpLinkConnectionId === undefined)) continue;
        mappings.set(sensor.tpLinkDeviceId, sensor.id);
        mappedSensors.add(sensor.id);
      }
      const missingSensorIds = [...new Set([...this[tpLinkConnectionBridgeState].legacyMappings.values()]
        .filter((sensorId) => !this[tpLinkConnectionBridgeState].database.getSensor(sensorId)))].sort();
      this[tpLinkConnectionBridgeState].mappingWarning = missingSensorIds.length > 0
        ? `Ignored TP-Link mappings for unknown sensors: ${missingSensorIds.join(", ")}`
        : null;
      for (const [deviceId, sensorId] of this[tpLinkConnectionBridgeState].legacyMappings) {
        if (!this[tpLinkConnectionBridgeState].database.getSensor(sensorId)) continue;
        if (mappings.has(deviceId) || mappedSensors.has(sensorId)) continue;
        mappings.set(deviceId, sensorId);
        mappedSensors.add(sensorId);
      }
      this[tpLinkConnectionBridgeState].status.value.tpLink.mappedDevices = new Set([...mappings.keys(), ...this.configuredOpeningTargets().map((target) => target.deviceId)]).size;
      return mappings;
    },
  configuredOpeningTargets(this: TpLinkConnectionBridgeInternals): TapoOpeningTarget[] {
      const houseId = this[tpLinkConnectionBridgeState].connection?.houseId ?? this[tpLinkConnectionBridgeState].database.listHouses()[0]?.id;
      const house = houseId ? this[tpLinkConnectionBridgeState].database.getHouse(houseId) : null;
      if (!house) return [];
      const connectionId = this[tpLinkConnectionBridgeState].connection?.id ?? "legacy";
      return house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
        if ((element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") || element.stateBinding?.provider !== "tapo") return [];
        if (element.stateBinding.connectionId && element.stateBinding.connectionId !== connectionId) return [];
        if (!element.stateBinding.connectionId && this[tpLinkConnectionBridgeState].connection && !this[tpLinkConnectionBridgeState].connection.acceptUnscoped) return [];
        return [{ houseId: house.id, floorId: floor.id, elementId: element.id,
          deviceId: element.stateBinding.externalId, connectionId }];
      }));
    },
});
