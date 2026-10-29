import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Tabs } from "./Tabs";

type View = "rooms" | "sensors" | "history";

function Harness({ initial = "rooms" }: { initial?: View }) {
  const [selected, setSelected] = useState<View>(initial);
  return <Tabs
    label="Home views"
    items={[{ id: "rooms", label: "Rooms" }, { id: "sensors", label: "Sensors", count: 8 }, { id: "history", label: "History", detail: "Last 30 days" }]}
    selected={selected}
    onSelect={setSelected}
    tabId={(id) => `view-${id}-tab`}
    panelId={(id) => `view-${id}-panel`}
  />;
}

describe("Tabs", () => {
  it("names the list and wires every tab to its panel with one tab stop", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Home views" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => [tab.id, tab.getAttribute("aria-controls"), tab.tabIndex])).toEqual([
      ["view-rooms-tab", "view-rooms-panel", 0],
      ["view-sensors-tab", "view-sensors-panel", -1],
      ["view-history-tab", "view-history-panel", -1],
    ]);
    expect(screen.getByRole("tab", { name: /^Sensors/ }).querySelector(".tab-count")?.textContent).toBe("8");
    expect(screen.getByRole("tab", { name: /^History/ }).querySelector(".tab-copy small")?.textContent).toBe("Last 30 days");
  });

  it("moves selection and focus with arrows on either axis, wrapping, and with Home and End", () => {
    render(<Harness />);
    const selectedName = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.id;
    fireEvent.keyDown(screen.getByRole("tab", { name: "Rooms" }), { key: "ArrowRight" });
    expect(selectedName()).toBe("view-sensors-tab");
    expect(document.activeElement?.id).toBe("view-sensors-tab");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(selectedName()).toBe("view-rooms-tab");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(selectedName()).toBe("view-history-tab");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement?.id).toBe("view-rooms-tab");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(selectedName()).toBe("view-history-tab");
    fireEvent.keyDown(document.activeElement!, { key: "a" });
    expect(selectedName()).toBe("view-history-tab");
  });

  it("keeps one tab stop when the selection is outside the list", () => {
    render(<Tabs label="Set up" items={[{ id: "connect", label: "Connect" }, { id: "place", label: "Place" }]} selected="backup" onSelect={() => undefined} tabId={(id) => id} panelId={(id) => `${id}-panel`} />);
    expect(screen.getAllByRole("tab").map((tab) => [tab.tabIndex, tab.getAttribute("aria-selected")])).toEqual([[0, "false"], [-1, "false"]]);
  });

  it("selects on click", () => {
    render(<Harness initial="history" />);
    fireEvent.click(screen.getByRole("tab", { name: "Rooms" }));
    expect(screen.getByRole("tab", { name: "Rooms" }).getAttribute("aria-selected")).toBe("true");
  });
});
