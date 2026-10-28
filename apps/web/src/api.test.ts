import { SYSTEM_VERSION } from "@climate-twin/contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  api,
  apiFamilies,
  cancelPendingApiRequests,
  COLLECTION_PAGE_SIZE,
  subscribeToApiAuthorizationChanges,
  subscribeToEvents,
  subscribeToMeasurementEvents,
  subscribeToSpatialLayerEvents,
  subscribeToSystemUpdateEvents,
  subscribeToTrackingEvents,
} from "./api";

import "./apiTestSupport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client facade", () => {
  it("defines each client method in exactly one endpoint family", () => {
    const families = Object.values(apiFamilies);
    const methods = families.reduce((count, family) => count + Object.keys(family).length, 0);
    expect(Object.keys(api)).toHaveLength(methods);
  });
});

describe("local session API client", () => {
  it("refuses an unverifiable or mismatched API runtime before bootstrapping", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Api-Version": "v1" },
      }))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Version": "v1",
          "X-Stugu-System-Version": "0.28.0",
        },
      }));

    await expect(api.session()).rejects.toMatchObject({
      name: "ApiVersionMismatchError",
      code: "API_RUNTIME_VERSION_MISMATCH",
      expectedVersion: SYSTEM_VERSION,
      actualVersion: null,
    });
    await expect(api.session()).rejects.toMatchObject({
      name: "ApiVersionMismatchError",
      expectedVersion: SYSTEM_VERSION,
      actualVersion: "0.28.0",
    });
  });

  it("rejects a stale session document when a cross-origin proxy hides version headers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      systemVersion: "0.28.0",
      authenticated: true,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(api.session()).rejects.toMatchObject({
      name: "ApiVersionMismatchError",
      expectedVersion: SYSTEM_VERSION,
      actualVersion: "0.28.0",
    });
  });

  it("includes cookie credentials on shared API requests", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        systemVersion: SYSTEM_VERSION,
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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
        systemVersion: SYSTEM_VERSION,
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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
        systemVersion: SYSTEM_VERSION,
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
        readOnly: false,
        grants: [],
        csrfToken: "stale-csrf",
      }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "Sign in" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        systemVersion: SYSTEM_VERSION,
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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
        systemVersion: SYSTEM_VERSION,
        authenticated: true,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
        readOnly: true,
        grants: [],
        csrfToken: "expired-session-csrf",
      }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "Expired" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        systemVersion: SYSTEM_VERSION,
        authenticated: true,
        principal: { type: "local", email: "guest@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "guest" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "guest" }],
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
        systemVersion: SYSTEM_VERSION,
        authenticated: true,
        principal: { type: "local", email: "owner@example.test" },
        tenant: { id: "local", name: "Local Stugu", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
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

describe("equipment tracking API client", () => {
  it("uses endpoint enrollment, equipment binding, and live-map endpoints", async () => {
    const endpoint = {
      id: "endpoint/main",
      propertyId: "property/main",
      displayName: "Garden beacon",
      profileId: "org.bluetooth.ibeacon",
      claimStatus: "CLAIMED",
    };
    const binding = {
      id: "binding/main",
      equipmentId: "equipment/main",
      endpointId: endpoint.id,
      validFrom: "2026-07-26T08:00:00.000Z",
      validTo: null,
      boundBy: "owner",
    };
    const capabilities = { flags: { "tracking.enabled": true } };
    const snapshot = {
      propertyId: "property/main",
      dataMode: "live",
      generatedAt: "2026-07-26T08:01:00.000Z",
      sequence: 1,
      equipment: [],
      members: [],
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => capabilities } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ endpoints: [endpoint] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ endpoint }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ binding }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ binding: null }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => snapshot } as Response);

    await expect(api.trackingCapabilities()).resolves.toEqual(capabilities);
    await expect(api.trackingEndpoints("property/main")).resolves.toEqual([endpoint]);
    await expect(api.enrollTrackingEndpoint({
      propertyId: "property/main",
      profileId: "org.bluetooth.ibeacon",
      profileVersion: "1.0.0",
      identityFields: { uuid: "00112233-4455-6677-8899-aabbccddeeff", major: "1", minor: "2" },
      displayName: "Garden beacon",
      proof: { kind: "PHYSICAL_ACCESS" },
    })).resolves.toEqual(endpoint);
    await expect(api.bindTrackingEndpoint("equipment/main", endpoint.id)).resolves.toEqual(binding);
    await expect(api.unbindTrackingEndpoint("equipment/main")).resolves.toBeNull();
    await expect(api.trackingMapSnapshot("property/main")).resolves.toEqual(snapshot);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/tracking/capabilities",
      "/api/v1/tracking/endpoints?propertyId=property%2Fmain",
      "/api/v1/tracking/endpoints",
      "/api/v1/area-equipment/equipment%2Fmain/tracking-binding",
      "/api/v1/area-equipment/equipment%2Fmain/tracking-binding",
      "/api/v1/properties/property%2Fmain/tracking-map-snapshot",
    ]);
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ endpointId: "endpoint/main" }),
    }));
    expect(fetchMock.mock.calls[4]?.[1]).toEqual(expect.objectContaining({ method: "DELETE" }));
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

