import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useClimateData } from "./useClimateData";
import { findPageHeading, mockClimateData, renderApp } from "./AppTestSupport";

vi.mock("./useClimateData", () => ({ useClimateData: vi.fn() }));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  mockClimateData();
});

describe("App Home query restoration", () => {
  it("does not reset floor or sensor when popstate stays in the same Home", async () => {
    const climate = mockClimateData();
    const selectHouse = vi.fn().mockResolvedValue(undefined);
    climate.selectHouse = selectHouse;
    const house = climate.state.houses[0]!;
    window.history.replaceState(null, "", `/properties/${house.propertyId}/homes/${house.id}`);
    const view = renderApp();

    await findPageHeading(house.name);
    fireEvent.click(screen.getByRole("button", { name: "Open live home view" }));
    await screen.findByLabelText("Floor");
    selectHouse.mockClear();

    window.history.pushState(null, "", `${window.location.pathname}?floor=floor-upper&metric=humidity&view=isometric&sensor=sensor-bathroom&range=7d`);
    fireEvent(window, new PopStateEvent("popstate"));

    await waitFor(() => expect(screen.getByLabelText("Floor")).toHaveValue("floor-upper"));
    expect(screen.getByLabelText("Metric")).toHaveValue("humidity");
    expect(screen.getByRole("button", { name: "3D building" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(view.container.querySelector(".sensor-inspector #selected-sensor-title")).toHaveTextContent("Bathroom"));
    expect(selectHouse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Open analysis tools"));
    expect(await screen.findByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  });
});
