import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Reading, TelemetryEvent } from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { Nexus433Service, parseNexus433Packet } from "../src/nexus433/index.js";
import type { SourceTransport } from "../src/source-transports/source-transport.js";
import { config as baseConfig } from "./appTestSupport.js";

const receiver = "aabbccddeeff";
const payload = Buffer.from(JSON.stringify({ temperature: 21.4, humidity: 48, battery: "ok", quality: 87 }));

describe("Nexus433 integration", () => {
  let directory: string;
  let runtime: ApiRuntime;
  let service: Nexus433Service;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "stugu-nexus433-"));
    const capabilities = join(directory, "host-capabilities.json");
    writeFileSync(capabilities, JSON.stringify({
      schema: "stugu-host-capabilities/v1",
      capabilities: {
        nexus433: { state: "available", revision: "1", gpioChip: "/dev/gpiochip0", gpioLine: 17 },
      },
    }));
    const config = {
      ...baseConfig,
      hostCapabilitiesFile: capabilities,
      systemUpdateOperationsDirectory: directory,
      sourceMqttPasswordFile: null,
    };
    runtime = createApi({ config, startBackground: false });
    service = new Nexus433Service(config, runtime.database, runtime.telemetry);
  });

  afterEach(async () => {
    await service.stop();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("strictly accepts only bounded Nexus state and connection packets", () => {
    expect(parseNexus433Packet(`nexus433/sensor/${receiver}_5c01/state`, payload)).toMatchObject({
      kind: "state", providerKey: "5c01", senderId: "5c", channel: 1,
    });
    expect(parseNexus433Packet(`nexus433/sensor/${receiver}/connection`, Buffer.from("online")))
      .toEqual({ kind: "gateway-connection", receiverIdentity: receiver, online: true });
    expect(parseNexus433Packet(`nexus433/sensor/${receiver}_5c01/state`, Buffer.from("{}"))).toBeNull();
    expect(parseNexus433Packet(`nexus433/sensor/${receiver}_5c09/state`, payload)).toBeNull();
    expect(parseNexus433Packet(`nexus433/sensor/${receiver}_5c01/state`, Buffer.alloc(2_049))).toBeNull();
    expect(parseNexus433Packet("nexus433/sensor/not-a-receiver/state", payload)).toBeNull();
  });

  it("discovers unknown senders without telemetry, then preserves the Sensor across an ID change", async () => {
    const configured = await request(runtime.app)
      .put("/api/v1/integrations/nexus433/config")
      .send({ houseId: "house-main", enabled: true, expectedRevision: 0 })
      .expect(202);
    expect(configured.body).toMatchObject({ enabled: true, revision: 1 });

    expect(service.ingestMessage(`nexus433/sensor/${receiver}_5c01/state`, payload, true)).toBe("ignored");
    expect(service.ingestMessage(`nexus433/sensor/${receiver}_5c01/state`, payload)).toBe("candidate");
    expect(runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'nexus433'").get())
      .toEqual({ count: 0 });

    const candidates = await request(runtime.app)
      .get("/api/v1/integrations/nexus433/candidates?houseId=house-main")
      .expect(200);
    expect(candidates.body.candidates).toHaveLength(1);
    const firstCandidateId = candidates.body.candidates[0].id as string;
    const bound = await request(runtime.app)
      .post("/api/v1/integrations/nexus433/bindings")
      .send({ houseId: "house-main", candidateId: firstCandidateId, sensorId: "sensor-01" })
      .expect(201);
    expect(bound.body.binding).toMatchObject({ sensorId: "sensor-01", providerKey: "5c01", revision: 1 });

    const events: TelemetryEvent[] = [];
    const removeListener = runtime.bus.subscribe((event) => {
      events.push(event);
      if (event.type === "reading") {
        expect(runtime.database.db.prepare(
          "SELECT COUNT(*) AS count FROM readings WHERE sensor_id = ? AND timestamp = ? AND source = 'nexus433'",
        ).get(event.data.sensorId, event.data.timestamp)).toEqual({ count: 1 });
      }
    });
    const firstAt = new Date(Date.now() - 20_000);
    expect(service.ingestMessage(`nexus433/sensor/${receiver}_5c01/state`, payload, false, firstAt)).toBe("accepted");
    expect(service.ingestMessage(`nexus433/sensor/${receiver}_5c01/state`, payload, false, new Date(firstAt.getTime() + 1_000)))
      .toBe("ignored");
    expect(runtime.database.db.prepare(
      "SELECT metric, source FROM measurement_samples WHERE sensor_id = ? AND timestamp = ? ORDER BY metric",
    ).all("sensor-01", firstAt.toISOString())).toEqual([
      { metric: "humidity", source: "nexus433" },
      { metric: "temperature", source: "nexus433" },
    ]);

    const replacementPayload = Buffer.from(JSON.stringify({ temperature: 21.6, humidity: 49, battery: "low", quality: 81 }));
    expect(service.ingestMessage(`nexus433/sensor/${receiver}_6d01/state`, replacementPayload)).toBe("candidate");
    const replacementCandidates = service.listCandidates("house-main");
    const replacement = replacementCandidates.find((candidate) => candidate.providerKey === "6d01")!;
    const reconnected = await request(runtime.app)
      .post("/api/v1/integrations/nexus433/bindings/sensor-01/reconnect")
      .send({ houseId: "house-main", candidateId: replacement.id, expectedRevision: 1 })
      .expect(200);
    expect(reconnected.body.binding).toMatchObject({ sensorId: "sensor-01", providerKey: "6d01", revision: 2 });

    const secondAt = new Date(firstAt.getTime() + 11_000);
    expect(service.ingestMessage(`nexus433/sensor/${receiver}_6d01/state`, replacementPayload, false, secondAt)).toBe("accepted");
    const readings = runtime.database.history(["sensor-01"], firstAt.toISOString(), secondAt.toISOString()) as Reading[];
    expect(readings.map((reading) => [reading.sensorId, reading.source])).toEqual([
      ["sensor-01", "nexus433"], ["sensor-01", "nexus433"],
    ]);
    expect(events.filter((event) => event.type === "reading")).toHaveLength(2);
    removeListener();
  });

  it("bounds discovery and expires stale candidates", async () => {
    await service.configure({ houseId: "house-main", enabled: true, expectedRevision: 0 });
    const gateway = service.store.enabledGateway()!;
    const now = Date.now();
    service.store.recordCandidate(gateway.id, "ff01", "ff", 1, {
      temperature: 20, humidity: 40, battery: "ok", quality: 80,
    }, new Date(now - 7 * 60 * 60_000));
    for (let index = 0; index < 20; index += 1) {
      const senderId = index.toString(16).padStart(2, "0");
      const recorded = service.store.recordCandidate(gateway.id, `${senderId}00`, senderId, 0, {
        temperature: 20, humidity: 40, battery: "ok", quality: 80,
      }, new Date(now - 10 * 60_000 + index));
      expect(recorded).toBe(index < 16);
    }
    expect(service.listCandidates("house-main")).toHaveLength(16);
    for (let window = 1; window < 8; window += 1) {
      for (let offset = 0; offset < 16; offset += 1) {
        const index = window * 16 + offset;
        const senderId = index.toString(16).padStart(2, "0");
        service.store.recordCandidate(gateway.id, `${senderId}00`, senderId, 0, {
          temperature: 20, humidity: 40, battery: "ok", quality: 80,
        }, new Date(now - 10 * 60_000 + window * 61_000 + offset));
      }
    }
    expect(service.listCandidates("house-main")).toHaveLength(128);
    expect(service.listCandidates("house-main").some((candidate) => candidate.providerKey === "ff01")).toBe(false);
  });

  it("does not let another Home stop the assigned receiver", () => {
    runtime.database.createHouse({
      id: "house-other",
      name: "Other Home",
      timezone: "Europe/Helsinki",
      floors: [{ id: "other-floor", name: "Ground", width: 8, height: 8, elevation: 0, walls: [], rooms: [] }],
    });
    service.store.setEnabled("house-main", true, 0);
    expect(() => service.store.setEnabled("house-other", false)).toThrowError(
      expect.objectContaining({ code: "NEXUS433_ASSIGNED_ELSEWHERE" }),
    );
  });

  it("suppresses Home Assistant only while the direct receiver path is healthy and fresh", async () => {
    const transport: SourceTransport = {
      start: async (_onMessage, onState) => onState("connected"),
      stop: async () => undefined,
    };
    const connected = new Nexus433Service(
      { ...baseConfig, hostCapabilitiesFile: join(directory, "host-capabilities.json"), systemUpdateOperationsDirectory: directory },
      runtime.database,
      runtime.telemetry,
      () => transport,
    );
    try {
      await connected.configure({ houseId: "house-main", enabled: true, expectedRevision: 0 });
      connected.start();
      await vi.waitFor(() => expect(connected.status("house-main").brokerConnected).toBe(true));
      expect(connected.ingestMessage(`nexus433/sensor/${receiver}_5c01/state`, payload)).toBe("candidate");
      const candidate = connected.listCandidates("house-main")[0]!;
      connected.store.bindCandidate("house-main", candidate.id, "sensor-01");
      const acceptedAt = new Date();
      expect(connected.ingestMessage(`nexus433/sensor/${receiver}_5c01/state`, payload, false, acceptedAt)).toBe("accepted");
      expect(connected.isMetricAvailable("sensor-01", "temperature", acceptedAt)).toBe(true);
      expect(connected.isMetricAvailable("sensor-01", "humidity", new Date(acceptedAt.getTime() + 240_001))).toBe(false);
      connected.ingestMessage(
        `nexus433/sensor/${receiver}_5c01/connection`,
        Buffer.from("offline"),
        true,
        new Date(acceptedAt.getTime() + 1_000),
      );
      expect(connected.isMetricAvailable("sensor-01", "temperature", new Date(acceptedAt.getTime() + 1_000))).toBe(false);
      expect(connected.isMetricAvailable("sensor-01", "energy", acceptedAt)).toBe(false);
    } finally {
      await connected.stop();
    }
  });

  it("does not construct a transport while disabled", async () => {
    const factory = vi.fn<() => SourceTransport>();
    const disabled = new Nexus433Service(
      { ...baseConfig, hostCapabilitiesFile: null, systemUpdateOperationsDirectory: directory },
      runtime.database,
      runtime.telemetry,
      factory,
    );
    disabled.start();
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
    await disabled.stop();
  });
});
