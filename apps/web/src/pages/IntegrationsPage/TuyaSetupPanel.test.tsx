import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../../api";
import { I18nProvider } from "../../i18n";
import { house, integration } from "../IntegrationsPageTestSupport";
import { TuyaSetupPanel } from "./TuyaSetupPanel";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tuya setup", () => {
  it("keeps discovery off until a Device ID and local key are supplied", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    const discover = vi.spyOn(api, "discoverTuya").mockResolvedValue([{
      host: "192.168.1.60",
      deviceId: "tuya-reading-lamp",
      protocolVersion: "3.5",
      productKey: null,
      mac: null,
    }]);
    const user = userEvent.setup();
    render(<I18nProvider><TuyaSetupPanel
      house={house}
      integration={integration}
      onIntegrationChange={vi.fn()}
    /></I18nProvider>);

    const section = screen.getByRole("heading", { name: "Tuya Wi-Fi" }).closest("section")!;
    expect(within(section).getByText(/Tuya discovery is off by default/)).not.toBeNull();
    expect(discover).not.toHaveBeenCalled();

    await user.click(section.querySelector(".tuya-add-device > summary")!);
    const enable = within(section).getByRole("button", { name: "Enable discovery and find device" }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    await user.type(within(section).getByLabelText("Device ID"), "tuya-reading-lamp");
    expect(enable.disabled).toBe(true);
    await user.type(within(section).getByLabelText("Local key"), "local-key-123456");
    expect(enable.disabled).toBe(false);

    await user.click(enable);
    await waitFor(() => expect(discover).toHaveBeenCalledWith({
      houseId: house.id,
      deviceId: "tuya-reading-lamp",
      localKey: "local-key-123456",
    }));
    expect(await within(section).findByText("Found and verified at 192.168.1.60 · LAN 3.5.")).not.toBeNull();
    expect((within(section).getByLabelText("Device ID") as HTMLInputElement).disabled).toBe(true);
    expect(within(section).getByLabelText("Device name")).not.toBeNull();
    expect(within(section).getByRole("button", { name: "Verify and add" })).not.toBeNull();
  });

  it("keeps manual address entry behind a fallback disclosure", async () => {
    localStorage.setItem("climate-twin-locale", "en");
    const discover = vi.spyOn(api, "discoverTuya");
    const user = userEvent.setup();
    render(<I18nProvider><TuyaSetupPanel
      house={house}
      integration={integration}
      onIntegrationChange={vi.fn()}
    /></I18nProvider>);

    const section = screen.getByRole("heading", { name: "Tuya Wi-Fi" }).closest("section")!;
    await user.click(section.querySelector(".tuya-add-device > summary")!);
    await user.type(within(section).getByLabelText("Device ID"), "tuya-reading-lamp");
    await user.type(within(section).getByLabelText("Local key"), "local-key-123456");
    const manual = within(section).getByText("Enter network details manually").closest("details")!;
    await user.click(manual.querySelector("summary")!);
    await user.type(within(manual).getByLabelText("Local IP address"), "192.168.1.61");
    await user.selectOptions(within(manual).getByLabelText("LAN protocol"), "3.4");
    await user.click(within(manual).getByRole("button", { name: "Continue with these details" }));

    expect(discover).not.toHaveBeenCalled();
    expect(await within(section).findByText("Ready to verify 192.168.1.61 · LAN 3.4 when you add it.")).not.toBeNull();
  });
});
