import type { House, HouseWeather, ManualObservation, ManualObservationInput, Sensor, TpLinkDiscoveredDevice } from "@climate-twin/contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  api,
  cancelPendingApiRequests,
  COLLECTION_PAGE_SIZE,
  subscribeToApiAuthorizationChanges,
  subscribeToEvents,
  subscribeToMeasurementEvents,
  subscribeToSpatialLayerEvents,
  subscribeToSystemUpdateEvents,
  subscribeToTrackingEvents,
} from "./api";

import { createDemoState } from "./domain";

import "./apiTestSupport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sensor management API client", () => {
  const sensor: Sensor = {
    id: "sensor/hall",
    houseId: "house-main",
    floorId: "floor-ground",
    name: "Hall sensor",
    room: "Hall",
    model: "Tapo T315",
    x: 4,
    y: 3,
    z: 1.4,
    tpLinkDeviceId: "child-315",
    tags: [],
    enabled: true,
  };

  it("lists either the workspace sensor index or one home's sensors", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sensors: [sensor] }),
    } as Response);

    await expect(api.sensors()).resolves.toEqual([sensor]);
    await expect(api.sensors("house/main")).resolves.toEqual([sensor]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/sensors");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/sensors?houseId=house%2Fmain");
  });

  it("creates and patches sensors through the canonical wrapped endpoints", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ sensor }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sensor: { ...sensor, name: "Upper hall" } }) } as Response);

    const { id: _id, ...input } = sensor;
    await expect(api.createSensor(input)).resolves.toEqual(sensor);
    await expect(api.updateSensor(sensor.id, { name: "Upper hall" })).resolves.toMatchObject({ name: "Upper hall" });

    expect(fetchMock.mock.calls[0]).toEqual(["/api/v1/sensors", expect.objectContaining({ method: "POST", body: JSON.stringify(input) })]);
    expect(fetchMock.mock.calls[1]).toEqual(["/api/v1/sensors/sensor%2Fhall", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Upper hall" }) })]);
  });

  it("loads sanitized discovered TP-Link children", async () => {
    const device: TpLinkDiscoveredDevice = {
      deviceId: "child-315",
      model: "T315",
      alias: "Hall",
      status: "online",
      temperature: 21.4,
      humidity: 45,
      battery: 92,
      lastSeenAt: "2026-07-14T12:00:00.000Z",
      mappedSensorId: sensor.id,
    };
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ devices: [device] }) } as Response);

    await expect(api.tpLinkDevices()).resolves.toEqual([device]);
    expect(fetch).toHaveBeenCalledWith("/api/v1/integrations/tp-link/devices", expect.any(Object));
  });

  it("surfaces the server validation message", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "TP_LINK_DEVICE_ALREADY_MAPPED", message: "This TP-Link device is already mapped" } }),
    } as Response);

    await expect(api.updateSensor(sensor.id, { tpLinkDeviceId: "duplicate" })).rejects.toMatchObject({
      status: 409,
      code: "TP_LINK_DEVICE_ALREADY_MAPPED",
      message: "This TP-Link device is already mapped",
    });
  });
});

