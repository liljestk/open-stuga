import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Floor, VentPlanElement } from "@climate-twin/contracts";
import { I18nProvider } from "../i18n";
import { applyAirflowPlanElementPatch, PlanElementAirflowFields } from "./PlanElementAirflowFields";

const floor: Floor = {
  id: "ground", name: "Ground", width: 10, height: 8, elevation: 0, ceilingHeight: 2.8,
  walls: [{ id: "wall", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }], rooms: [],
};

describe("PlanElementAirflowFields", () => {
  it("leads with conservative defaults and reveals a provider-neutral contact binding", () => {
    const onChange = vi.fn();
    render(<I18nProvider><PlanElementAirflowFields
      floor={floor}
      element={{ id: "door", kind: "door", wallId: "wall", position: { x: 5, y: 0 }, rotationDegrees: 0 }}
      onChange={onChange}
    /></I18nProvider>);

    expect((screen.getByRole("combobox", { name: "State" }) as HTMLSelectElement).value).toBe("closed");
    expect(screen.queryByText("Good default: Closed. Change it only when the real opening differs.")).not.toBeNull();
    const details = screen.getByText("Advanced airflow and sensor settings").closest("details");
    expect(details?.hasAttribute("open")).toBe(false);

    fireEvent.change(screen.getByRole("combobox", { name: "State" }), { target: { value: "open" } });
    expect(onChange).toHaveBeenLastCalledWith({ state: "open" });

    fireEvent.click(screen.getByText("Advanced airflow and sensor settings"));
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "tapo" } });
    const deviceId = screen.getByRole("textbox", { name: "Entity or device id" });
    fireEvent.change(deviceId, { target: { value: "contact-entry" } });
    fireEvent.blur(deviceId);
    expect(onChange).toHaveBeenLastCalledWith({
      stateBinding: { provider: "tapo", externalId: "contact-entry" },
    });
  });

  it("can clear overrides without applying a variant from another element kind", () => {
    const vent: VentPlanElement = {
      id: "vent", kind: "vent", position: { x: 4, y: 3 }, rotationDegrees: 0,
      state: "closed", variant: "extract", nominalFlowM3h: 80,
    };
    const next = applyAirflowPlanElementPatch(vent, { state: undefined, variant: "fixed", nominalFlowM3h: undefined });
    expect(next).not.toHaveProperty("state");
    expect(next).not.toHaveProperty("nominalFlowM3h");
    expect(next.variant).toBe("extract");
  });

  it("clears mutable state and sensor bindings for a physically fixed variant", () => {
    const onChange = vi.fn();
    render(<I18nProvider><PlanElementAirflowFields
      floor={floor}
      element={{
        id: "door", kind: "door", wallId: "wall", position: { x: 5, y: 0 }, rotationDegrees: 0,
        state: "closed", stateBinding: { provider: "tapo", externalId: "contact-entry" },
      }}
      onChange={onChange}
    /></I18nProvider>);

    fireEvent.change(screen.getByRole("combobox", { name: "Variant" }), { target: { value: "open-passage" } });
    expect(onChange).toHaveBeenLastCalledWith({ variant: "open-passage", state: undefined, stateBinding: undefined });
  });
});
