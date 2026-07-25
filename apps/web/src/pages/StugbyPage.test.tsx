import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StugbyShareGrant, StugbySummary } from "@climate-twin/stugby-protocol";
import { api, type StugbyDetailResponse, type StugbyListResponse } from "../api";
import { I18nProvider } from "../i18n";
import { localDateTimeInput, StugbyPage } from "./StugbyPage";

afterEach(() => vi.restoreAllMocks());

const identity: StugbyListResponse["identity"] = {
  nodeId: "node-local",
  displayName: "Local Stuga",
  publicKey: "public",
  keyFingerprint: "fingerprint",
  protocolVersion: "2.0",
};

function summary(id: string, name: string): StugbySummary {
  return {
    id,
    name,
    description: null,
    coordinatorNodeId: "node-local",
    coordinatorUrl: "https://stuga.example.test",
    localRole: "steward",
    localMemberState: "active",
    memberCount: 1,
    createdAt: "2026-07-23T06:00:00.000Z",
    updatedAt: "2026-07-23T06:00:00.000Z",
    lastSyncAt: null,
    lastSyncError: null,
  };
}

function detail(stugby: StugbySummary, grants: StugbyShareGrant[] = []): StugbyDetailResponse {
  return {
    stugby,
    members: [{
      stugbyId: stugby.id,
      nodeId: "node-local",
      displayName: "Local Stuga",
      role: "steward",
      state: "active",
      publicKey: "public",
      keyFingerprint: "fingerprint",
      joinedAt: "2026-07-23T06:00:00.000Z",
      updatedAt: "2026-07-23T06:00:00.000Z",
    }],
    invitations: [],
    grants,
    sharedProperty: {
      stugbyId: stugby.id,
      name: `${stugby.name} grounds`,
      description: null,
      location: null,
      areas: [],
      equipment: [],
      notes: [],
      maintenance: [],
      editPolicy: "collaborative",
      authorityEpoch: 1,
      designatedSuccessorNodeId: null,
      revision: 1,
      updatedAt: "2026-07-23T06:00:00.000Z",
    },
    propertyAdoption: null,
    propertyConflicts: [],
    propertyCommandCounts: { pending: 0, conflicts: 0 },
    homeCommandCounts: { pending: 0, conflicts: 0 },
    homeProjections: [],
    authorityTransfers: [],
    remoteResources: [],
    deletionReceipts: [],
    audit: [],
  };
}

function mockLoadedStugbys(stugbys: StugbySummary[], details: Record<string, StugbyDetailResponse | Promise<StugbyDetailResponse>>) {
  vi.spyOn(api, "stugbys").mockResolvedValue({ identity, publicOrigin: "https://stuga.example.test", stugbys });
  vi.spyOn(api, "stugby").mockImplementation((id) => Promise.resolve(details[id]!));
  vi.spyOn(api, "stugbyTelemetry").mockResolvedValue({ samples: [] });
  vi.spyOn(api, "stugbyPublications").mockImplementation(async (_id, houseId) => ({
    house: { localHouseId: houseId, publicationId: `publication-${houseId}`, name: "Main Home" },
    sensors: [],
  }));
}