describe("TP-Link history export API client", () => {
  it("lists, retries, and cancels durable export jobs", async () => {
    const job = {
      id: "job/315",
      canary: false,
      provider: "appium" as const,
      sensorId: "sensor-hall",
      deviceId: "device-315",
      deviceName: "Hall sensor",
      timeZone: "Europe/Helsinki",
      metric: "temperature",
      expectedRecipient: "history+job-315@example.test",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
      intervalMinutes: 15,
      status: "failed" as const,
      attemptCount: 2,
      maxAttempts: 3,
      availableAt: "2026-07-02T01:00:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      submittedAt: null,
      mailboxMessageId: null,
      sourceArtifactSha256: null,
      sourceArtifactBytes: null,
      parserVersion: null,
      sourceSchemaSignature: null,
      stagedSampleCount: 0,
      consumedSampleCount: 0,
      lastError: "Mailbox timeout",
      attentionReason: null,
      detail: "Mailbox timeout",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T01:00:00.000Z",
      completedAt: null,
    };
    const automation = {
      operational: true,
      canaryPending: false,
      waitingEmails: 0,
      maxPendingEmails: 1,
      exportIntervalMinutes: 15 as const,
      canaryApprovalMaxAgeDays: 30,
      mailbox: {
        lastSuccessfulPollAt: null,
        lastErrorAt: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
        budgetExhaustions: 0,
      },
      lastWorkerSeenAt: null,
      deploymentFingerprintPrefix: null,
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ enabled: true, automation, jobs: [job] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined } as Response);

    await expect(api.tpLinkHistoryExportJobs()).resolves.toEqual({ enabled: true, automation, jobs: [job] });
    await expect(api.retryTpLinkHistoryExportJob(job.id)).resolves.toBeUndefined();
    await expect(api.cancelTpLinkHistoryExportJob(job.id)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/integrations/tp-link/history-export/jobs");
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/v1/integrations/tp-link/history-export/jobs/job%2F315/retry",
      expect.objectContaining({ method: "POST" }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/v1/integrations/tp-link/history-export/jobs/job%2F315",
      expect.objectContaining({ method: "DELETE" }),
    ]);
  });
});

