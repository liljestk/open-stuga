import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StugubyShareGrant, StugubySummary } from "@climate-twin/stuguby-protocol";
import { api, type StugubyDetailResponse, type StugubyListResponse } from "../api";
import { I18nProvider } from "../i18n";
import { localDateTimeInput, StugubyPage } from "./StugubyPage";

afterEach(() => vi.restoreAllMocks());

const identity: StugubyListResponse["identity"] = {
  nodeId: "node-local",
  displayName: "Local Stugu",
  publicKey: "public",
  keyFingerprint: "fingerprint",
  protocolVersion: "2.0",
};

function summary(id: string, name: string): StugubySummary {
  return {
    id,
    name,
    description: null,
    coordinatorNodeId: "node-local",
    coordinatorUrl: "https://stugu.example.test",
    localRole: "steward",
    localMemberState: "active",
    memberCount: 1,
    createdAt: "2026-07-23T06:00:00.000Z",
    updatedAt: "2026-07-23T06:00:00.000Z",
    lastSyncAt: null,
    lastSyncError: null,
  };
}

function detail(stuguby: StugubySummary, grants: StugubyShareGrant[] = []): StugubyDetailResponse {
  return {
    stuguby,
    members: [{
      stugubyId: stuguby.id,
      nodeId: "node-local",
      displayName: "Local Stugu",
      localLabel: null,
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
      stugubyId: stuguby.id,
      name: `${stuguby.name} grounds`,
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

function localGrant(stugubyId: string, id: string, localHouseId: string): StugubyShareGrant {
  return {
    id,
    stugubyId,
    authorityNodeId: identity.nodeId,
    publicationId: `publication-${id}`,
    localHouseId,
    audience: { kind: "all-members", nodeIds: [] },
    housePolicy: {
      editPolicy: "read-only",
      recoveryMode: "none",
      designatedSuccessorNodeId: null,
    },
    datasets: [{
      dataset: "home.directory.v1",
      enabled: true,
      includeLocalIds: false,
      allowReplicaCache: true,
      retentionDays: 30,
    }],
    epoch: 1,
    revision: 1,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-07-23T06:00:00.000Z",
    updatedAt: "2026-07-23T06:00:00.000Z",
  };
}

function mockLoadedStugubys(stugubys: StugubySummary[], details: Record<string, StugubyDetailResponse | Promise<StugubyDetailResponse>>) {
  vi.spyOn(api, "stugubys").mockResolvedValue({ identity, publicOrigin: "https://stugu.example.test", stugubys });
  vi.spyOn(api, "stuguby").mockImplementation((id) => Promise.resolve(details[id]!));
  vi.spyOn(api, "syncStuguby").mockImplementation(async (id) => stugubys.find((candidate) => candidate.id === id)!);
  vi.spyOn(api, "stugubyTelemetry").mockResolvedValue({ samples: [] });
  vi.spyOn(api, "stugubyPublications").mockImplementation(async (_id, houseId) => ({
    house: { localHouseId: houseId, publicationId: `publication-${houseId}`, name: "Main Home" },
    sensors: [],
  }));
}

describe("StugubyPage", () => {
  it("asks for and saves a public coordinator origin before creation when none was detected", async () => {
    const user = userEvent.setup();
    const created = summary("stuguby-a", "Configured Stuguby");
    vi.spyOn(api, "stugubys")
      .mockResolvedValueOnce({
        identity,
        publicOrigin: null,
        suggestedPublicOrigin: "https://stugu.example.test",
        publicOriginConfigurable: true,
        stugubys: [],
      })
      .mockResolvedValue({ identity, publicOrigin: "https://stugu.example.test", stugubys: [created] });
    const configure = vi.spyOn(api, "configureStugubyCoordinator")
      .mockResolvedValue({ publicOrigin: "https://stugu.example.test" });
    const create = vi.spyOn(api, "createStuguby").mockResolvedValue(created);
    vi.spyOn(api, "stuguby").mockResolvedValue(detail(created));
    vi.spyOn(api, "stugubyTelemetry").mockResolvedValue({ samples: [] });

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    const createForm = (await screen.findByRole("heading", { name: "Create a Stuguby" })).closest("form");
    expect(createForm).not.toBeNull();
    const coordinatorUrl = createForm!.querySelector<HTMLInputElement>('input[type="url"]');
    expect(coordinatorUrl).not.toBeNull();
    expect(coordinatorUrl!.value).toBe("https://stugu.example.test");
    await user.click(within(createForm!).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith("https://stugu.example.test"));
    expect(create).toHaveBeenCalledWith({ name: "My Stuguby", description: null });
  });

  it("offers UI-managed Cloudflare setup to a new local installation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "stugubys").mockResolvedValue({
      identity,
      publicOrigin: "http://127.0.0.1:8080",
      publicOriginConfigurable: true,
      stugubys: [],
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

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    expect(await screen.findByText("Connect other homes securely")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Set up secure sharing" }));

    expect(await screen.findByLabelText(/^One-time OAuth client token/)).toBeTruthy();
    expect(screen.getByLabelText(/^Runtime Access group token/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Cloudflare" })).toBeTruthy();
  });

  it("keeps Cloudflare changes on the Stugu computer before coordinator creation", async () => {
    vi.spyOn(api, "stugubys").mockResolvedValue({
      identity,
      publicOrigin: null,
      suggestedPublicOrigin: "https://stugu.example.test",
      publicOriginConfigurable: false,
      stugubys: [],
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
        hostname: "stugu.example.test",
        suggestedZone: "example.test",
        accountIdKnown: true,
        zoneIdKnown: true,
        oauthClientConfigured: false,
        runtimeTokenAvailable: true,
        ownerEmail: "owner@example.test",
      },
      operation: null,
    });

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    const createPanel = (await screen.findByRole("heading", { name: "Create a Stuguby" })).closest("section");
    expect(createPanel).not.toBeNull();
    expect(createPanel!.querySelector('input[type="url"]')).toBeNull();
    expect(within(createPanel!).queryByRole("button", { name: "Create" })).toBeNull();
    expect(await within(createPanel!).findByText("Open this page on the Stugu computer")).toBeTruthy();
    expect(within(createPanel!).getByRole("link", { name: "Open local Stugu" }).getAttribute("href"))
      .toBe("http://127.0.0.1:8080/stugbys");
  });

  it("makes the deliberate federation boundary explicit before onboarding", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        identity: {
          nodeId: "node-local",
          displayName: "Local Stugu",
          publicKey: "public",
          keyFingerprint: "fingerprint",
          protocolVersion: "2.0",
        },
        publicOrigin: "https://stugu.example.test",
        stugubys: [],
      }),
    } as Response);
    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    expect(await screen.findByRole("heading", { name: "A deliberate sharing boundary" })).toBeTruthy();
    expect(screen.getByText(/Shared Homes are read-only unless their owner enables edits/)).toBeTruthy();
    expect(screen.getByText(/Integration settings, endpoints, credentials, secrets, account identities, controls and automations are never shared/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join without publishing my Homes" })).toBeTruthy();
  });

  it("pauses invitations when the stored coordinator origin is stale", async () => {
    const stuguby = {
      ...summary("stuguby-a", "North grounds"),
      coordinatorUrl: "http://127.0.0.1:8080",
    };
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const createInvitation = vi.spyOn(api, "createStugubyInvitation");

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);

    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Create one-time invitation" });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Invitations are paused until this Stuguby's coordinator URL matches/)).toBeTruthy();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("shows You locally and uses a private label for otherwise identical Stugu names", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    const loaded = detail(stuguby);
    const remote = {
      ...loaded.members[0]!,
      nodeId: "node-remote",
      displayName: "Local Stugu",
      localLabel: "anna@example.test",
      role: "participant" as const,
      keyFingerprint: "remote-fingerprint",
    };
    loaded.members.push(remote);
    mockLoadedStugubys([stuguby], { [stuguby.id]: loaded });
    const updateLabel = vi.spyOn(api, "updateStugubyMemberLabel").mockResolvedValue({
      ...remote,
      localLabel: "Anna's cottage",
    });

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);

    expect(await screen.findByText("You")).toBeTruthy();
    const label = screen.getByLabelText("Private name or email");
    expect((label as HTMLInputElement).value).toBe("anna@example.test");
    await user.clear(label);
    await user.type(label, "Anna's cottage");
    await user.tab();

    await waitFor(() => expect(updateLabel).toHaveBeenCalledWith(stuguby.id, "node-remote", "Anna's cottage"));
  });

  it("requires a private invitation label and sends it only as local metadata", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const createInvitation = vi.spyOn(api, "createStugubyInvitation").mockResolvedValue({
      id: "invitation-1",
      stugubyId: stuguby.id,
      localLabel: "anna@example.test",
      role: "participant",
      expiresAt: "2026-07-30T06:00:00.000Z",
      createdAt: "2026-07-23T06:00:00.000Z",
      usedAt: null,
      revokedAt: null,
      coordinatorUrl: stuguby.coordinatorUrl,
      joinSecret: "secret",
      joinUrl: `${stuguby.coordinatorUrl}/invite-bootstrap#invitation-1.secret`,
    });

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);

    const createButton = await screen.findByRole<HTMLButtonElement>("button", { name: "Create one-time invitation" });
    expect(createButton.disabled).toBe(true);
    await user.type(screen.getByLabelText("Who is this invitation for?"), "anna@example.test");
    expect(createButton.disabled).toBe(false);
    await user.click(createButton);

    await waitFor(() => expect(createInvitation).toHaveBeenCalledWith(stuguby.id, {
      role: "participant",
      localLabel: "anna@example.test",
    }));
  });

  it("deletes a closed Stuguby from Advanced after explicit confirmation", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "Faulty Stuguby");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const listStugubys = vi.mocked(api.stugubys);
    const remove = vi.spyOn(api, "deleteStuguby").mockImplementation(async () => {
      listStugubys.mockResolvedValue({ identity, publicOrigin: "https://stugu.example.test", stugubys: [] });
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    const summaryCard = (await screen.findByText("Automatic sync")).closest("section");
    expect(summaryCard).not.toBeNull();
    await user.click(within(summaryCard!).getByText("Advanced"));
    await user.click(within(summaryCard!).getByRole("button", { name: "Delete Stuguby" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete Faulty Stuguby permanently from this Stugu? Its roster, invitations, shared property, sharing records, and cached remote data will be removed. Local Homes and sensor data are unchanged.",
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith(stuguby.id));
    expect(await screen.findByRole("heading", { name: "Create a Stuguby" })).toBeTruthy();
    expect(screen.getByText("Faulty Stuguby was deleted. Local Home data was unchanged.")).toBeTruthy();
  });

  it("has no automated accessibility violations in onboarding", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        identity,
        publicOrigin: "https://stugu.example.test",
        stugubys: [],
      }),
    } as Response);

    const { container } = render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    await screen.findByRole("heading", { name: "Create a Stuguby" });
    const result = await axe.run(container, {
      rules: {
        // jsdom does not compute the visual styles needed for a reliable contrast result.
        "color-contrast": { enabled: false },
      },
    });

    expect(result.violations).toEqual([]);
  });

  it("clears the prior detail and locks selection until the chosen Stuguby resolves", async () => {
    const user = userEvent.setup();
    const first = summary("stuguby-a", "North grounds");
    const second = summary("stuguby-b", "South grounds");
    let resolveSecond!: (value: StugubyDetailResponse) => void;
    const secondDetail = new Promise<StugubyDetailResponse>((resolve) => { resolveSecond = resolve; });
    mockLoadedStugubys([first, second], { [first.id]: detail(first), [second.id]: secondDetail });

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
    await screen.findByText("No Home sharing grants have been created.");

    await user.click(screen.getByRole("button", { name: /South grounds/ }));

    expect(screen.queryByText("No Home sharing grants have been created.")).toBeNull();
    expect(screen.getByText("Loading the selected Stuguby…")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /North grounds/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /South grounds/ }).disabled).toBe(true);

    resolveSecond(detail(second));
    await waitFor(() => expect(screen.getByRole("button", { name: /South grounds/ }).getAttribute("aria-current")).toBe("true"));
    expect(await screen.findByText("No Home sharing grants have been created.")).toBeTruthy();
  });

  it("keeps connected homes focused and applies the recommended sharing defaults in one action", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const createGrant = vi.spyOn(api, "createStugubyGrant").mockResolvedValue({} as StugubyShareGrant);

    render(<I18nProvider><StugubyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} /></I18nProvider>);
    const startSharing = await screen.findByRole("button", { name: "Start sharing" });

    const connectAnother = screen.getByText("Connect another Stuguby").closest("details");
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
    expect(api.syncStuguby).toHaveBeenCalledWith(stuguby.id);
  });

  it("offers only Homes without an active share", async () => {
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby, [localGrant(stuguby.id, "grant-main", "home-1")]) });

    render(<I18nProvider><StugubyPage houses={[
      { id: "home-1", propertyId: "property-1", name: "Main Home" },
      { id: "home-2", propertyId: "property-1", name: "Annex" },
    ]} /></I18nProvider>);

    const home = await screen.findByLabelText<HTMLSelectElement>("Local Home");
    expect([...home.options].map((option) => option.text)).toEqual(["Choose a Home", "Annex"]);
    expect(home.value).toBe("home-2");
  });

  it("flags existing duplicate shares without silently removing either grant", async () => {
    const stuguby = summary("stuguby-a", "North grounds");
    const grants = [
      localGrant(stuguby.id, "grant-main-a", "home-1"),
      localGrant(stuguby.id, "grant-main-b", "home-1"),
    ];
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby, grants) });

    render(<I18nProvider><StugubyPage houses={[
      { id: "home-1", propertyId: "property-1", name: "Main Home" },
    ]} /></I18nProvider>);

    expect(await screen.findByText(/Active sharing is duplicated for: Main Home/)).toBeTruthy();
    expect(screen.getAllByText("Duplicate active share")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Start sharing" })).toBeNull();
    expect(screen.getByText(/Every locally owned Home already has an active share/)).toBeTruthy();
  });

  it("keeps Client migration out of the Host UI", async () => {
    const stuguby = summary("stuguby-a", "North grounds");
    const hostDetail = detail(stuguby);
    hostDetail.propertyAdoption = {
      stugubyId: stuguby.id,
      localPropertyId: "property-host",
      state: "adopted",
      adoptedAt: "2026-07-23T06:00:00.000Z",
      detachedAt: null,
      lastMaterializedRevision: 1,
    };
    mockLoadedStugubys([stuguby], { [stuguby.id]: hostDetail });

    render(<I18nProvider><StugubyPage
      houses={[]}
      properties={[
        { id: "property-host", name: "Host Property" },
        { id: "property-spare", name: "Spare Property" },
      ]}
    /></I18nProvider>);

    expect(await screen.findByText("Connected and synchronized")).toBeTruthy();
    expect(screen.queryByText("Move my Homes into the Host Property")).toBeNull();
    expect(screen.getAllByText("Host").length).toBeGreaterThan(0);
  });

  it("explains and completes a Client Home migration before refreshing the shared inventory", async () => {
    const user = userEvent.setup();
    const stuguby = {
      ...summary("stuguby-a", "North grounds"),
      coordinatorNodeId: "node-host",
      localRole: "participant" as const,
    };
    const clientDetail = detail(stuguby);
    clientDetail.propertyAdoption = {
      stugubyId: stuguby.id,
      localPropertyId: "property-host",
      state: "adopted",
      adoptedAt: "2026-07-23T06:00:00.000Z",
      detachedAt: null,
      lastMaterializedRevision: 1,
    };
    mockLoadedStugubys([stuguby], { [stuguby.id]: clientDetail });
    const migrate = vi.spyOn(api, "migratePropertyToStuguby").mockResolvedValue({
      adoption: clientDetail.propertyAdoption,
      migrationSnapshotId: "snapshot-1",
      moved: {
        sourcePropertyId: "property-client",
        targetPropertyId: "property-host",
        houseIds: ["home-client"],
        areaIds: [],
        equipmentIds: [],
        noteIds: [],
        maintenanceTaskIds: [],
      },
      createdGrants: [],
    });
    const onInventoryChange = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<I18nProvider><StugubyPage
      houses={[{ id: "home-client", propertyId: "property-client", name: "Client Home" }]}
      properties={[
        { id: "property-host", name: "Host Property" },
        { id: "property-client", name: "My Property" },
      ]}
      onInventoryChange={onInventoryChange}
    /></I18nProvider>);

    await user.click(await screen.findByText("Move my Homes into the Host Property"));
    expect(screen.getByText(/You keep full control of your Homes/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Move Homes and keep control" }));

    await waitFor(() => expect(migrate).toHaveBeenCalledWith(stuguby.id, "property-client"));
    expect(api.syncStuguby).toHaveBeenCalledWith(stuguby.id);
    expect(onInventoryChange).toHaveBeenCalledOnce();
    expect(await screen.findByText(/1 Home moved into the Host Property/)).toBeTruthy();
  });

  it("resets an edited grant instead of carrying it into another Stuguby", async () => {
    const user = userEvent.setup();
    const first = summary("stuguby-a", "North grounds");
    const second = summary("stuguby-b", "South grounds");
    const grant: StugubyShareGrant = {
      id: "grant-a",
      stugubyId: first.id,
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
    mockLoadedStugubys([first, second], { [first.id]: detail(first, [grant]), [second.id]: detail(second) });

    render(<I18nProvider><StugubyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} /></I18nProvider>);
    const edit = await screen.findByRole("button", { name: "Edit" });
    expect(within(edit.closest("article")!).getByText("Main Home")).toBeTruthy();
    await user.click(edit);
    expect(screen.getByRole("button", { name: "Update grant" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /South grounds/ }));
    expect(await screen.findByRole("button", { name: "Start sharing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update grant" })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^Precise location home\.location/ }).checked).toBe(false);
  });

  it("shows the shared Home name received from a remote grant", async () => {
    const stuguby = summary("stuguby-a", "North grounds");
    const grant: StugubyShareGrant = {
      id: "grant-remote",
      stugubyId: stuguby.id,
      authorityNodeId: "node-remote",
      publicationId: "publication-remote",
      audience: { kind: "all-members", nodeIds: [] },
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode: "none",
        designatedSuccessorNodeId: null,
      },
      datasets: [{
        dataset: "home.directory.v1",
        enabled: true,
        includeLocalIds: false,
        allowReplicaCache: true,
        retentionDays: 30,
      }],
      epoch: 1,
      revision: 1,
      expiresAt: null,
      revokedAt: null,
      createdAt: "2026-07-23T06:00:00.000Z",
      updatedAt: "2026-07-23T06:00:00.000Z",
    };
    const remoteDetail = detail(stuguby, [grant]);
    remoteDetail.remoteResources = [{
      stugubyId: stuguby.id,
      authorityNodeId: grant.authorityNodeId,
      schema: "home.directory.v1",
      resourceId: grant.publicationId,
      publicationId: grant.publicationId,
      revision: 1,
      payload: {
        publicationId: grant.publicationId,
        name: "Lake Home",
        timezone: "Europe/Helsinki",
      },
      receivedAt: "2026-07-23T06:00:00.000Z",
      sourceOccurredAt: "2026-07-23T06:00:00.000Z",
      stale: false,
    }];
    mockLoadedStugubys([stuguby], { [stuguby.id]: remoteDetail });

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);

    const authority = await screen.findByText(/Remote authority/);
    expect(within(authority.closest("article")!).getByText("Lake Home")).toBeTruthy();
  });

  it("fails closed when the telemetry sensor catalog cannot be loaded", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    vi.mocked(api.stugubyPublications).mockRejectedValue(new Error("Catalog unavailable"));

    render(<I18nProvider><StugubyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} /></I18nProvider>);
    await screen.findByRole("button", { name: "Start sharing" });
    await user.click(screen.getByText("Customize what is shared"));
    await user.click(screen.getByRole("checkbox", { name: /^Raw telemetry home\.telemetry/ }));
    await screen.findByText("Catalog unavailable");

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start sharing" }).disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "All sensors in this Home" })).toBeNull();
  });

  it("rejects a half-entered shared-property coordinate", async () => {
    const user = userEvent.setup();
    const stuguby = summary("stuguby-a", "North grounds");
    mockLoadedStugubys([stuguby], { [stuguby.id]: detail(stuguby) });
    const update = vi.spyOn(api, "updateStugubyProperty");

    render(<I18nProvider><StugubyPage houses={[]} /></I18nProvider>);
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
