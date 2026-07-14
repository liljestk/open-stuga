import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { I18nProvider } from "./i18n";

function renderApp() {
  return render(<I18nProvider><App /></I18nProvider>);
}

describe("Climate Twin app", () => {
  it("renders an accessible mock-backed twin and switches metrics", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(screen.getByRole("heading", { level: 1, name: "Climate map" })).not.toBeNull();
    expect(screen.getByRole("group", { name: /Temperature map/i })).not.toBeNull();
    const metric = screen.getByRole("combobox", { name: "Metric" });
    expect(within(metric).getByRole("option", { name: /Carbon dioxide.*ppm/ })).not.toBeNull();
    await user.selectOptions(metric, "humidity");
    expect((metric as HTMLSelectElement).value).toBe("humidity");
    expect(screen.getByRole("group", { name: /Humidity map/i })).not.toBeNull();
  });

  it("opens the Home Assistant onboarding experience", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(screen.getByRole("heading", { level: 1, name: "Connect your home" })).not.toBeNull();
    expect(screen.getByText(/HA_URL=http:\/\/homeassistant\.local:8123/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Check server connection" })).not.toBeNull();
  });
});
