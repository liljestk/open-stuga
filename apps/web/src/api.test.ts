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
} from "./api";
import { createDemoState } from "./domain";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local session API client", () => {
  it("includes cookie credentials on shared API requests", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stuga", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
        readOnly: false,
        grants: [],
      }),
    } as Response);

    await expect(api.session()).resolves.toMatchObject({ principal: { type: "local" } });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/session", expect.objectContaining({
      credentials: "include",
    }));
  });

  it("keeps the CSRF token in memory and adds it only to unsafe requests", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stuga", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
        readOnly: false,
        grants: [],
        csrfToken: "csrf-memory-only",
      }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "property-1", name: "Pine" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined } as Response);

    await api.session();
    await api.createProperty({ name: "Pine" });
    await api.logout();

    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("X-CSRF-Token")).toBeNull();
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("X-CSRF-Token")).toBe("csrf-memory-only");
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get("X-CSRF-Token")).toBe("csrf-memory-only");
  });

  it("forgets a stale CSRF token after an unauthorized response", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stuga", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
        readOnly: false,
        grants: [],
        csrfToken: "stale-csrf",
      }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "Sign in" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stuga", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
        readOnly: false,
        grants: [],
        csrfToken: "fresh-csrf",
      }) } as Response);

    await api.session();
    await expect(api.properties()).rejects.toMatchObject({ status: 401 });
    await api.login({ email: "owner@example.test", password: "correct horse battery staple" });

    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get("X-CSRF-Token")).toBeNull();
  });

  it("treats an already-expired session as a successful logout", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        authenticated: true,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stuga", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "guest" }],
        readOnly: true,
        grants: [],
        csrfToken: "expired-session-csrf",
      }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "Expired" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        authenticated: true,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stuga", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "guest" }],
        readOnly: true,
        grants: [],
        csrfToken: "new-session-csrf",
      }) } as Response);

    await api.session();
    await expect(api.logout()).resolves.toBeUndefined();
    await api.login({ email: "guest@example.test", password: "correct horse battery staple" });

    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("X-CSRF-Token")).toBe("expired-session-csrf");
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get("X-CSRF-Token")).toBeNull();
  });

  it("invalidates CSRF and never retries an unsafe mutation after CSRF rejection", async () => {
    const fetchMock = vi.mocked(fetch);
    const onAuthorization = vi.fn();
    const dispose = subscribeToApiAuthorizationChanges(onAuthorization);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stuga", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
        readOnly: false,
        grants: [],
        csrfToken: "rejected-csrf",
      }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { code: "CSRF_TOKEN_INVALID", message: "Refresh session" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: "property-2", name: "Lake" }) } as Response);

    await api.session();
    await expect(api.createProperty({ name: "Pine" })).rejects.toMatchObject({ status: 403, code: "CSRF_TOKEN_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onAuthorization).toHaveBeenCalledWith("changed");

    await api.createProperty({ name: "Lake" });
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get("X-CSRF-Token")).toBeNull();
    dispose();
  });

  it("rejects a response body that completes after its auth generation was cancelled", async () => {
    const fetchMock = vi.mocked(fetch);
    let resolveBody!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => { resolveBody = resolve; });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => body } as Response);

    const request = api.properties();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    cancelPendingApiRequests();
    expect(signal.aborted).toBe(true);
    resolveBody([{ id: "stale-property", name: "Old session" }]);

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("measurement API client", () => {
  it("sends the v2 forecast horizon as hours rather than the legacy horizonMinutes parameter", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ forecast: [] }),
    } as Response);

    await expect(api.measurementForecast("sensor/office", "co2", 6)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v2/measurements/forecast?sensorId=sensor%2Foffice&metric=co2&hours=6");
    expect(String(url)).not.toContain("horizonMinutes");
  });
});

describe("paged property collections", () => {
  it("loads every server page instead of silently truncating at 500 resources", async () => {
    const property = (index: number) => ({
      id: `property-${index}`,
      name: `Property ${index}`,
      description: null,
      location: null,
      createdAt: "2026-07-16T08:00:00.000Z",
      updatedAt: "2026-07-16T08:00:00.000Z",
    });
    const firstPage = Array.from({ length: COLLECTION_PAGE_SIZE }, (_, index) => property(index));
    const secondPage = [property(COLLECTION_PAGE_SIZE), property(COLLECTION_PAGE_SIZE + 1)];
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ properties: firstPage }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ properties: secondPage }) } as Response);

    await expect(api.properties()).resolves.toHaveLength(COLLECTION_PAGE_SIZE + secondPage.length);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/properties",
      `/api/v1/properties?limit=${COLLECTION_PAGE_SIZE}&offset=${COLLECTION_PAGE_SIZE}`,
    ]);
  });
});

