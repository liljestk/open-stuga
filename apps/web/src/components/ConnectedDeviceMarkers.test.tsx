import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedDeviceState } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { ConnectedDeviceMarker2D, ConnectedDeviceMarker3D } from "./ConnectedDeviceMarkers";

function light(): ConnectedDeviceState {
  const state = createDemoState();
  const floor = state.houses[0]!.floors[0]!;
  return {
    id: "tuya-safe-id",
    connectionId: "tuya-safe-id",
    houseId: state.houses[0]!.id,
    equipmentId: "equipment-tuya-safe-id",
    provider: "tuya-local",
    kind: "light",
    profileId: "tuya-light-dp20-v1",
    name: "Reading lamp",
    model: "A60",
    capabilities: {
      power: true,
      brightness: true,
      colorTemperature: true,
      color: true,
      measuredPower: false,
      measuredEnergy: false,
    },
    floorId: floor.id,
    roomId: null,
    x: 2,
    y: 3,
    z: floor.elevation + 1.2,
    observedAt: "2026-07-31T08:00:00.000Z",
    receivedAt: "2026-07-31T08:00:00.100Z",
    available: true,
    power: true,
    brightnessPercent: 52,
    colorTemperatureKelvin: 4000,
    color: { hue: 28, saturation: 20, value: 82 },
    workMode: "white",
    powerWatts: null,
    energyKwh: null,
    currentAmps: null,
    voltageVolts: null,
  };
}

describe("connected device map markers", () => {
  it("offers absolute live power control with visible and accessible state", () => {
    const floor = createDemoState().houses[0]!.floors[0]!;
    const onPowerChange = vi.fn();
    const view = render(<I18nProvider><svg>
      <ConnectedDeviceMarker2D
        device={light()}
        floor={floor}
        scale={10}
        editing={false}
        pending={false}
        onPowerChange={onPowerChange}
      />
    </svg></I18nProvider>);

    const marker = screen.getByRole("button", { name: /Reading lamp, Lamp, On/i });
    expect(marker.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector(".connected-device-state")?.textContent).toBe("On");
    fireEvent.click(marker);
    expect(onPowerChange).toHaveBeenCalledWith("tuya-safe-id", false);

    onPowerChange.mockClear();
    fireEvent.keyDown(marker, { key: " " });
    expect(onPowerChange).toHaveBeenCalledWith("tuya-safe-id", false);
  });

  it("supports keyboard placement in layout mode and disables runtime control while pending", () => {
    const floor = createDemoState().houses[0]!.floors[0]!;
    const onMove = vi.fn();
    const onPowerChange = vi.fn();
    const view = render(<I18nProvider><svg>
      <ConnectedDeviceMarker2D
        device={light()}
        floor={floor}
        scale={10}
        editing
        pending={false}
        onMove={onMove}
        onMoveFromClient={vi.fn()}
      />
    </svg></I18nProvider>);

    const movable = screen.getByRole("button", { name: /Drag or use the arrow keys/i });
    fireEvent.keyDown(movable, { key: "ArrowRight" });
    expect(onMove).toHaveBeenCalledWith("tuya-safe-id", { x: 2.1, y: 3 });

    onMove.mockClear();
    view.rerender(<I18nProvider><svg>
      <ConnectedDeviceMarker2D
        device={light()}
        floor={floor}
        scale={10}
        editing
        pending
        onMove={onMove}
        onMoveFromClient={vi.fn()}
      />
    </svg></I18nProvider>);
    const pendingMove = screen.getByRole("button", { name: /Changing/i });
    expect(pendingMove.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(pendingMove, { key: "ArrowRight" });
    expect(onMove).not.toHaveBeenCalled();

    view.rerender(<I18nProvider><svg>
      <ConnectedDeviceMarker2D
        device={light()}
        floor={floor}
        scale={10}
        editing={false}
        pending
        onPowerChange={onPowerChange}
      />
    </svg></I18nProvider>);
    const pending = screen.getByRole("button", { name: /Changing/i });
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(pending);
    expect(onPowerChange).not.toHaveBeenCalled();
  });

  it("uses the same provider-neutral control projection in 3D", () => {
    const floor = createDemoState().houses[0]!.floors[0]!;
    const onPowerChange = vi.fn();
    render(<I18nProvider><svg>
      <ConnectedDeviceMarker3D
        device={light()}
        floor={floor}
        position={{ x: 100, y: 120 }}
        anchor={{ x: 100, y: 160 }}
        activeFloor
        pending={false}
        onPowerChange={onPowerChange}
      />
    </svg></I18nProvider>);
    fireEvent.keyDown(screen.getByRole("button", { name: /Reading lamp, Lamp, On/i }), { key: "Enter" });
    expect(onPowerChange).toHaveBeenCalledWith("tuya-safe-id", false);
  });
});