describe("daily analytics findings API client", () => {
  it("loads the latest house-scoped snapshot from v2", async () => {
    const result = { snapshot: null, status: { state: "pending", lastAttemptAt: null, lastError: null } } as const;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => result } as Response);

    await expect(api.analyticsFindings("house/main")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/analytics/findings?houseId=house%2Fmain",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("unified system update API client", () => {
  it("posts an exact revision-bound host activation to the canonical endpoint", async () => {
    const result = { revision: 13 };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => result } as Response);
    const input = {
      action: "activate-host" as const,
      expectedRevision: 12,
      workflowId: "65ee172f-8ec3-4ff1-a52b-3468b33c5791",
      hostOperationId: "80d65f28-33cc-4424-b72f-47be89c275ab",
      targetVersion: "0.35.0",
      targetGeneration: 3,
      targetDigest: `sha256:${"d".repeat(64)}`,
      confirmation: "RESTART_AND_INSTALL" as const,
    };

    await expect(api.operateSystemUpdate(input)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/system/updates/operations",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
  });
});

describe("opening activity API client", () => {
  it("posts a versioned server-side derivation request to v2", async () => {
    const input = {
      apiVersion: "1.0" as const,
      requestId: "opening-client-test",
      houseId: "house/main",
      dataMode: "live" as const,
      range: {
        start: "2026-07-28T00:00:00.000Z",
        end: "2026-07-29T00:00:00.000Z",
      },
    };
    const result = {
      ...input,
      generatedAt: input.range.end,
      complete: true,
      truncated: false,
      archiveState: "not-configured",
      series: [],
      warnings: [],
      provenance: {
        algorithmKey: "opening-activity",
        algorithmVersion: "opening-activity-v2.0.0",
        evaluatedAt: input.range.end,
        sourceIds: [],
        archiveState: "not-configured",
      },
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => result } as Response);

    await expect(api.openingActivity(input)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/analytics/opening-activity",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        credentials: "include",
      }),
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
    expect(source?.url).toBe("/api/v1/stream");
    expect(source?.options).toEqual({ withCredentials: true });
    expect(source?.listeners.has("weather")).toBe(true);
    expect(source?.listeners.has("opening")).toBe(true);
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
    source?.emit("opening", {
      id: "opening-live",
      houseId: "house-main",
      floorId: "floor-main",
      elementId: "door-main",
      state: "open",
      source: "tapo",
      observedAt: "2026-07-16T12:01:01.000Z",
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "opening",
      data: expect.objectContaining({
        id: "opening-live",
        houseId: "house-main",
        state: "open",
      }),
    });
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

    const trackingRefresh = vi.fn();
    const trackingState = vi.fn();
    const disposeTracking = subscribeToTrackingEvents("property/main", trackingRefresh, trackingState);
    const trackingSource = FakeEventSource.latest;
    expect(trackingSource?.url).toBe("/api/v1/properties/property%2Fmain/tracking-stream");
    expect(trackingSource?.listeners.has("equipment.position.updated")).toBe(true);
    expect(trackingSource?.listeners.has("member.location.updated")).toBe(true);
    trackingSource?.onopen?.(new Event("open"));
    expect(trackingState).toHaveBeenLastCalledWith("live");
    trackingSource?.emit("member.location.updated", {
      id: "event-1",
      sequence: 2,
      propertyId: "property/main",
      type: "member.location.updated",
      occurredAt: "2026-07-26T08:00:00.000Z",
      subjectId: "member-1",
      payload: { active: true },
    });
    expect(trackingRefresh).toHaveBeenCalledWith(expect.objectContaining({
      type: "member.location.updated",
      sequence: 2,
    }));
    trackingSource?.emit("snapshot-required", {});
    expect(trackingRefresh).toHaveBeenLastCalledWith(null);
    disposeTracking();
    expect(trackingSource?.closed).toBe(true);

    const updateStatus = vi.fn();
    const updateState = vi.fn();
    const disposeUpdates = subscribeToSystemUpdateEvents(updateStatus, updateState);
    const updateSource = FakeEventSource.latest;
    expect(updateSource?.url).toBe("/api/v1/system/updates/events");
    expect(updateSource?.options).toEqual({ withCredentials: true });
    updateSource?.onopen?.(new Event("open"));
    updateSource?.emit("system-update", {
      currentVersion: "0.5.0",
      latestVersion: "0.6.0",
      updateAvailable: true,
      capability: { available: true },
      operation: null,
    });
    expect(updateState).toHaveBeenCalledWith("live");
    expect(updateStatus).toHaveBeenCalledWith(expect.objectContaining({ currentVersion: "0.5.0" }));
    updateSource?.emit("system-update", {
      schema: "stugu-system-updates/v2",
      revision: 7,
      currentVersion: "0.5.0",
      latestVersion: "0.6.0",
      updateAvailable: true,
      capability: { available: true },
      operation: null,
      application: { currentVersion: "0.5.0" },
      host: { readyToRestart: null },
      workflow: {
        id: "65ee172f-8ec3-4ff1-a52b-3468b33c5791",
        revision: 7,
        phase: "host-stage-requested",
        targets: {
          applicationVersion: "0.6.0",
          hostVersion: "0.35.0",
          hostGeneration: 3,
          hostDigest: `sha256:${"d".repeat(64)}`,
        },
      },
    });
    expect(updateStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      revision: 7,
      workflow: expect.objectContaining({ phase: "host-stage-requested" }),
    }));
    const validatedUpdateCount = updateStatus.mock.calls.length;
    updateSource?.emit("system-update", {
      currentVersion: "0.5.0",
      latestVersion: "0.6.0",
      updateAvailable: true,
      capability: { available: true },
      operation: null,
      workflow: { id: "bad", revision: 8, phase: "invented-phase", targets: {} },
    });
    expect(updateStatus).toHaveBeenCalledTimes(validatedUpdateCount);
    updateSource?.onerror?.(new Event("error"));
    expect(updateState).toHaveBeenLastCalledWith("reconnecting");
    disposeUpdates();
    expect(updateSource?.closed).toBe(true);
    disposeAuthorization();
  });
});