describe("guest access API client", () => {
  it("returns the one-time registration token from a guest invitation", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        invitation: { email: "Guest@Example.test", role: "guest", grants: [] },
        registrationToken: "one-time-token",
        activationPath: "/activate?token=must-not-be-used-by-web",
        expiresAt: "2026-07-23T08:00:00.000Z",
      }),
    } as Response);

    await expect(api.inviteGuest("Guest@Example.test")).resolves.toMatchObject({
      invitation: { email: "guest@example.test" },
      registrationToken: "one-time-token",
    });
  });

  it("reads the canonical member wrapper when updating guest grants", async () => {
    const fetchMock = vi.mocked(fetch);
    const grants = [{ scopeType: "property" as const, scopeId: "property-pine" }];
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: { email: "Guest@Example.test", role: "guest", grants } }),
    } as Response);

    await expect(api.updateMemberAccess("Guest@Example.test", grants)).resolves.toEqual({
      email: "guest@example.test",
      role: "guest",
      grants,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tenant/members/Guest%40Example.test/access",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ grants }) }),
    );
  });

  it("removes a guest through the owner-only member endpoint", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as Response);

    await expect(api.removeTenantMember(" Guest@Example.test ")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tenant/members/guest%40example.test",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("maintenance task API client", () => {
  it("combines property, house, area, and equipment list filters", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ maintenanceTasks: [] }) } as Response);

    await expect(api.maintenanceTasks({
      propertyId: "property/main",
      houseId: "house main",
      areaId: "area/well",
      equipmentId: "pump #1",
    })).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/maintenance-tasks?propertyId=property%2Fmain&houseId=house+main&areaId=area%2Fwell&equipmentId=pump+%231",
      expect.any(Object),
    );
  });

  it("loads one maintenance task through its scoped item endpoint", async () => {
    const task = { id: "task/main", title: "Inspect pump" };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => task } as Response);

    await expect(api.maintenanceTask(task.id)).resolves.toEqual(task);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/maintenance-tasks/task%2Fmain");
  });
});

describe("live event client", () => {
  it("subscribes to provider-neutral named weather events", () => {
    class FakeEventSource {
      static latest: FakeEventSource | null = null;
      readonly listeners = new Map<string, EventListener>();
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      closed = false;

      constructor(readonly url: string, readonly options?: EventSourceInit) {
        FakeEventSource.latest = this;
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") this.listeners.set(type, listener);
      }

      close(): void {
        this.closed = true;
      }

      emit(type: string, data: unknown): void {
        this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();
    const onState = vi.fn();
    const onAuthorization = vi.fn();
    const disposeAuthorization = subscribeToApiAuthorizationChanges(onAuthorization);
    const dispose = subscribeToEvents(onEvent, onState);
    const source = FakeEventSource.latest;
    expect(source?.url).toBe("/api/v1/events");
    expect(source?.options).toEqual({ withCredentials: true });
    expect(source?.listeners.has("weather")).toBe(true);
    expect(source?.listeners.has("mutation")).toBe(true);

    source?.emit("weather", {
      id: `weather-${"a".repeat(64)}`,
      type: "weather.snapshot",
      houseId: "house-main",
      publishedAt: "2026-07-15T08:00:00.000Z",
      trigger: "scheduled-refresh",
      weather: { houseId: "house-main" },
    });

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "weather",
      data: expect.objectContaining({ type: "weather.snapshot", houseId: "house-main" }),
    }));
    source?.emit("mutation", {
      method: "PATCH",
      resource: "/sensors/sensor-main",
      occurredAt: "2026-07-16T12:01:00.000Z",
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "mutation",
      data: {
        method: "PATCH",
        resource: "/sensors/sensor-main",
        occurredAt: "2026-07-16T12:01:00.000Z",
      },
    });
    source?.emit("heartbeat", {
      timestamp: "2026-07-16T12:00:00.000Z",
      mode: "polling-compatibility",
      continuous: false,
      finite: true,
      reconnectAfterMs: 60_000,
    });
    expect(onState).toHaveBeenCalledWith("reconnecting");
    source?.emit("authorization", { data: { status: "expired" } });
    source?.emit("authorization", { data: { status: "expired" } });
    expect(source?.closed).toBe(true);
    expect(onAuthorization).toHaveBeenNthCalledWith(1, "expired");
    expect(onAuthorization).toHaveBeenNthCalledWith(2, "expired");
    dispose();
    expect(source?.closed).toBe(true);

    const measurementState = vi.fn();
    const disposeMeasurements = subscribeToMeasurementEvents(vi.fn(), measurementState);
    expect(FakeEventSource.latest?.url).toBe("/api/v2/measurements/events");
    expect(FakeEventSource.latest?.options).toEqual({ withCredentials: true });
    FakeEventSource.latest?.emit("authorization", { data: { status: "changed" } });
    expect(FakeEventSource.latest?.closed).toBe(true);
    expect(measurementState).toHaveBeenCalledWith("reconnecting");
    expect(onAuthorization).toHaveBeenLastCalledWith("changed");
    disposeMeasurements();

    const spatialState = vi.fn();
    const disposeSpatial = subscribeToSpatialLayerEvents("house-main", vi.fn(), spatialState);
    expect(FakeEventSource.latest?.url).toContain("/api/v1/layers/events?");
    FakeEventSource.latest?.emit("authorization", { data: { status: "expired" } });
    expect(FakeEventSource.latest?.closed).toBe(true);
    expect(spatialState).toHaveBeenCalledWith("reconnecting");
    expect(onAuthorization).toHaveBeenLastCalledWith("expired");
    disposeSpatial();
    disposeAuthorization();
  });
});

describe("thermal simulation API client", () => {
  it("encodes the calibration window and optional weather scenario", async () => {
    const simulation = { sensorId: "sensor/office", points: [] };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ simulation }) } as Response);

    await expect(api.thermalSimulation("house/main", {
      sensorId: "sensor/office",
      from: "2026-07-13T10:00:00.000Z",
      to: "2026-07-14T10:00:00.000Z",
      horizonHours: 12,
      scenarioOutdoorTemperatureC: -10,
    })).resolves.toEqual(simulation);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/houses/house%2Fmain/thermal-simulation?sensorId=sensor%2Foffice&from=2026-07-13T10%3A00%3A00.000Z&to=2026-07-14T10%3A00%3A00.000Z&horizonHours=12&scenarioOutdoorTemperatureC=-10");
  });
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
