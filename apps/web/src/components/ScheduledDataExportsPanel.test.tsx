import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSession, ExportDestinationStatus, ScheduledDataExport } from "@climate-twin/contracts";
import { api } from "../api";
import { activateAccountStorage } from "../browserStorage";
import { createDemoState } from "../domain";
import { I18nProvider, useI18n } from "../i18n";
import { svOverrides } from "../locales/catalogs/sv";
import { ScheduledDataExportsPanel } from "./ScheduledDataExportsPanel";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderPanel(viewerEmail: string | null = "owner@example.test") {
  const state = createDemoState();
  const house = state.houses[0]!;
  const sensors = state.sensors.filter((sensor) => sensor.houseId === house.id && sensor.enabled);
  render(<I18nProvider><ScheduledDataExportsPanel
    house={house}
    period="30d"
    sensorIds={sensors.map((sensor) => sensor.id)}
    measurementIds={["temperature", "humidity"]}
    resolution="15m"
    aggregation="mean"
    configurationError={null}
    viewerEmail={viewerEmail}
  /></I18nProvider>);
  return { house, sensors };
}

function createdSchedule(houseId: string, overrides: Partial<ScheduledDataExport> = {}): ScheduledDataExport {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    houseId,
    name: "Weekly export",
    enabled: true,
    frequency: "weekly",
    timeLocal: "02:00",
    dayOfWeek: 0,
    dayOfMonth: null,
    period: "30d",
    sensorIds: ["sensor-01"],
    measurementIds: ["temperature", "humidity"],
    resolution: "15m",
    aggregation: "mean",
    retentionCount: 12,
    nextRunAt: "2026-08-09T23:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    lastOutputName: null,
    ownerEmail: "owner@example.test",
    destination: "nas",
    revision: 1,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    ...overrides,
  };
}

const readyDestination: ExportDestinationStatus = { selected: "nas", ready: true, nasConnected: true, accounts: [], connection: null };

const googleAppEnteredHere: ExportDestinationStatus = {
  selected: "nas",
  ready: false,
  nasConnected: false,
  accounts: [{ provider: "google-drive", available: true, appSource: "protected-file", connected: false, accountLabel: null, connectedAt: null }],
  connection: null,
};

const signedInOwner: AppSession = {
  authenticated: true,
  principal: { type: "local", email: "owner@example.test" },
  tenant: { id: "local", name: "Local Stugu", role: "owner" },
  availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
  readOnly: false,
  grants: [],
};

function LanguageSwitch() {
  const { setLocale } = useI18n();
  return <button type="button" onClick={() => setLocale("sv")}>switch language</button>;
}

function mockTarget() {
  vi.spyOn(api, "scheduledDataExports").mockResolvedValue([]);
  vi.spyOn(api, "exportDestinations").mockResolvedValue(readyDestination);
}

