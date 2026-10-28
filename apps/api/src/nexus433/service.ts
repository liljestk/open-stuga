import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Nexus433Binding,
  Nexus433Candidate,
  Nexus433ConfigInput,
  Nexus433HostOperation,
  Nexus433Status,
  Reading,
} from "@climate-twin/contracts";
import type { AppConfig } from "../config.js";
import type { ClimateDatabase } from "../db.js";
import type { TelemetryService } from "../telemetry/ingest.js";
import { MqttSourceTransport } from "../source-transports/mqtt-source-transport.js";
import type { SourceTransport, SourceTransportState } from "../source-transports/source-transport.js";
import { loadNexus433HostCapability } from "./capability.js";
import { parseNexus433Packet } from "./parser.js";
import { Nexus433Store, Nexus433StoreError } from "./store.js";

const SOURCE_PROFILE_SCHEMA = "stugu-source-profile-request/v1";

type TransportFactory = () => SourceTransport;

function boundedDetail(value: unknown): string {
  const detail = value instanceof Error ? value.message : "The receiver connection failed";
  return detail.slice(0, 500);
}

export class Nexus433Service {
  readonly store: Nexus433Store;
  readonly capability;
  private transport: SourceTransport | null = null;
  private runtime: Nexus433Status["runtime"];
  private brokerConnected = false;
  private receiverOnline: boolean | null = null;
  private lastMessageAt: string | null = null;
  private error: string | null = null;
  private armed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly transportFactory: TransportFactory;

  constructor(
    private readonly config: AppConfig,
    database: ClimateDatabase,
    private readonly telemetry: TelemetryService,
    transportFactory?: TransportFactory,
  ) {
    this.store = new Nexus433Store(database);
    const declared = loadNexus433HostCapability(config.hostCapabilitiesFile);
    this.capability = {
      ...declared,
      available: declared.available && Boolean(config.systemUpdateOperationsDirectory),
    };
    this.runtime = this.capability.available ? "disabled" : "unavailable";
    this.transportFactory = transportFactory ?? (() => {
      if (!config.sourceMqttPasswordFile) throw new Error("MQTT subscriber credential is unavailable");
      return new MqttSourceTransport({
        host: config.sourceMqttHost ?? "127.0.0.1",
        port: config.sourceMqttPort ?? 1_883,
        username: config.sourceMqttUser ?? "stugu-api",
        passwordFile: config.sourceMqttPasswordFile,
        topic: "nexus433/#",
      });
    });
  }

  start(): void {
    if (this.armed) return;
    this.armed = true;
    void this.reconcileTransport();
  }

  async stop(): Promise<void> {
    this.armed = false;
    this.clearRetry();
    await this.stopTransport();
  }

  status(houseId: string): Nexus433Status {
    const gateway = this.store.gatewayForHouse(houseId, false);
    const enabled = gateway?.enabled === 1;
    return {
      houseId,
      capability: this.capability,
      enabled,
      revision: gateway?.revision ?? 0,
      runtime: enabled ? this.runtime : this.capability.available ? "disabled" : "unavailable",
      brokerConnected: enabled && this.brokerConnected,
      receiverOnline: enabled ? this.receiverOnline : null,
      receiverIdentity: gateway?.receiver_identity ?? null,
      lastMessageAt: enabled ? this.lastMessageAt : null,
      error: enabled ? this.error : null,
      operation: this.readHostOperation(),
    };
  }

  listCandidates(houseId: string): Nexus433Candidate[] {
    return this.store.listCandidates(houseId);
  }

  listBindings(houseId: string): Nexus433Binding[] {
    return this.store.listBindings(houseId);
  }

  async configure(input: Nexus433ConfigInput): Promise<Nexus433Status> {
    if (!this.capability.available) {
      throw new Nexus433StoreError(409, "NEXUS433_UNAVAILABLE", "Nexus433 is not available on this Stugu host");
    }
    const operation = this.readHostOperation();
    if (operation?.phase === "queued" || operation?.phase === "applying") {
      throw new Nexus433StoreError(409, "NEXUS433_OPERATION_ACTIVE", "A receiver change is already in progress");
    }
    const before = this.store.gatewayForHouse(input.houseId, false);
    const gateway = this.store.setEnabled(input.houseId, input.enabled, input.expectedRevision);
    const changed = (before?.enabled === 1) !== input.enabled;
    const retryFailedOperation = operation?.phase === "failed" && operation.enabled === input.enabled;
    if (!changed && !retryFailedOperation) return this.status(input.houseId);
    try {
      this.queueHostProfile(input.enabled);
    } catch (error) {
      if (changed) {
        this.store.setEnabled(input.houseId, before?.enabled === 1, gateway.revision);
      }
      throw error;
    }
    await this.reconcileTransport();
    return this.status(input.houseId);
  }

