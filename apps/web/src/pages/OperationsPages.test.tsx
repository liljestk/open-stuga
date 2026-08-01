import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceTask, ManualObservation, ManualObservationInput } from "@climate-twin/contracts";
import { I18nProvider } from "../i18n";
import { createDemoState } from "../domain";
import { ObservationComposer } from "../components/ObservationComposer";
import { HomeOperationsPreview } from "../components/HomeOperationsPreview";
import { ActivityPage } from "./ActivityPage";
import { MaintenancePage } from "./MaintenancePage";

vi.mock("../useHouseWeather", () => ({
  useHouseWeather: () => ({ weather: null, loading: false, error: null, refresh: vi.fn() }),
}));

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function savedObservation(input: ManualObservationInput): ManualObservation {
  return {
    id: "observation-new",
    houseId: input.houseId,
    floorId: input.floorId,
    sensorId: input.sensorId ?? null,
    kind: input.kind,
    severity: input.severity,
    note: input.note,
    x: input.x ?? null,
    y: input.y ?? null,
    occurredAt: input.occurredAt ?? "",
    createdAt: "2026-07-15T09:00:00.000Z",
    timePrecision: input.timePrecision ?? "exact",
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    source: input.source ?? "unknown",
    sourceDetail: input.sourceDetail ?? null,
    confidence: input.confidence ?? "uncertain",
    status: "open",
    resolutionNote: null,
    resolvedAt: null,
    revision: 1,
    updatedAt: "2026-07-15T09:00:00.000Z",
  };
}