describe("ScheduledDataExportsPanel", () => {
  it("names the connected cloud drive that receives the exports", async () => {
    vi.spyOn(api, "scheduledDataExports").mockResolvedValue([]);
    vi.spyOn(api, "exportDestinations").mockResolvedValue({ ...readyDestination, selected: "dropbox" });

    renderPanel();

    expect(await screen.findByText("Saving to Dropbox")).toBeVisible();
    expect(screen.getByRole("button", { name: "Schedule weekly export" })).toBeEnabled();
  });

  it("opens the person's own destination choice before an active schedule can be created", async () => {
    vi.spyOn(api, "scheduledDataExports").mockResolvedValue([]);
    vi.spyOn(api, "exportDestinations").mockResolvedValue({ ...readyDestination, ready: false, nasConnected: false });

    renderPanel();

    expect(await screen.findByText("No destination connected")).toBeVisible();
    expect(screen.getByText("Where your scheduled exports go", { selector: "strong" }).closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("link", { name: "Open System" })).toHaveAttribute("href", "/system");
    expect(screen.getByRole("button", { name: "Schedule weekly export" })).toBeDisabled();
  });

  it("keeps a ready destination folded away and follows changes made in the picker", async () => {
    vi.spyOn(api, "scheduledDataExports").mockResolvedValue([]);
    vi.spyOn(api, "exportDestinations").mockResolvedValue({
      ...readyDestination,
      accounts: [{ provider: "dropbox", available: true, appSource: "environment", connected: true, accountLabel: "owner@example.test", connectedAt: "2026-10-31T12:00:00.000Z" }],
    });
    const select = vi.spyOn(api, "selectExportDestination").mockResolvedValue({
      ...readyDestination,
      selected: "dropbox",
      accounts: [{ provider: "dropbox", available: true, appSource: "environment", connected: true, accountLabel: "owner@example.test", connectedAt: "2026-10-31T12:00:00.000Z" }],
    });
    const user = userEvent.setup();

    renderPanel();

    expect(await screen.findByText("Saving to NAS")).toBeVisible();
    const summary = screen.getByText("Where your scheduled exports go", { selector: "strong" });
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    await user.click(screen.getByRole("radio", { name: /^Dropbox/u }));

    expect(select).toHaveBeenCalledWith("dropbox");
    expect(await screen.findByText("Saving to Dropbox")).toBeVisible();
  });

  it("says where each schedule goes and who set it up", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    vi.spyOn(api, "scheduledDataExports").mockResolvedValue([
      createdSchedule(house.id, { id: "11111111-1111-4111-8111-111111111111", name: "Mine", destination: "dropbox", ownerEmail: "Owner@Example.test" }),
      createdSchedule(house.id, { id: "22222222-2222-4222-8222-222222222222", name: "Theirs", destination: "google-drive", ownerEmail: "admin@example.test" }),
      createdSchedule(house.id, { id: "33333333-3333-4333-8333-333333333333", name: "Older", ownerEmail: null }),
    ]);
    vi.spyOn(api, "exportDestinations").mockResolvedValue(readyDestination);

    renderPanel();

    expect(await screen.findByText("Saves to Dropbox · set up by you")).toBeVisible();
    expect(screen.getByText("Saves to Google Drive · set up by admin@example.test")).toBeVisible();
    expect(screen.getByText("Saves to NAS · shared schedule")).toBeVisible();
  });

  it("shows schedules without waiting for the independent storage check", async () => {
    const state = createDemoState();
    const house = state.houses[0]!;
    vi.spyOn(api, "scheduledDataExports").mockResolvedValue([createdSchedule(house.id)]);
    vi.spyOn(api, "exportDestinations").mockReturnValue(new Promise(() => undefined));

    renderPanel();

    expect(await screen.findByText("Weekly export")).toBeVisible();
  });

  it("polls pending schedules without waiting for a slow storage check", async () => {
    vi.useFakeTimers();
    const state = createDemoState();
    const house = state.houses[0]!;
    const pending = createdSchedule(house.id, { lastRunStatus: "pending" });
    const schedules = vi.spyOn(api, "scheduledDataExports").mockResolvedValue([pending]);
    vi.spyOn(api, "exportDestinations").mockReturnValue(new Promise(() => undefined));

    renderPanel();
    await act(async () => { await Promise.resolve(); });
    expect(schedules).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(schedules).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Weekly export")).toBeVisible();
  });

  it("starts a fresh load when the selected Home changes", async () => {
    const state = createDemoState();
    const firstHouse = state.houses[0]!;
    const secondHouse = { ...firstHouse, id: "house-secondary", name: "Second Home" };
    let firstSignal: AbortSignal | undefined;
    let firstStorageSignal: AbortSignal | undefined;
    const neverSettles = new Promise<ScheduledDataExport[]>(() => undefined);
    const schedules = vi.spyOn(api, "scheduledDataExports")
      .mockImplementationOnce((_houseId, signal) => {
        firstSignal = signal;
        return neverSettles;
      })
      .mockResolvedValueOnce([]);
    vi.spyOn(api, "exportDestinations")
      .mockImplementationOnce((signal) => {
        firstStorageSignal = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValueOnce(readyDestination);
    const sensors = state.sensors.filter((sensor) => sensor.houseId === firstHouse.id && sensor.enabled);
    const panel = (house: typeof firstHouse) => <I18nProvider><ScheduledDataExportsPanel
      house={house}
      period="30d"
      sensorIds={sensors.map((sensor) => sensor.id)}
      measurementIds={["temperature", "humidity"]}
      resolution="15m"
      aggregation="mean"
      configurationError={null}
      viewerEmail="owner@example.test"
    /></I18nProvider>;
    const view = render(panel(firstHouse));
    await waitFor(() => expect(schedules).toHaveBeenCalledTimes(1));

    view.rerender(panel(secondHouse));

    await waitFor(() => expect(schedules).toHaveBeenCalledWith(secondHouse.id, expect.any(AbortSignal)));
    expect(firstSignal?.aborted).toBe(true);
    expect(firstStorageSignal?.aborted).toBe(true);
  });

  describe("while the Google Drive app form is open", () => {
    async function openGoogleAppForm() {
      vi.spyOn(api, "scheduledDataExports").mockResolvedValue([]);
      const destinations = vi.spyOn(api, "exportDestinations").mockResolvedValue(googleAppEnteredHere);
      const state = createDemoState();
      const house = state.houses[0]!;
      activateAccountStorage(signedInOwner);
      const user = userEvent.setup();
      render(<I18nProvider><LanguageSwitch /><ScheduledDataExportsPanel
        house={house}
        period="30d"
        sensorIds={[]}
        measurementIds={["temperature"]}
        resolution="15m"
        aggregation="mean"
        configurationError={null}
        viewerEmail="owner@example.test"
      /></I18nProvider>);
      await user.click(await screen.findByRole("button", { name: "Change the Google Drive app" }));
      const clientId = screen.getByRole("textbox", { name: "Client ID" });
      await user.type(clientId, "1234567890-owner.apps.googleusercontent.com");
      return { clientId, destinations, user };
    }

    it("keeps what was typed when the workspace reloads on returning to the tab", async () => {
      const { clientId, destinations } = await openGoogleAppForm();

      // Coming back from the provider's console restarts the workspace bootstrap, which reactivates the same account.
      await act(async () => { activateAccountStorage(signedInOwner); });

      expect(clientId).toBeInTheDocument();
      expect(clientId).toHaveValue("1234567890-owner.apps.googleusercontent.com");
      expect(destinations).toHaveBeenCalledTimes(1);
    });

    it("keeps what was typed when the language changes", async () => {
      const { clientId, destinations, user } = await openGoogleAppForm();
      // The panel reloads behind the form once the new language arrives. Hold that reload open, as a real
      // request would be, because an instant answer never lets an emptied panel reach the screen.
      let finishReload!: (status: ExportDestinationStatus) => void;
      destinations.mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));

      await user.click(screen.getByRole("button", { name: "switch language" }));
      await waitFor(() => expect(destinations).toHaveBeenCalledTimes(2));
      await screen.findByRole("textbox", { name: svOverrides["dataExport.appSetupGoogleClientId"] });
      await act(async () => { finishReload(googleAppEnteredHere); });

      expect(clientId).toBeInTheDocument();
      expect(clientId).toHaveValue("1234567890-owner.apps.googleusercontent.com");
    });
  });

  it("never overlaps refreshes while a pending export is still loading", async () => {
    vi.useFakeTimers();
    const state = createDemoState();
    const house = state.houses[0]!;
    const pending = createdSchedule(house.id, { lastRunStatus: "pending" });
    let resolvePoll!: (value: ScheduledDataExport[]) => void;
    const poll = new Promise<ScheduledDataExport[]>((resolve) => { resolvePoll = resolve; });
    const schedules = vi.spyOn(api, "scheduledDataExports")
      .mockResolvedValueOnce([pending])
      .mockReturnValueOnce(poll)
      .mockResolvedValue([pending]);
    vi.spyOn(api, "exportDestinations").mockResolvedValue(readyDestination);

    renderPanel();
    await act(async () => { await Promise.resolve(); });
    expect(schedules).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(schedules).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(schedules).toHaveBeenCalledTimes(2);

    await act(async () => { resolvePoll([pending]); await poll; });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(schedules).toHaveBeenCalledTimes(3);
  });

  it("creates the weekly default from the current Data & Analytics selection", async () => {
    mockTarget();
    const create = vi.spyOn(api, "createScheduledDataExport");
    const { house, sensors } = renderPanel();
    create.mockResolvedValue(createdSchedule(house.id, { name: `${house.name} weekly export`, sensorIds: sensors.map((sensor) => sensor.id) }));

    await screen.findByText("Saving to NAS");
    await userEvent.setup().click(screen.getByRole("button", { name: "Schedule weekly export" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(house.id, expect.objectContaining({
      frequency: "weekly",
      period: "30d",
      sensorIds: sensors.map((sensor) => sensor.id),
      measurementIds: ["temperature", "humidity"],
      resolution: "15m",
      aggregation: "mean",
    })));
    expect(await screen.findByText(`${house.name} weekly export`)).toBeTruthy();
  });

  it("keeps monthly timing and retention in the advanced disclosure", async () => {
    mockTarget();
    const create = vi.spyOn(api, "createScheduledDataExport");
    const { house } = renderPanel();
    create.mockResolvedValue(createdSchedule(house.id, { name: "Month end", frequency: "monthly", dayOfWeek: null, dayOfMonth: 31, retentionCount: 6 }));
    const user = userEvent.setup();

    await screen.findByText("Saving to NAS");
    await user.click(screen.getByText("Advanced schedule"));
    await user.clear(screen.getByRole("textbox", { name: "Schedule name" }));
    await user.type(screen.getByRole("textbox", { name: "Schedule name" }), "Month end");
    await user.selectOptions(screen.getByRole("combobox", { name: "Frequency" }), "monthly");
    await user.clear(screen.getByRole("spinbutton", { name: "Day of month" }));
    await user.type(screen.getByRole("spinbutton", { name: "Day of month" }), "31");
    await user.clear(screen.getByRole("spinbutton", { name: /^Files to keep/u }));
    await user.type(screen.getByRole("spinbutton", { name: /^Files to keep/u }), "6");
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(house.id, expect.objectContaining({
      name: "Month end", frequency: "monthly", dayOfWeek: null, dayOfMonth: 31, retentionCount: 6,
    })));
  });
});