  isMetricAvailable(sensorId: string, metric: string, now = new Date()): boolean {
    if ((metric !== "temperature" && metric !== "humidity")
      || !this.brokerConnected || this.receiverOnline === false) return false;
    return this.store.isSensorDirectlyAvailable(sensorId, now);
  }

  ingestMessage(topic: string, payload: Buffer, retained = false, receivedAt = new Date()): "ignored" | "candidate" | "accepted" {
    const packet = parseNexus433Packet(topic, payload);
    if (!packet) return "ignored";
    if (retained && packet.kind === "state") return "ignored";
    const gateway = this.store.enabledGateway();
    if (!gateway) return "ignored";
    this.lastMessageAt = receivedAt.toISOString();
    this.store.noteReceiver(gateway.id, packet.receiverIdentity);
    if (packet.kind === "gateway-connection") {
      this.receiverOnline = packet.online;
      return "ignored";
    }
    if (packet.kind === "sender-connection") {
      this.store.setSenderAvailability(gateway.id, packet.providerKey, packet.online, receivedAt);
      return "ignored";
    }
    const binding = this.store.bindingForProvider(gateway.id, packet.providerKey);
    if (!binding) {
      const recorded = this.store.recordCandidate(
        gateway.id,
        packet.providerKey,
        packet.senderId,
        packet.channel,
        packet.sample,
        receivedAt,
      );
      return recorded ? "candidate" : "ignored";
    }
    const payloadHash = createHash("sha256").update(JSON.stringify(packet.sample)).digest("hex");
    const reading: Reading = {
      sensorId: binding.sensor_id,
      timestamp: receivedAt.toISOString(),
      temperature: packet.sample.temperature,
      humidity: packet.sample.humidity,
      battery: null,
      source: "nexus433",
      quality: "good",
    };
    const inserted = this.telemetry.ingestBatch([reading], {
      beforePersist: () => this.store.acceptBoundObservation(binding.id, packet.sample, payloadHash, receivedAt),
      afterPersist: (persisted) => {
        if (persisted.length !== 1) throw new Error("Nexus433 telemetry timestamp collided with an existing reading");
      },
    });
    return inserted.length === 1 ? "accepted" : "ignored";
  }

  private async reconcileTransport(): Promise<void> {
    const shouldRun = this.armed && this.capability.available && Boolean(this.store.enabledGateway());
    if (!shouldRun) {
      this.clearRetry();
      await this.stopTransport();
      this.runtime = this.capability.available ? "disabled" : "unavailable";
      return;
    }
    if (this.transport) return;
    try {
      this.runtime = "starting";
      this.error = null;
      const transport = this.transportFactory();
      this.transport = transport;
      await transport.start(
        (message) => {
          try {
            this.ingestMessage(message.topic, message.payload, message.retained);
          } catch {
            this.error = "A receiver message could not be stored";
            this.runtime = "error";
          }
        },
        (state, detail) => this.onTransportState(state, detail),
      );
    } catch (error) {
      this.transport = null;
      this.runtime = "error";
      this.brokerConnected = false;
      this.error = boundedDetail(error);
      this.scheduleRetry();
    }
  }

  private onTransportState(state: SourceTransportState, detail?: string): void {
    this.runtime = state;
    this.brokerConnected = state === "connected";
    this.error = state === "error" ? (detail ?? "The local MQTT connection failed") : null;
  }

  private async stopTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.brokerConnected = false;
    this.receiverOnline = null;
    if (transport) await transport.stop();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.armed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcileTransport();
    }, 5_000);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private queueHostProfile(enabled: boolean): void {
    const directory = this.config.systemUpdateOperationsDirectory;
    if (!directory) throw new Error("The host control service is unavailable");
    mkdirSync(directory, { recursive: true });
    const id = randomUUID();
    const requestedAt = new Date().toISOString();
    const request = { schema: SOURCE_PROFILE_SCHEMA, id, adapter: "nexus433", enabled, requestedAt };
    const operation: Nexus433HostOperation = {
      id,
      enabled,
      phase: "queued",
      requestedAt,
      completedAt: null,
      detail: "Waiting for the Stugu host service",
    };
    this.writeJsonAtomic(join(directory, "source-profile-status.json"), operation);
    this.writeJsonAtomic(join(directory, `source-profile-request-${id}.json`), request);
  }

  private readHostOperation(): Nexus433HostOperation | null {
    const directory = this.config.systemUpdateOperationsDirectory;
    if (!directory) return null;
    const path = join(directory, "source-profile-status.json");
    if (!existsSync(path)) return null;
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1_024) return null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Nexus433HostOperation;
      if (!value || typeof value.id !== "string" || typeof value.enabled !== "boolean"
        || !["queued", "applying", "complete", "failed"].includes(value.phase)
        || typeof value.requestedAt !== "string") return null;
      return value;
    } catch {
      return null;
    }
  }

  private writeJsonAtomic(path: string, value: unknown): void {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 });
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