function task(overrides: Partial<MaintenanceTask>): MaintenanceTask {
  return {
    id: "task-1",
    propertyId: "property-pine",
    houseId: "house-pine",
    floorId: "floor-ground",
    title: "Replace sink seal",
    description: "Inspect the cabinet after replacement.",
    basis: "condition-based",
    basisDetail: "Water observed below the sink",
    priority: "high",
    plannedFor: "2026-07-14",
    dueBy: "2026-07-15",
    observationIds: [],
    status: "planned",
    completionNote: null,
    completedAt: null,
    verificationNote: null,
    verifiedAt: null,
    revision: 1,
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-07-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("observation quick capture", () => {
  it("saves from Home without forcing a map coordinate", async () => {
    const state = createDemoState();
    const onCreate = vi.fn(async (input: ManualObservationInput) => savedObservation(input));
    render(<I18nProvider><ObservationComposer compact house={state.houses[0]!} floorId={state.houses[0]!.floors[0]!.id} onCreate={onCreate} /></I18nProvider>);

    fireEvent.change(screen.getByLabelText("Quick observation note"), { target: { value: "  Drip beneath the sink  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save observation" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      note: "Drip beneath the sink",
      kind: "note",
      severity: "info",
      x: null,
      y: null,
      timePrecision: "exact",
    });
  });

  it.each(["date-range", "unknown"] as const)("does not invent an occurredAt value when editing %s observations", async (precision) => {
    const state = createDemoState();
    const source = state.observations[0]!;
    const observation: ManualObservation = precision === "date-range"
      ? { ...source, timePrecision: precision, occurredAt: "", validFrom: "2026-07-01", validTo: "2026-07-15" }
      : { ...source, timePrecision: precision, occurredAt: "", validFrom: null, validTo: null };
    const onUpdate = vi.fn().mockResolvedValue(observation);
    const view = render(<I18nProvider><ObservationComposer compact house={state.houses[0]!} floorId={observation.floorId} observation={observation} onUpdate={onUpdate} /></I18nProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    const patch = onUpdate.mock.calls[0]![1];
    expect(patch).not.toHaveProperty("occurredAt");
    if (precision === "date-range") expect(patch).toMatchObject({ validFrom: "2026-07-01", validTo: "2026-07-15" });
    else {
      expect(patch).not.toHaveProperty("validFrom");
      expect(patch).not.toHaveProperty("validTo");
    }
    view.unmount();
  });
});

describe("Home operations preview", () => {
  it("keeps activity and maintenance links compact and actionable", () => {
    const state = createDemoState();
    const onOpenActivity = vi.fn();
    const onOpenMaintenance = vi.fn();
    const view = render(<I18nProvider><HomeOperationsPreview
      sensors={state.sensors}
      alerts={state.alerts}
      observations={state.observations}
      maintenanceTasks={[task({})]}
      warnings={[]}
      integration={state.integration}
      timeZone={state.houses[0]!.timezone}
      onOpenActivity={onOpenActivity}
      onOpenMaintenance={onOpenMaintenance}
    /></I18nProvider>);

    const disclosure = view.container.querySelector<HTMLDetailsElement>(".home-operations-disclosure")!;
    expect(disclosure.open).toBe(false);
    expect(screen.queryByRole("button", { name: /View all activity/ })).toBeNull();
    fireEvent.click(screen.getByText("Activity and maintenance overview"));
    expect(disclosure.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /View all activity/ }));
    fireEvent.click(screen.getByRole("button", { name: /View maintenance plan/ }));
    expect(onOpenActivity).toHaveBeenCalledOnce();
    expect(onOpenMaintenance).toHaveBeenCalledOnce();
    expect(screen.getAllByText("Replace sink seal")).toHaveLength(1);
  });
});

describe("Activity and maintenance pages", () => {
  it("restores and updates the bookmarkable Activity view", async () => {
    const state = createDemoState();
    window.history.replaceState(null, "", "/properties/property-pine/homes/house-pine/activity?view=observations");
    render(<I18nProvider><ActivityPage
      state={state}
      house={state.houses[0]!}
      onCreateObservation={vi.fn()}
      onUpdateObservation={vi.fn()}
      onReloadObservation={vi.fn()}
      onLoadObservationRevisions={vi.fn().mockResolvedValue([])}
      onOpenFloor={vi.fn()}
      onPlanMaintenance={vi.fn()}
    /></I18nProvider>);

    const timeline = screen.getByRole("tab", { name: "All activity" });
    const observations = screen.getByRole("tab", { name: /Observations/ });
    await waitFor(() => expect(observations).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(timeline);
    expect(window.location.search).toBe("");
    expect(timeline).toHaveAttribute("aria-selected", "true");

    window.history.pushState(null, "", "?view=observations");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(observations).toHaveAttribute("aria-selected", "true"));
  });

  it("deep-links Activity filters and search while preserving unrelated query state", async () => {
    const state = createDemoState();
    window.history.replaceState(null, "", "/properties/property-pine/homes/house-pine/activity?keep=yes&view=observations&status=critical&search=seal#observations");
    render(<I18nProvider><ActivityPage
      state={state}
      house={state.houses[0]!}
      onCreateObservation={vi.fn()}
      onUpdateObservation={vi.fn()}
      onReloadObservation={vi.fn()}
      onLoadObservationRevisions={vi.fn().mockResolvedValue([])}
      onOpenFloor={vi.fn()}
      onPlanMaintenance={vi.fn()}
    /></I18nProvider>);

    expect(screen.getByRole("tab", { name: /Observations/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Status")).toHaveValue("critical");
    expect(screen.getByLabelText("Search observations")).toHaveValue("seal");

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "resolved" } });
    expect(new URLSearchParams(window.location.search).get("status")).toBe("resolved");
    fireEvent.change(screen.getByLabelText("Search observations"), { target: { value: "window" } });
    expect(new URLSearchParams(window.location.search).get("search")).toBe("window");
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
    expect(window.location.hash).toBe("#observations");

    fireEvent.click(screen.getByRole("tab", { name: "All activity" }));
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("status")).toBe("resolved");

    window.history.pushState(null, "", "?keep=yes&view=invalid&status=invalid&search=%20%20#observations");
    fireEvent(window, new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "All activity" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByLabelText("Status")).toHaveValue("all");
    expect(screen.getByLabelText("Search observations")).toHaveValue("");
    expect(window.location.search).toBe("?keep=yes");

    window.history.pushState(null, "", "?keep=yes&view=observations&status=open&search=window#observations");
    fireEvent(window, new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Observations/ })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByLabelText("Status")).toHaveValue("open");
    expect(screen.getByLabelText("Search observations")).toHaveValue("window");
  });

  it("supports roving keyboard tabs and keeps both controlled panels mounted", async () => {
    const state = createDemoState();
    render(<I18nProvider><ActivityPage
      state={state}
      house={state.houses[0]!}
      onCreateObservation={vi.fn()}
      onUpdateObservation={vi.fn()}
      onReloadObservation={vi.fn()}
      onLoadObservationRevisions={vi.fn().mockResolvedValue([])}
      onOpenFloor={vi.fn()}
      onPlanMaintenance={vi.fn()}
    /></I18nProvider>);

    const timeline = screen.getByRole("tab", { name: "All activity" });
    const observations = screen.getByRole("tab", { name: /Observations/ });
    expect(timeline.tabIndex).toBe(0);
    expect(observations.tabIndex).toBe(-1);
    expect(document.getElementById("activity-timeline-panel")).not.toBeNull();
    expect(document.getElementById("activity-observations-panel")).not.toBeNull();

    timeline.focus();
    fireEvent.keyDown(timeline, { key: "ArrowRight" });
    expect(observations.getAttribute("aria-selected")).toBe("true");
    expect(observations.tabIndex).toBe(0);
    expect(document.activeElement).toBe(observations);

    fireEvent.keyDown(observations, { key: "Home" });
    expect(timeline.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(timeline);
  });

  it("links the observation composer disclosure and restores its trigger on cancel", async () => {
    const state = createDemoState();
    render(<I18nProvider><ActivityPage
      state={state}
      house={state.houses[0]!}
      onCreateObservation={vi.fn()}
      onUpdateObservation={vi.fn()}
      onReloadObservation={vi.fn()}
      onLoadObservationRevisions={vi.fn().mockResolvedValue([])}
      onOpenFloor={vi.fn()}
      onPlanMaintenance={vi.fn()}
    /></I18nProvider>);

    const trigger = screen.getByRole("button", { name: "Log observation" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", "activity-observation-composer");
    expect(document.getElementById("activity-observation-composer")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("activity-observation-composer")).toBeNull();
  });

  it("opens an observation and carries it into maintenance planning", () => {
    const state = createDemoState();
    const observation = { ...state.observations[0]!, status: "open" as const, x: null, y: null };
    const onPlanMaintenance = vi.fn();
    render(<I18nProvider><ActivityPage
      state={{ ...state, observations: [observation] }}
      house={state.houses[0]!}
      onCreateObservation={vi.fn()}
      onUpdateObservation={vi.fn()}
      onReloadObservation={vi.fn()}
      onLoadObservationRevisions={vi.fn().mockResolvedValue([])}
      onOpenFloor={vi.fn()}
      onPlanMaintenance={onPlanMaintenance}
    /></I18nProvider>);

    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));
    fireEvent.click(screen.getByRole("button", { name: /Window seal checked/ }));
    expect(screen.queryByRole("button", { name: "View on floor plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan maintenance" }));
    expect(onPlanMaintenance).toHaveBeenCalledWith(observation);
  });

  it("keeps Guest activity and maintenance views read-only", () => {
    const state = createDemoState();
    const planned = task({ id: "guest-task", title: "Guest-visible task" });
    const onPlanMaintenance = vi.fn();
    const activity = render(<I18nProvider><ActivityPage
      state={state}
      house={state.houses[0]!}
      readOnly
      onCreateObservation={vi.fn()}
      onUpdateObservation={vi.fn()}
      onReloadObservation={vi.fn()}
      onLoadObservationRevisions={vi.fn().mockResolvedValue([])}
      onOpenFloor={vi.fn()}
      onPlanMaintenance={onPlanMaintenance}
    /></I18nProvider>);

    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));
    fireEvent.click(screen.getByRole("button", { name: /Window seal checked/ }));
    expect(screen.queryByRole("button", { name: "Add observation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan maintenance" })).toBeNull();
    expect(onPlanMaintenance).not.toHaveBeenCalled();
    activity.unmount();

    render(<I18nProvider><MaintenancePage
      state={{ ...state, maintenanceTasks: [planned] }}
      house={state.houses[0]!}
      readOnly
      onCreateTask={vi.fn()}
      onUpdateTask={vi.fn()}
      onReloadTask={vi.fn()}
      onLoadTaskRevisions={vi.fn().mockResolvedValue([])}
    /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Guest-visible task/ }));
    expect(screen.queryByRole("button", { name: "Plan work" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start work" })).toBeNull();
  });

  it("preserves mapped area and equipment context when editing maintenance", () => {
    const state = createDemoState();
    const area = {
      id: "area-yard",
      propertyId: "property-pine",
      name: "North yard",
      kind: "yard" as const,
      description: null,
      polygon: [],
      createdAt: "2026-07-01T08:00:00.000Z",
      updatedAt: "2026-07-01T08:00:00.000Z",
    };
    const equipment = {
      id: "equipment-pump",
      propertyId: area.propertyId,
      areaId: area.id,
      name: "Well pump",
      kind: "pump",
      manufacturer: null,
      model: null,
      serialNumber: null,
      status: "active" as const,
      notes: null,
      createdAt: "2026-07-01T08:00:00.000Z",
      updatedAt: "2026-07-01T08:00:00.000Z",
    };
    const mappedTask = task({ id: "mapped-task", floorId: null, areaId: area.id, equipmentId: equipment.id, title: "Service pump" });
    render(<I18nProvider><MaintenancePage
      state={{ ...state, maintenanceTasks: [mappedTask] }}
      house={state.houses[0]!}
      areas={[area]}
      equipment={[equipment]}
      onCreateTask={vi.fn()}
      onUpdateTask={vi.fn()}
      onReloadTask={vi.fn()}
      onLoadTaskRevisions={vi.fn().mockResolvedValue([])}
    /></I18nProvider>);

    expect(screen.getByText(/Well pump/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Service pump/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit work" }));
    expect((screen.getByLabelText("Areas") as HTMLSelectElement).value).toBe(area.id);
    expect((screen.getByLabelText("Equipment \(optional\)") as HTMLSelectElement).value).toBe(equipment.id);
  });

  it("shows and creates Property-root work without requiring a Home", async () => {
    const state = createDemoState();
    const propertyId = state.properties[0]!.id;
    const propertyTask = task({
      id: "property-root-task",
      propertyId,
      houseId: null,
      floorId: null,
      title: "Inspect the property boundary",
    });
    const onCreateTask = vi.fn().mockResolvedValue(propertyTask);
    render(<I18nProvider><MaintenancePage
      state={{ ...state, houses: [], observations: [], maintenanceTasks: [propertyTask] }}
      propertyId={propertyId}
      houses={[]}
      onCreateTask={onCreateTask}
      onUpdateTask={vi.fn()}
      onReloadTask={vi.fn()}
      onLoadTaskRevisions={vi.fn().mockResolvedValue([])}
    /></I18nProvider>);

    expect(screen.getByText("Inspect the property boundary")).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Plan work" })[0]!);
    fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "Check the well cover" } });
    fireEvent.click(screen.getByRole("button", { name: /^Plan work$/ }));

    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      propertyId,
      houseId: null,
      floorId: null,
      title: "Check the well cover",
    })));
  });

  it("makes overdue summary filtering match its label and starts the selected work", async () => {
    const state = createDemoState();
    const overdue = task({ id: "overdue", title: "Overdue seal", dueBy: "2000-01-01" });
    const upcoming = task({ id: "upcoming", title: "Upcoming filter", dueBy: "2099-01-01" });
    const onUpdateTask = vi.fn().mockResolvedValue({ ...overdue, status: "in-progress", revision: 2 });
    render(<I18nProvider><MaintenancePage
      state={{ ...state, maintenanceTasks: [overdue, upcoming] }}
      house={state.houses[0]!}
      onCreateTask={vi.fn()}
      onUpdateTask={onUpdateTask}
      onReloadTask={vi.fn()}
      onLoadTaskRevisions={vi.fn().mockResolvedValue([])}
    /></I18nProvider>);

    expect(screen.getByRole("heading", { level: 1, name: "Maintenance" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Maintenance plan" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Overdue" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Upcoming" })).toBeTruthy();
    expect(screen.getByText("Status filters").closest("details")?.open).toBe(false);
    expect(screen.getByText("Search and evidence filters").closest("details")?.open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Overdue 1/ }));
    expect(screen.getByText("Overdue seal")).not.toBeNull();
    expect(screen.queryByText("Upcoming filter")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All active 2/ }));
    expect(screen.getByText("Upcoming filter")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Overdue 1/ }));
    const taskDisclosure = screen.getByRole("button", { name: /Overdue seal/ });
    expect(taskDisclosure).not.toHaveAttribute("aria-controls");
    fireEvent.click(taskDisclosure);
    const detailId = taskDisclosure.getAttribute("aria-controls");
    expect(detailId).toBeTruthy();
    expect(document.getElementById(detailId!)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start work" }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith("overdue", { baseRevision: 1, status: "in-progress" }));
    expect((await screen.findByText("Work status changed to In progress.", { selector: "p[role='status']" })).textContent).toBe("Work status changed to In progress.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Maintenance work status")));
  });

  it("deep-links the maintenance evidence filter and restores it on popstate", async () => {
    const state = createDemoState();
    const overdue = task({ id: "url-overdue", title: "URL overdue", dueBy: "2000-01-01" });
    const upcoming = task({ id: "url-upcoming", title: "URL upcoming", dueBy: "2099-01-01" });
    const completed = task({ id: "url-completed", title: "URL completed", status: "completed", dueBy: "2099-01-01" });
    window.history.replaceState(null, "", "/properties/property-pine/maintenance?keep=yes&filter=overdue&basis=condition-based&search=URL#plan");
    render(<I18nProvider><MaintenancePage
      state={{ ...state, maintenanceTasks: [overdue, upcoming, completed] }}
      house={state.houses[0]!}
      onCreateTask={vi.fn()}
      onUpdateTask={vi.fn()}
      onReloadTask={vi.fn()}
      onLoadTaskRevisions={vi.fn().mockResolvedValue([])}
    /></I18nProvider>);

    expect(screen.getByRole("button", { name: /Overdue 1/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Why this work exists")).toHaveValue("condition-based");
    expect(screen.getByLabelText("Search maintenance work")).toHaveValue("URL");
    expect(screen.getByText("URL overdue")).not.toBeNull();
    expect(screen.queryByText("URL upcoming")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Upcoming 1/ }));
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("upcoming");
    expect(new URLSearchParams(window.location.search).get("basis")).toBe("condition-based");
    expect(new URLSearchParams(window.location.search).get("search")).toBe("URL");
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
    expect(window.location.hash).toBe("#plan");

    fireEvent.click(screen.getByRole("button", { name: /All active 3/ }));
    expect(new URLSearchParams(window.location.search).has("filter")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");

    fireEvent.change(screen.getByLabelText("Why this work exists"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search maintenance work"), { target: { value: "" } });
    expect(window.location.search).toBe("?keep=yes");

    window.history.pushState(null, "", "?keep=yes&filter=invalid&basis=invalid&search=%20%20#plan");
    fireEvent(window, new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("button", { name: /All active 3/ })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByLabelText("Why this work exists")).toHaveValue("all");
    expect(screen.getByLabelText("Search maintenance work")).toHaveValue("");
    expect(window.location.search).toBe("?keep=yes");

    window.history.pushState(null, "", "?keep=yes&filter=completed#plan");
    fireEvent(window, new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Needs verification 1/ })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByText("URL completed")).not.toBeNull();
    expect(screen.queryByText("URL overdue")).toBeNull();
  });

  it("discards editor state when changing houses and consumes a seeded editor when closed", async () => {
    const state = createDemoState();
    const firstHouse = state.houses[0]!;
    const secondHouse = { ...firstHouse, id: "house-birch", name: "Birch House", floors: [{ ...firstHouse.floors[0]!, id: "birch-ground", name: "Birch ground" }] };
    const onSeedConsumed = vi.fn();
    const props = {
      state,
      onCreateTask: vi.fn(),
      onUpdateTask: vi.fn(),
      onReloadTask: vi.fn(),
      onLoadTaskRevisions: vi.fn().mockResolvedValue([]),
      onSeedConsumed,
    };
    const view = render(<I18nProvider><MaintenancePage {...props} house={firstHouse} initialObservationId={state.observations[0]!.id} /></I18nProvider>);

    fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "Unsaved draft" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onSeedConsumed).toHaveBeenCalledOnce();
    expect(screen.queryByDisplayValue("Unsaved draft")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Plan work" })[0]!);
    fireEvent.change(screen.getByLabelText("Work title"), { target: { value: "Second unsaved draft" } });
    view.rerender(<I18nProvider><MaintenancePage {...props} house={secondHouse} /></I18nProvider>);
    await waitFor(() => expect(screen.queryByDisplayValue("Second unsaved draft")).toBeNull());
    expect(screen.getAllByRole("button", { name: "Plan work" }).length).toBeGreaterThan(0);
  });

  it("reopens verified work at completed so completion evidence is preserved", async () => {
    const state = createDemoState();
    const verified = task({ id: "verified", title: "Verified seal", status: "verified", completionNote: "Seal replaced", completedAt: "2026-07-10T09:00:00.000Z", verificationNote: "No leak after rain", verifiedAt: "2026-07-11T09:00:00.000Z" });
    const onUpdateTask = vi.fn().mockResolvedValue({ ...verified, status: "completed", verificationNote: null, verifiedAt: null, revision: 2 });
    render(<I18nProvider><MaintenancePage
      state={{ ...state, maintenanceTasks: [verified] }}
      house={state.houses[0]!}
      onCreateTask={vi.fn()}
      onUpdateTask={onUpdateTask}
      onReloadTask={vi.fn()}
      onLoadTaskRevisions={vi.fn().mockResolvedValue([])}
    /></I18nProvider>);

    fireEvent.click(screen.getByText("Verified and cancelled work"));
    fireEvent.click(screen.getByRole("button", { name: /Verified seal/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen work" }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith("verified", { baseRevision: 1, status: "completed" }));
  });
});
