import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AreaEquipment } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { EquipmentQrLabel, equipmentQrPayload } from "./EquipmentQrLabel";

const originalClipboard = navigator.clipboard;

const equipment: AreaEquipment = {
  id: "tractor old",
  propertyId: "property/pine",
  areaId: null,
  houseId: "home-main",
  name: "Tractor",
  kind: "vehicle",
  manufacturer: "Valmet",
  model: "Old",
  serialNumber: "123-OLD",
  status: "active",
  notes: null,
  createdAt: "2026-07-26T08:00:00.000Z",
  updatedAt: "2026-07-26T08:00:00.000Z",
};

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  vi.restoreAllMocks();
});

describe("equipment QR label", () => {
  it("uses the stable native-compatible equipment URI", () => {
    expect(equipmentQrPayload(equipment.propertyId, equipment.id)).toBe(
      "stuga://equipment?property=property%2Fpine&id=tractor+old&v=1",
    );
  });

  it("renders, copies, and prints the equipment label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);

    render(<I18nProvider><EquipmentQrLabel
      equipment={equipment}
      propertyName="Pine Estate"
      locationLabel="Main Home"
    /></I18nProvider>);

    expect(screen.getByRole("img", { name: "QR code for Tractor" })).not.toBeNull();
    expect(screen.getByText("stuga://equipment?property=property%2Fpine&id=tractor+old&v=1")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy QR value" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "stuga://equipment?property=property%2Fpine&id=tractor+old&v=1",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Print label" }));
    expect(print).toHaveBeenCalledOnce();
  });
});
