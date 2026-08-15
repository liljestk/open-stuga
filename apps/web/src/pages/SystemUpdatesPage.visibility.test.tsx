import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, type SystemUpdateStatus } from "../api";
import { I18nProvider } from "../i18n";
import { SystemUpdatesPage } from "./SystemUpdatesPage";

vi.mock("./HostSystemPanel", () => ({ HostSystemPanel: () => null }));
vi.mock("./SystemStoragePanel", () => ({ SystemStoragePanel: () => null }));
vi.mock("./BugReportRelayPanel", () => ({ BugReportRelayPanel: () => null }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen = null;
  onerror = null;
  onmessage = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(): void {}
  close(): void { this.closed = true; }
}

const status = {
  currentVersion: "0.39.2",
  latestVersion: null,
  updateAvailable: false,
  latestRelease: null,
  releases: [],
  lastCheckedAt: null,
  checkError: null,
  settings: {
    mode: "manual",
    includePrereleases: false,
    checkIntervalHours: 24,
    updateTime: "03:00",
    updateDays: ["sun"],
    timezone: "UTC",
  },
  nextUpdateWindowAt: null,
  capability: {
    available: false,
    runtime: null,
    agentLastSeenAt: null,
    reason: "not-configured",
  },
  operation: null,
} satisfies SystemUpdateStatus;

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("releases the update stream while hidden and reloads complete status on resume", async () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("EventSource", FakeEventSource);
  const loadStatus = vi.spyOn(api, "systemUpdateStatus").mockResolvedValue(status);
  const view = render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);
  try {
    await screen.findByRole("heading", { name: "System", level: 1 });
    expect(loadStatus).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(FakeEventSource.instances[0]?.closed).toBe(true);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    await waitFor(() => expect(loadStatus).toHaveBeenCalledTimes(2));
    expect(FakeEventSource.instances[1]?.closed).toBe(false);
  } finally {
    view.unmount();
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    else Reflect.deleteProperty(document, "hidden");
  }
});

it("replaces a pristine settings draft with authoritative settings on resume", async () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("EventSource", FakeEventSource);
  const resumed = {
    ...status,
    settings: { ...status.settings, mode: "automatic" as const, updateTime: "04:30" },
  };
  vi.spyOn(api, "systemUpdateStatus").mockResolvedValueOnce(status).mockResolvedValueOnce(resumed);
  const view = render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);
  try {
    await screen.findByRole("heading", { name: "System", level: 1 });
    fireEvent.click(screen.getByText("When should updates install?").closest("summary")!);
    expect(screen.getByRole("radio", { name: /Manual/ })).toBeChecked();

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    await waitFor(() => expect(screen.getByRole("radio", { name: /Automatic/ })).toBeChecked());
    expect(screen.getByLabelText("Update time")).toHaveValue("04:30");
  } finally {
    view.unmount();
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    else Reflect.deleteProperty(document, "hidden");
  }
});

it("preserves a genuinely edited settings draft on resume", async () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("EventSource", FakeEventSource);
  const resumed = {
    ...status,
    settings: { ...status.settings, mode: "automatic" as const, updateTime: "04:30" },
  };
  vi.spyOn(api, "systemUpdateStatus").mockResolvedValueOnce(status).mockResolvedValueOnce(resumed);
  const view = render(<I18nProvider><SystemUpdatesPage /></I18nProvider>);
  try {
    await screen.findByRole("heading", { name: "System", level: 1 });
    fireEvent.click(screen.getByText("When should updates install?").closest("summary")!);
    fireEvent.change(screen.getByLabelText("Update time"), { target: { value: "05:45" } });

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    await waitFor(() => expect(api.systemUpdateStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("radio", { name: /Manual/ })).toBeChecked();
    expect(screen.getByLabelText("Update time")).toHaveValue("05:45");
  } finally {
    view.unmount();
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    else Reflect.deleteProperty(document, "hidden");
  }
});