describe("house weather API client", () => {
  const house: House = {
    id: "house/coast",
    propertyId: "property-coast",
    name: "Coast house",
    timezone: "Europe/Helsinki",
    location: { latitude: 60.17, longitude: 24.94, label: "Helsinki" },
    floors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("rejects traversal segments before issuing a request", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();

    await expect(api.deleteHouse("..")).rejects.toThrow("Invalid API request path");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates, updates, and removes independent house layouts", async () => {
    const floor = {
      id: "floor-attic", name: "Attic studio", type: "attic" as const,
      width: 12, height: 8, elevation: 5.8, ceilingHeight: 2.4, walls: [], rooms: [],
    };
    const created = { ...house, id: "house/lake", name: "Lake house", floors: [floor] };
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ house: created }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ house: { ...created, name: "Lake cabin" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined } as Response);

    const input = { name: created.name, timezone: created.timezone, floors: created.floors };
    await expect(api.createHouse(input)).resolves.toEqual(created);
    await expect(api.updateHouse(created.id, { name: "Lake cabin", floors: created.floors })).resolves.toMatchObject({ name: "Lake cabin" });
    await expect(api.deleteHouse(created.id)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]).toEqual(["/api/v1/houses", expect.objectContaining({ method: "POST", body: JSON.stringify(input) })]);
    expect(fetchMock.mock.calls[1]).toEqual(["/api/v1/houses/house%2Flake", expect.objectContaining({ method: "PATCH" })]);
    expect(fetchMock.mock.calls[2]).toEqual(["/api/v1/houses/house%2Flake", expect.objectContaining({ method: "DELETE" })]);
  });

  it("patches a house location and unwraps the house response", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ house }),
    } as Response);

    await expect(api.updateHouseLocation(house.id, house.location!)).resolves.toEqual(house);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/houses/house%2Fcoast");
    expect(options).toMatchObject({ method: "PATCH", body: JSON.stringify({ location: house.location }) });
  });

  it("patches orientation without resending or clearing location", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ house: { ...house, orientationDegrees: 270 } }),
    } as Response);

    await expect(api.updateHouseGeoreference(house.id, { orientationDegrees: 270 })).resolves.toMatchObject({ orientationDegrees: 270 });

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options).toMatchObject({ method: "PATCH", body: JSON.stringify({ orientationDegrees: 270 }) });
    expect(String(options?.body)).not.toContain("location");
  });

  it("patches precise map placement independently from the weather location", async () => {
    const mapPlacement = { latitude: 60.17001, longitude: 24.94002, metersPerPlanUnit: 0.012 };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ house: { ...house, mapPlacement } }),
    } as Response);

    await expect(api.updateHouseGeoreference(house.id, { mapPlacement })).resolves.toMatchObject({ mapPlacement });

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options).toMatchObject({ method: "PATCH", body: JSON.stringify({ mapPlacement }) });
    expect(String(options?.body)).not.toContain('"location"');
  });

  it("requests a 48-hour house forecast and unwraps the weather response", async () => {
    const weather: HouseWeather = {
      houseId: house.id,
      location: house.location!,
      provider: "fmi",
      attribution: "Finnish Meteorological Institute open data",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      forecastIssuedAt: null,
      stale: false,
      current: null,
      observationStation: null,
      forecast: [],
      warnings: [],
      unavailable: [],
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ weather }),
    } as Response);

    await expect(api.houseWeather(house.id, 48)).resolves.toEqual(weather);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/houses/house%2Fcoast/weather?hours=48", expect.any(Object));
  });

  it("loads the Home-safe effective electricity price without a Property contract response", async () => {
    const current = {
      startAt: "2026-07-17T10:00:00.000Z",
      endAt: "2026-07-17T10:15:00.000Z",
      effectivePriceCentsPerKwh: 5.5,
      effectivePriceEurPerKwh: 0.055,
      fetchedAt: "2026-07-17T09:59:00.000Z",
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ current }) } as Response);

    await expect(api.houseElectricityPrice(house.id)).resolves.toEqual({ current });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/houses/house%2Fcoast/electricity-price",
      expect.any(Object),
    );

    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ current, prices: [current] }) } as Response);
    await expect(api.houseElectricityPrice(house.id, current.startAt, current.endAt)).resolves.toEqual({ current, prices: [current] });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/houses/house%2Fcoast/electricity-price?from=${encodeURIComponent(current.startAt)}&to=${encodeURIComponent(current.endAt)}`,
      expect.any(Object),
    );
  });
});

describe("observation API client", () => {
  const observation: ManualObservation = {
    id: "observation/roof",
    houseId: "house-main",
    floorId: "floor-attic",
    sensorId: null,
    kind: "maintenance",
    severity: "warning",
    note: "Roof remained wet",
    x: 3,
    y: 2,
    occurredAt: "2026-01-01",
    createdAt: "2026-07-15T10:00:00.000Z",
    timePrecision: "date-range",
    validFrom: "2026-01-01",
    validTo: "2026-01-31",
    source: "contractor",
    sourceDetail: "Winter inspection",
    confidence: "awaiting-inspection",
    revision: 1,
    updatedAt: "2026-07-15T10:00:00.000Z",
  };

  it("preserves temporal provenance and uses revision-guarded update endpoints", async () => {
    const input: ManualObservationInput = {
      houseId: observation.houseId,
      floorId: observation.floorId,
      sensorId: null,
      kind: observation.kind,
      severity: observation.severity,
      note: observation.note,
      x: observation.x,
      y: observation.y,
      timePrecision: "date-range",
      validFrom: "2026-01-01",
      validTo: "2026-01-31",
      source: "contractor",
      sourceDetail: "Winter inspection",
      confidence: "awaiting-inspection",
    };
    const patch = { baseRevision: 1, confidence: "confirmed" as const };
    const updated = { ...observation, confidence: "confirmed" as const, revision: 2 };
    const revision = {
      observationId: observation.id,
      revision: 2,
      changedAt: "2026-07-15T11:00:00.000Z",
      actor: "local-rest" as const,
      changedFields: ["confidence" as const],
      snapshot: updated,
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ observation }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ observation: updated }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ revisions: [revision] }) } as Response);

    await expect(api.createObservation(input)).resolves.toEqual(observation);
    await expect(api.updateObservation(observation.id, patch)).resolves.toEqual(updated);
    await expect(api.observationRevisions(observation.id)).resolves.toEqual([revision]);

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/v1/observations", expect.objectContaining({ method: "POST", body: JSON.stringify(input) }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/observations/observation%2Froof", expect.objectContaining({ method: "PATCH", body: JSON.stringify(patch) }));
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/v1/observations/observation%2Froof/revisions", expect.any(Object));
  });
});

describe("automation integration API client", () => {
  it("uses the Telegram discovery, configuration, test, and disconnect contracts", async () => {
    const integration = createDemoState().integration;
    const discovery = {
      botUsername: "stuga_bot",
      chats: [{ id: "99112233", label: "Home alerts", username: null, type: "private" as const }],
      message: "Found one chat",
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => discovery } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, configured: true, integration }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, message: "Delivered" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, integration }) } as Response);

    await expect(api.discoverTelegram("bot-secret")).resolves.toEqual(discovery);
    await expect(api.configureTelegram({ botToken: "bot-secret", chatId: "99112233" })).resolves.toMatchObject({ configured: true });
    await expect(api.testTelegram()).resolves.toEqual({ ok: true, message: "Delivered" });
    await expect(api.disconnectTelegram()).resolves.toMatchObject({ ok: true, integration });

    expect(fetchMock.mock.calls[0]).toEqual(["/api/v1/integrations/telegram/discover", expect.objectContaining({ method: "POST", body: JSON.stringify({ botToken: "bot-secret" }) })]);
    expect(fetchMock.mock.calls[1]).toEqual(["/api/v1/integrations/telegram/config", expect.objectContaining({ method: "PUT", body: JSON.stringify({ botToken: "bot-secret", chatId: "99112233" }) })]);
    expect(fetchMock.mock.calls[2]).toEqual(["/api/v1/integrations/telegram/test", expect.objectContaining({ method: "POST" })]);
    expect(fetchMock.mock.calls[3]).toEqual(["/api/v1/integrations/telegram/config", expect.objectContaining({ method: "DELETE" })]);
  });

  it("loads setup metadata and manages one-time Apple Notes grants", async () => {
    const state = createDemoState();
    const integration = state.integration;
    const grant = { id: "grant/device", deviceLabel: "Niklas iPhone", houseId: state.houses[0]!.id, createdAt: "2026-07-15T10:00:00.000Z" };
    const createdGrant = { ...grant, token: "one-time-token", integration };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ available: true }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ grants: [grant] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => createdGrant } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, integration }) } as Response);

    await expect(api.appleNotesSetup()).resolves.toEqual({ available: true });
    await expect(api.appleNotesGrants()).resolves.toEqual([grant]);
    await expect(api.createAppleNotesGrant({ houseId: grant.houseId, deviceLabel: grant.deviceLabel })).resolves.toEqual(createdGrant);
    await expect(api.revokeAppleNotesGrant(grant.id)).resolves.toMatchObject({ ok: true, integration });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/integrations/apple-notes/setup");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/integrations/apple-notes/grants");
    expect(fetchMock.mock.calls[2]).toEqual(["/api/v1/integrations/apple-notes/grants", expect.objectContaining({ method: "POST", body: JSON.stringify({ houseId: grant.houseId, deviceLabel: grant.deviceLabel }) })]);
    expect(fetchMock.mock.calls[3]).toEqual(["/api/v1/integrations/apple-notes/grants/grant%2Fdevice", expect.objectContaining({ method: "DELETE" })]);
  });

  it("patches Telegram delivery independently on an alert rule", async () => {
    const rule = { ...createDemoState().alertRules[0]!, telegramEnabled: true };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ rule }) } as Response);

    await expect(api.updateAlertRule("rule/high humidity", { telegramEnabled: true })).resolves.toEqual(rule);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/alert-rules/rule%2Fhigh%20humidity", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ telegramEnabled: true }) }));
  });
});
