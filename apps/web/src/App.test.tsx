import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { I18nProvider } from "./i18n";

function renderApp() {
  return render(<I18nProvider><App /></I18nProvider>);
}

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("Stuga app", () => {
  it("updates the page title and moves focus only after SPA page changes", async () => {
    const user = userEvent.setup();
    const view = renderApp();
    await screen.findByRole("heading", { level: 1, name: "Your home, at a glance" });
    const main = view.container.querySelector("#main-content")!;

    expect(document.title).toBe("Home — Stuga");
    expect(document.activeElement).not.toBe(main);

    await user.click(screen.getByRole("button", { name: "Sensors" }));
    await screen.findByRole("heading", { level: 1, name: "Sensors" });
    await waitFor(() => expect(document.activeElement).toBe(main));
    expect(document.title).toBe("Sensors — Stuga");

    const activeHome = screen.getByRole("combobox", { name: "Active home" });
    activeHome.focus();
    fireEvent.change(activeHome, { target: { value: (activeHome as HTMLSelectElement).value } });
    await waitFor(() => expect(document.activeElement).toBe(activeHome));
    expect(document.title).toBe("Sensors — Stuga");
  });

  it("renders an accessible mock-backed twin and switches metrics", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Your home, at a glance" })).not.toBeNull();
    expect(screen.getByRole("group", { name: /Temperature map/i })).not.toBeNull();
    const metric = screen.getByRole("combobox", { name: "Metric" });
    expect(within(metric).getByRole("option", { name: /Carbon dioxide.*ppm/ })).not.toBeNull();
    await user.selectOptions(metric, "humidity");
    expect((metric as HTMLSelectElement).value).toBe("humidity");
    expect(screen.getByRole("group", { name: /Humidity map/i })).not.toBeNull();
  });

  it("opens the progressive Home Assistant onboarding experience", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Your home, at a glance" });
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(screen.getByRole("heading", { level: 1, name: "Connect your home" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");

    await user.click(screen.getByRole("tab", { name: /Connections/ }));
    const homeAssistantSection = screen.getByRole("heading", { name: "Use this option if your TP-Link sensors already appear in Home Assistant." }).closest("section")!;
    await user.click(within(homeAssistantSection).getByText("Advanced connection settings"));
    await user.click(within(homeAssistantSection).getByText("Advanced environment-variable setup"));
    expect(within(homeAssistantSection).getByText(/HA_URL=http:\/\/homeassistant\.local:8123/)).not.toBeNull();
    expect(within(homeAssistantSection).getByRole("button", { name: "Check server connection" })).not.toBeNull();
  });

  it("opens the sensor inventory and guided onboarding workspace", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Your home, at a glance" });

    await user.click(screen.getByRole("button", { name: "Sensors" }));

    expect(screen.getByRole("heading", { level: 1, name: "Sensors" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: /Sensors in/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add sensor" })).not.toBeNull();
  });
});
