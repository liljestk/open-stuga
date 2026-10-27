import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type {
  House,
  OpeningState,
  OpeningStateObservation,
} from "@climate-twin/contracts";
import { createApi, type ApiRuntime } from "../src/app.js";
import { deriveOpeningActivity } from "../src/analytics/temporal/opening-intervals.js";
import type { AppConfig } from "../src/config.js";
import type { HybridTelemetryReader } from "../src/timeseries/read-facade.js";

const start = "2026-07-28T00:00:00.000Z";
const end = "2026-07-28T04:00:00.000Z";

function house(overrides: Record<string, unknown> = {}): House {
  return {
    id: "home",
    propertyId: "property-home",
    name: "Home",
    timezone: "UTC",
    createdAt: start,
    updatedAt: start,
    floors: [{
      id: "ground",
      name: "Ground floor",
      type: "ground",
      width: 10,
      height: 8,
      elevation: 0,
      walls: [{ id: "north", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
      rooms: [],
      planElements: [{
        id: "front-door",
        kind: "door",
        label: "Front door",
        position: { x: 4, y: 0 },
        rotationDegrees: 0,
        width: 1,
        wallId: "north",
        variant: "exterior",
        stateBinding: {
          provider: "tapo",
          externalId: "t110-entry",
          staleAfterSeconds: 900,
          ...overrides,
        },
      }],
    }],
  };
}

function observation(
  id: string,
  observedAt: string,
  state: OpeningState,
  overrides: Partial<OpeningStateObservation> = {},
): OpeningStateObservation {
  return {
    id,
    houseId: "home",
    floorId: "ground",
    elementId: "front-door",
    state,
    source: "tapo",
    observedAt,
    externalId: "t110-entry",
    ...overrides,
  };
}

describe("canonical opening activity", () => {
  it("uses half-open validity and treats a post-expiry reading as initial", () => {
    const series = deriveOpeningActivity(house(), [
      observation("seed", "2026-07-28T00:55:00.000Z", "closed"),
      observation("open-1", "2026-07-28T01:00:00.000Z", "open"),
      observation("heartbeat", "2026-07-28T01:10:00.000Z", "open"),
      observation("close-after-expiry", "2026-07-28T01:25:00.000Z", "closed"),
      observation("open-2", "2026-07-28T01:30:00.000Z", "open"),
      observation("unknown", "2026-07-28T01:40:00.000Z", "unknown"),
      observation("close-2", "2026-07-28T01:50:00.000Z", "closed"),
    ], "2026-07-28T00:58:00.000Z", end)[0]!;

    expect(series).toMatchObject({
      openedCount: 2,
      closedCount: 0,
      observationCount: 6,
      confirmedOpenMs: 35 * 60_000,
      longestOpenMs: 25 * 60_000,
      currentState: "unknown",
    });
    expect(series.records.map((record) => record.transition)).toEqual([
      "opened",
      "initial",
      "opened",
      "unknown",
      "initial",
    ]);
    expect(series.segments).toContainEqual({
      state: "open",
      startedAt: "2026-07-28T01:00:00.000Z",
      endedAt: "2026-07-28T01:25:00.000Z",
    });
  });

  it("expires a declared validUntil at equality", () => {
    const series = deriveOpeningActivity(house({ staleAfterSeconds: 3_600 }), [
      observation("closed", "2026-07-27T23:50:00.000Z", "closed", {
        validUntil: "2026-07-28T01:00:00.000Z",
      }),
      observation("open", "2026-07-28T01:00:00.000Z", "open"),
    ], start, end)[0]!;

    expect(series.records).toEqual([
      expect.objectContaining({ id: "open", transition: "initial" }),
    ]);
    expect(series.openedCount).toBe(0);
  });

  it("uses the greatest id for duplicate observations at one timestamp", () => {
    const series = deriveOpeningActivity(house(), [
      observation("a-closed", "2026-07-28T01:00:00.000Z", "closed"),
      observation("z-open", "2026-07-28T01:00:00.000Z", "open"),
    ], start, end)[0]!;

    expect(series.observationCount).toBe(1);
    expect(series.records).toEqual([
      expect.objectContaining({ id: "z-open", state: "open", transition: "initial" }),
    ]);
  });

  it("deduplicates heartbeats, resets confidence on unknown, and excludes the range end", () => {
    const series = deriveOpeningActivity(house(), [
      observation("seed", "2026-07-28T00:55:00.000Z", "closed"),
      observation("open", "2026-07-28T01:00:00.000Z", "open"),
      observation("heartbeat", "2026-07-28T01:10:00.000Z", "open"),
      observation("unknown", "2026-07-28T01:15:00.000Z", "unknown"),
      observation("at-end", end, "closed"),
    ], "2026-07-28T00:58:00.000Z", end)[0]!;

    expect(series.observationCount).toBe(3);
    expect(series.records.map((record) => record.id)).toEqual(["open", "unknown"]);
    expect(series.openedCount).toBe(1);
  });

  it("applies inverted bindings before transition counting", () => {
    const series = deriveOpeningActivity(house({ invert: true }), [
      observation("seed", "2026-07-27T23:55:00.000Z", "closed"),
      observation("raw-open", "2026-07-28T01:00:00.000Z", "open"),
      observation("raw-close", "2026-07-28T01:10:00.000Z", "closed"),
    ], start, "2026-07-28T01:15:00.000Z")[0]!;

    expect(series.records.map((record) => record.state)).toEqual(["closed", "open"]);
    expect(series.openedCount).toBe(1);
    expect(series.currentState).toBe("open");
  });
});

const config: AppConfig = {
  port: 0,
  apiHost: "127.0.0.1",
  databasePath: ":memory:",
  integrationSecretsFile: "integration-secrets.test.json",
  assetDirectory: ".",
  mockEnabled: false,
  mockIntervalMs: 25,
  retentionDays: 730,
  ingestApiKey: null,
  haUrl: null,
  haToken: null,
  haEntityMapFile: null,
  tpLinkHost: null,
  tpLinkUsername: null,
  tpLinkPassword: null,
  tpLinkDeviceMapFile: null,
  tpLinkPollIntervalMs: 10_000,
  tpLinkPython: "python",
  tpLinkBridgeScript: "apps/api/python/tp_link_bridge.py",
  corsOrigin: null,
  localAuthTestBypass: true,
};

describe("opening activity API", () => {
  let runtime: ApiRuntime;

  beforeEach(() => {
    runtime = createApi({ config, startBackground: false });
    runtime.database.createHouse({
      id: "opening-house",
      name: "Opening house",
      timezone: "UTC",
      floors: [{
        id: "ground",
        name: "Ground floor",
        type: "ground",
        width: 10,
        height: 8,
        elevation: 0,
        walls: [{ id: "north", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }],
        rooms: [],
        planElements: [{
          id: "front-door",
          kind: "door",
          label: "Front door",
          position: { x: 4, y: 0 },
          rotationDegrees: 0,
          width: 1,
          wallId: "north",
          variant: "exterior",
        }],
      }],
    });
    runtime.database.activateRealDataMode();
    runtime.database.recordOpeningStateObservation("opening-house", {
      floorId: "ground",
      elementId: "front-door",
      state: "closed",
      source: "api",
      observedAt: "2026-07-27T23:55:00.000Z",
    });
    runtime.database.recordOpeningStateObservation("opening-house", {
      floorId: "ground",
      elementId: "front-door",
      state: "open",
      source: "api",
      observedAt: "2026-07-28T01:00:00.000Z",
    });
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("returns the server-owned derivation with provenance", async () => {
    const response = await request(runtime.app)
      .post("/api/v2/analytics/opening-activity")
      .send({
        apiVersion: "1.0",
        requestId: "opening-request",
        houseId: "opening-house",
        dataMode: "live",
        range: { start, end },
      })
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      apiVersion: "1.0",
      requestId: "opening-request",
      houseId: "opening-house",
      dataMode: "live",
      complete: true,
      truncated: false,
      archiveState: "not-configured",
      provenance: {
        algorithmKey: "opening-activity",
        algorithmVersion: "opening-activity-v2.0.0",
      },
      series: [{
        target: { elementId: "front-door", label: "Front door" },
        openedCount: 1,
      }],
    });
  });

  it("cancels opening evidence reads when the client disconnects", async () => {
    await runtime.close();
    let serverSignal: AbortSignal | undefined;
    const openingStateSnapshot = vi.fn(async (query: { signal?: AbortSignal }) => {
      serverSignal = query.signal;
      return { records: [], provenance: { archiveState: "not-configured" } };
    });
    const openingStateHistory = vi.fn((query: { signal?: AbortSignal }) => {
      serverSignal = query.signal;
      return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(query.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (query.signal?.aborted) abort();
        else query.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const telemetryReader = { openingStateSnapshot, openingStateHistory } as unknown as HybridTelemetryReader;
    runtime = createApi({
      config: { ...config, timeseriesPoolMax: 1 },
      telemetryReader,
      startBackground: false,
    });
    const server = createServer(runtime.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const clientController = new AbortController();

    try {
      const settled = fetch(`http://127.0.0.1:${address.port}/api/v2/analytics/opening-activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiVersion: "1.0",
          requestId: "opening-cancellation",
          houseId: "house-main",
          dataMode: "demo",
          range: { start, end },
        }),
        signal: clientController.signal,
      }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(serverSignal).toBeDefined(), { timeout: 2_000 });

      clientController.abort();

      await expect(settled).resolves.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(serverSignal?.aborted).toBe(true), { timeout: 2_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const health = await request(runtime.app).get("/api/v1/health").expect(200);
      expect(health.body.analytics.operations["opening-activity"]).toMatchObject({ cancelled: 1 });
      expect(openingStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({ signal: serverSignal }));
      expect(openingStateHistory).toHaveBeenCalledWith(expect.objectContaining({ signal: serverSignal }));
    } finally {
      clientController.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects cross-mode and invalid ranges", async () => {
    const base = {
      apiVersion: "1.0",
      requestId: "opening-request",
      houseId: "opening-house",
      dataMode: "demo",
      range: { start, end },
    };
    await request(runtime.app)
      .post("/api/v2/analytics/opening-activity")
      .send(base)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("ANALYTICS_DATA_MODE_MISMATCH"));
    await request(runtime.app)
      .post("/api/v2/analytics/opening-activity")
      .send({ ...base, dataMode: "live", range: { start: end, end: start } })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_OPENING_HISTORY_RANGE"));
  });
});