describe("StugbyPage", () => {
  it("asks for and saves a public coordinator origin before creation when none was detected", async () => {
    const user = userEvent.setup();
    const created = summary("stugby-a", "Configured Stugby");
    vi.spyOn(api, "stugbys")
      .mockResolvedValueOnce({
        identity,
        publicOrigin: null,
        suggestedPublicOrigin: "https://stuga.example.test",
        publicOriginConfigurable: true,
        stugbys: [],
      })
      .mockResolvedValue({ identity, publicOrigin: "https://stuga.example.test", stugbys: [created] });
    const configure = vi.spyOn(api, "configureStugbyCoordinator")
      .mockResolvedValue({ publicOrigin: "https://stuga.example.test" });
    const create = vi.spyOn(api, "createStugby").mockResolvedValue(created);
    vi.spyOn(api, "stugby").mockResolvedValue(detail(created));
    vi.spyOn(api, "stugbyTelemetry").mockResolvedValue({ samples: [] });

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    const createForm = (await screen.findByRole("heading", { name: "Create a Stugby" })).closest("form");
    expect(createForm).not.toBeNull();
    const coordinatorUrl = createForm!.querySelector<HTMLInputElement>('input[type="url"]');
    expect(coordinatorUrl).not.toBeNull();
    expect(coordinatorUrl!.value).toBe("https://stuga.example.test");
    await user.click(within(createForm!).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith("https://stuga.example.test"));
    expect(create).toHaveBeenCalledWith({ name: "My Stugby", description: null });
  });

  it("offers UI-managed Cloudflare setup to a new local installation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "stugbys").mockResolvedValue({
      identity,
      publicOrigin: "http://127.0.0.1:8080",
      publicOriginConfigurable: true,
      stugbys: [],
    });
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue({
      canConfigure: true,
      localConfigureUrl: "http://127.0.0.1:8080/stugbys",
      capability: {
        available: true,
        agentLastSeenAt: "2026-07-24T08:00:00.000Z",
        reason: "ready",
      },
      configuration: {
        configured: false,
        mode: null,
        hostname: null,
        suggestedZone: null,
        accountIdKnown: false,
        zoneIdKnown: false,
        oauthClientConfigured: false,
        runtimeTokenAvailable: false,
        ownerEmail: "owner@example.test",
      },
      operation: null,
    });

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    expect(await screen.findByText("Connect other homes securely")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Set up secure sharing" }));

    expect(await screen.findByLabelText(/^One-time OAuth client token/)).toBeTruthy();
    expect(screen.getByLabelText(/^Runtime Access group token/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Cloudflare" })).toBeTruthy();
  });

  it("keeps Cloudflare changes on the Stuga computer before coordinator creation", async () => {
    vi.spyOn(api, "stugbys").mockResolvedValue({
      identity,
      publicOrigin: null,
      suggestedPublicOrigin: "https://stuga.example.test",
      publicOriginConfigurable: false,
      stugbys: [],
    });
    vi.spyOn(api, "cloudflareSetupStatus").mockResolvedValue({
      canConfigure: false,
      localConfigureUrl: "http://127.0.0.1:8080/stugbys",
      capability: {
        available: true,
        agentLastSeenAt: "2026-07-24T08:00:00.000Z",
        reason: "ready",
      },
      configuration: {
        configured: true,
        mode: "remote-ui",
        hostname: "stuga.example.test",
        suggestedZone: "example.test",
        accountIdKnown: true,
        zoneIdKnown: true,
        oauthClientConfigured: false,
        runtimeTokenAvailable: true,
        ownerEmail: "owner@example.test",
      },
      operation: null,
    });

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    const createPanel = (await screen.findByRole("heading", { name: "Create a Stugby" })).closest("section");
    expect(createPanel).not.toBeNull();
    expect(createPanel!.querySelector('input[type="url"]')).toBeNull();
    expect(within(createPanel!).queryByRole("button", { name: "Create" })).toBeNull();
    expect(await within(createPanel!).findByText("Open this page on the Stuga computer")).toBeTruthy();
    expect(within(createPanel!).getByRole("link", { name: "Open local Stuga" }).getAttribute("href"))
      .toBe("http://127.0.0.1:8080/stugbys");
  });

  it("makes the deliberate federation boundary explicit before onboarding", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        identity: {
          nodeId: "node-local",
          displayName: "Local Stuga",
          publicKey: "public",
          keyFingerprint: "fingerprint",
          protocolVersion: "2.0",
        },
        publicOrigin: "https://stuga.example.test",
        stugbys: [],
      }),
    } as Response);
    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    expect(await screen.findByRole("heading", { name: "A deliberate sharing boundary" })).toBeTruthy();
    expect(screen.getByText(/Shared Homes are read-only unless their owner enables edits/)).toBeTruthy();
    expect(screen.getByText(/Integration settings, endpoints, credentials, secrets, account identities, controls and automations are never shared/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join without sharing" })).toBeTruthy();
  });

  it("pauses invitations when the stored coordinator origin is stale", async () => {
    const stugby = {
      ...summary("stugby-a", "North grounds"),
      coordinatorUrl: "http://127.0.0.1:8080",
    };
    mockLoadedStugbys([stugby], { [stugby.id]: detail(stugby) });
    const createInvitation = vi.spyOn(api, "createStugbyInvitation");

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);

    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Create one-time invitation" });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Invitations are paused until this Stugby's coordinator URL matches/)).toBeTruthy();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("deletes a closed Stugby from Advanced after explicit confirmation", async () => {
    const user = userEvent.setup();
    const stugby = summary("stugby-a", "Faulty Stugby");
    mockLoadedStugbys([stugby], { [stugby.id]: detail(stugby) });
    const listStugbys = vi.mocked(api.stugbys);
    const remove = vi.spyOn(api, "deleteStugby").mockImplementation(async () => {
      listStugbys.mockResolvedValue({ identity, publicOrigin: "https://stuga.example.test", stugbys: [] });
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    const summaryCard = (await screen.findByText("Automatic sync")).closest("section");
    expect(summaryCard).not.toBeNull();
    await user.click(within(summaryCard!).getByText("Advanced"));
    await user.click(within(summaryCard!).getByRole("button", { name: "Delete Stugby" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete Faulty Stugby permanently from this Stuga? Its roster, invitations, shared property, sharing records, and cached remote data will be removed. Local Homes and sensor data are unchanged.",
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith(stugby.id));
    expect(await screen.findByRole("heading", { name: "Create a Stugby" })).toBeTruthy();
    expect(screen.getByText("Faulty Stugby was deleted. Local Home data was unchanged.")).toBeTruthy();
  });

  it("has no automated accessibility violations in onboarding", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        identity,
        publicOrigin: "https://stuga.example.test",
        stugbys: [],
      }),
    } as Response);

    const { container } = render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    await screen.findByRole("heading", { name: "Create a Stugby" });
    const result = await axe.run(container, {
      rules: {
        // jsdom does not compute the visual styles needed for a reliable contrast result.
        "color-contrast": { enabled: false },
      },
    });

    expect(result.violations).toEqual([]);
  });

  it("clears the prior detail and locks selection until the chosen Stugby resolves", async () => {
    const user = userEvent.setup();
    const first = summary("stugby-a", "North grounds");
    const second = summary("stugby-b", "South grounds");
    let resolveSecond!: (value: StugbyDetailResponse) => void;
    const secondDetail = new Promise<StugbyDetailResponse>((resolve) => { resolveSecond = resolve; });
    mockLoadedStugbys([first, second], { [first.id]: detail(first), [second.id]: secondDetail });

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    await screen.findByText("No Home sharing grants have been created.");

    await user.click(screen.getByRole("button", { name: /South grounds/ }));

    expect(screen.queryByText("No Home sharing grants have been created.")).toBeNull();
    expect(screen.getByText("Loading the selected Stugby…")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /North grounds/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /South grounds/ }).disabled).toBe(true);

    resolveSecond(detail(second));
    await waitFor(() => expect(screen.getByRole("button", { name: /South grounds/ }).getAttribute("aria-current")).toBe("true"));
    expect(await screen.findByText("No Home sharing grants have been created.")).toBeTruthy();
  });

  it("keeps connected homes focused and applies the recommended sharing defaults in one action", async () => {
    const user = userEvent.setup();
    const stugby = summary("stugby-a", "North grounds");
    mockLoadedStugbys([stugby], { [stugby.id]: detail(stugby) });
    const createGrant = vi.spyOn(api, "createStugbyGrant").mockResolvedValue({} as StugbyShareGrant);

    render(<I18nProvider><StugbyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} /></I18nProvider>);
    const startSharing = await screen.findByRole("button", { name: "Start sharing" });

    const connectAnother = screen.getByText("Connect another Stugby").closest("details");
    expect(connectAnother?.open).toBe(false);
    expect(screen.getByText("Recommended home overview")).toBeTruthy();

    await user.click(startSharing);
    await waitFor(() => expect(createGrant).toHaveBeenCalledTimes(1));

    const input = createGrant.mock.calls[0]![1];
    expect(input.localHouseId).toBe("home-1");
    expect(input.audience).toEqual({ kind: "all-members", nodeIds: [] });
    expect(input.expiresAt).toBeNull();
    expect(input.housePolicy).toEqual({
      editPolicy: "read-only",
      recoveryMode: "none",
      designatedSuccessorNodeId: null,
    });
    expect(input.datasets.map((dataset) => dataset.dataset)).toEqual([
      "home.directory.v1",
      "home.structure.v1",
      "home.sensor-catalog.v1",
    ]);
  });

  it("resets an edited grant instead of carrying it into another Stugby", async () => {
    const user = userEvent.setup();
    const first = summary("stugby-a", "North grounds");
    const second = summary("stugby-b", "South grounds");
    const grant: StugbyShareGrant = {
      id: "grant-a",
      stugbyId: first.id,
      authorityNodeId: identity.nodeId,
      publicationId: "publication-a",
      localHouseId: "home-1",
      audience: { kind: "all-members", nodeIds: [] },
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode: "none",
        designatedSuccessorNodeId: null,
      },
      datasets: [{
        dataset: "home.location.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 30,
      }],
      epoch: 1,
      revision: 1,
      expiresAt: "2026-08-01T10:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-07-23T06:00:00.000Z",
      updatedAt: "2026-07-23T06:00:00.000Z",
    };
    mockLoadedStugbys([first, second], { [first.id]: detail(first, [grant]), [second.id]: detail(second) });

    render(<I18nProvider><StugbyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} /></I18nProvider>);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Update grant" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /South grounds/ }));
    expect(await screen.findByRole("button", { name: "Start sharing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update grant" })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^Precise location home\.location/ }).checked).toBe(false);
  });

  it("fails closed when the telemetry sensor catalog cannot be loaded", async () => {
    const user = userEvent.setup();
    const stugby = summary("stugby-a", "North grounds");
    mockLoadedStugbys([stugby], { [stugby.id]: detail(stugby) });
    vi.mocked(api.stugbyPublications).mockRejectedValue(new Error("Catalog unavailable"));

    render(<I18nProvider><StugbyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} /></I18nProvider>);
    await screen.findByRole("button", { name: "Start sharing" });
    await user.click(screen.getByText("Customize what is shared"));
    await user.click(screen.getByRole("checkbox", { name: /^Raw telemetry home\.telemetry/ }));
    await screen.findByText("Catalog unavailable");

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start sharing" }).disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "All sensors in this Home" })).toBeNull();
  });

  it("rejects a half-entered shared-property coordinate", async () => {
    const user = userEvent.setup();
    const stugby = summary("stugby-a", "North grounds");
    mockLoadedStugbys([stugby], { [stugby.id]: detail(stugby) });
    const update = vi.spyOn(api, "updateStugbyProperty");

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    await user.click(await screen.findByText("Shared property"));
    await user.type(await screen.findByLabelText("Latitude"), "60.17");
    await user.click(screen.getByRole("button", { name: "Save revision 2" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Enter both latitude and longitude");
    expect(update).not.toHaveBeenCalled();
  });

  it("converts UTC expiry instants to datetime-local wall time", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-180);
    expect(localDateTimeInput("2026-07-24T10:00:00.000Z")).toBe("2026-07-24T13:00");
  });
});
