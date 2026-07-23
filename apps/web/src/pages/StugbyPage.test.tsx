import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  protocolVersion: "1.0",
};

function summary(id: string, name: string): StugbySummary {
  return {
    id,
    name,
    description: null,
    coordinatorNodeId: "node-local",
    coordinatorUrl: "https://coordinator.example.test",
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
      revision: 1,
      updatedAt: "2026-07-23T06:00:00.000Z",
    },
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
  it("keeps coordinator creation unavailable until the server owns a public origin", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        identity: {
          nodeId: "node-local",
          displayName: "Local Stuga",
          publicKey: "public",
          keyFingerprint: "fingerprint",
          protocolVersion: "1.0",
        },
        publicOrigin: null,
        stugbys: [],
      }),
    } as Response);
    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    expect(await screen.findByRole("heading", { name: "Create a Stugby" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create" }).disabled).toBe(true);
    expect(screen.getAllByText(/Provision this coordinator first/).length).toBeGreaterThan(0);
  });

  it("makes the enforced read-only federation boundary explicit before onboarding", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        identity: {
          nodeId: "node-local",
          displayName: "Local Stuga",
          publicKey: "public",
          keyFingerprint: "fingerprint",
          protocolVersion: "1.0",
        },
        publicOrigin: "https://stuga.example.test",
        stugbys: [],
      }),
    } as Response);
    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
    expect(await screen.findByRole("heading", { name: "A read-only sharing boundary" })).toBeTruthy();
    expect(screen.getByText(/Integration settings, endpoints, credentials, secrets, local account identities, remote control, commands and automations cannot be federated/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join without sharing" })).toBeTruthy();
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
    expect(await screen.findByRole("button", { name: "Create grant" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update grant" })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^Precise location home\.location/ }).checked).toBe(false);
  });

  it("fails closed when the telemetry sensor catalog cannot be loaded", async () => {
    const user = userEvent.setup();
    const stugby = summary("stugby-a", "North grounds");
    mockLoadedStugbys([stugby], { [stugby.id]: detail(stugby) });
    vi.mocked(api.stugbyPublications).mockRejectedValue(new Error("Catalog unavailable"));

    render(<I18nProvider><StugbyPage houses={[{ id: "home-1", propertyId: "property-1", name: "Main Home" }]} /></I18nProvider>);
    await screen.findByRole("button", { name: "Create grant" });
    await user.click(screen.getByRole("checkbox", { name: /^Raw telemetry home\.telemetry/ }));
    await screen.findByText("Catalog unavailable");

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create grant" }).disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "All sensors in this Home" })).toBeNull();
  });

  it("rejects a half-entered shared-property coordinate", async () => {
    const user = userEvent.setup();
    const stugby = summary("stugby-a", "North grounds");
    mockLoadedStugbys([stugby], { [stugby.id]: detail(stugby) });
    const update = vi.spyOn(api, "updateStugbyProperty");

    render(<I18nProvider><StugbyPage houses={[]} /></I18nProvider>);
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
