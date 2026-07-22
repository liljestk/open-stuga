import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeAreaLayerAccessible, makeEditableHandleAccessible, PropertyAreaMap, propertyViewportPlan } from "./PropertyAreaMap";

const leaflet = vi.hoisted(() => {
  type Handler = (event?: any) => void;
  const mapHandlers = new Map<string, Handler>();
  const markerHandlers = new Map<string, Handler>();
  let markerLatLng = { lat: 60.17, lng: 24.93 };
  const marker = {
    addTo: vi.fn(),
    dragging: { enable: vi.fn(), disable: vi.fn() },
    getElement: vi.fn(() => document.createElement("div")),
    getLatLng: vi.fn(() => markerLatLng),
    on: vi.fn((name: string, handler: Handler) => { markerHandlers.set(name, handler); return marker; }),
    removeFrom: vi.fn(),
    setIcon: vi.fn(() => marker),
    setLatLng: vi.fn((point: [number, number]) => { markerLatLng = { lat: point[0], lng: point[1] }; return marker; }),
    setZIndexOffset: vi.fn(() => marker),
  };
  marker.addTo.mockReturnValue(marker);
  const map = {
    fitBounds: vi.fn(),
    invalidateSize: vi.fn(),
    mouseEventToLatLng: vi.fn(() => ({ lat: 61.25, lng: 25.75 })),
    on: vi.fn((name: string, handler: Handler) => { mapHandlers.set(name, handler); return map; }),
    remove: vi.fn(),
    setView: vi.fn(),
  };
  return {
    map,
    mapHandlers,
    marker,
    markerHandlers,
    markerFactory: vi.fn((point: [number, number]) => {
      markerLatLng = { lat: point[0], lng: point[1] };
      return marker;
    }),
    moveMarker: (lat: number, lng: number) => { markerLatLng = { lat, lng }; },
  };
});

vi.mock("leaflet", () => ({
  default: {
    DomEvent: { stopPropagation: vi.fn() },
    divIcon: vi.fn((options) => options),
    map: vi.fn(() => leaflet.map),
    marker: leaflet.markerFactory,
    polygon: vi.fn(() => ({ addTo: vi.fn(), getElement: vi.fn(), on: vi.fn(), removeFrom: vi.fn(), setLatLngs: vi.fn(), setStyle: vi.fn() })),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
  },
}));

describe("property area map accessibility", () => {
  it("makes polygon paths focusable and activates them with Enter or Space", () => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const onActivate = vi.fn();

    makeAreaLayerAccessible(path, "North well", true, onActivate);

    expect(path.getAttribute("role")).toBe("button");
    expect(path.getAttribute("tabindex")).toBe("0");
    expect(path.getAttribute("aria-label")).toBe("North well");
    expect(path.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(path, { key: "ArrowRight" });
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.keyDown(path, { key: "Enter" });
    fireEvent.keyDown(path, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("moves editable boundary handles with the keyboard", () => {
    const element = document.createElement("div");
    let point = { lat: 60.17, lng: 24.93 };
    const marker = {
      getElement: () => element,
      getLatLng: () => point,
      setLatLng: ([lat, lng]: [number, number]) => { point = { lat, lng }; },
    };
    const onActivate = vi.fn();
    const onMove = vi.fn();

    makeEditableHandleAccessible(marker as never, "Move boundary point 1", onActivate, onMove);
    expect(element.getAttribute("role")).toBe("button");
    expect(element.tabIndex).toBe(0);
    fireEvent.keyDown(element, { key: "ArrowRight" });
    expect(onMove).toHaveBeenLastCalledWith({ latitude: 60.17, longitude: 24.93001 });
    fireEvent.keyDown(element, { key: "ArrowUp", shiftKey: true });
    expect(onMove.mock.calls.at(-1)?.[0].latitude).toBeCloseTo(60.1701, 6);
    expect(onMove.mock.calls.at(-1)?.[0].longitude).toBeCloseTo(24.93001, 6);
    fireEvent.keyDown(element, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("places a selected home by map click, marker drag, or dropping its card", async () => {
    const onMoveHouse = vi.fn();
    render(<PropertyAreaMap
      areas={[]}
      houses={[{
        id: "house-main",
        name: "Main home",
        mapPlacement: { latitude: 60.17, longitude: 24.93, metersPerPlanUnit: 1 },
      }]}
      selectedAreaId={null}
      selectedHouseId="house-main"
      editableHouseId="house-main"
      onSelectArea={vi.fn()}
      onSelectHouse={vi.fn()}
      onMoveHouse={onMoveHouse}
      onAppendVertex={vi.fn()}
      vertexLabel={() => "Boundary point"}
      midpointLabel={() => "Boundary midpoint"}
      ariaLabel="Property map"
    />);

    await waitFor(() => expect(leaflet.mapHandlers.get("click")).toBeTypeOf("function"));
    act(() => leaflet.mapHandlers.get("click")?.({ latlng: { lat: 60.5, lng: 24.5 } }));
    expect(onMoveHouse).toHaveBeenLastCalledWith("house-main", { latitude: 60.5, longitude: 24.5 });

    leaflet.moveMarker(60.75, 24.75);
    act(() => leaflet.markerHandlers.get("dragend")?.());
    expect(onMoveHouse).toHaveBeenLastCalledWith("house-main", { latitude: 60.75, longitude: 24.75 });

    const dataTransfer = {
      types: ["application/x-stuga-house-id"],
      getData: (type: string) => type === "application/x-stuga-house-id" ? "house-main" : "",
    };
    fireEvent.dragOver(screen.getByRole("region", { name: "Property map" }), { dataTransfer });
    fireEvent.drop(screen.getByRole("region", { name: "Property map" }), { dataTransfer });
    expect(onMoveHouse).toHaveBeenLastCalledWith("house-main", { latitude: 61.25, longitude: 25.75 });
  });

  it("places a fixed asset by map click, marker drag, or dropping its card", async () => {
    const onMoveAsset = vi.fn();
    render(<PropertyAreaMap
      areas={[{
        id: "asset-well",
        propertyId: "property-main",
        name: "North well",
        kind: "well",
        description: null,
        location: { latitude: 60.17, longitude: 24.93 },
        polygon: [],
        createdAt: "2026-07-18T08:00:00.000Z",
        updatedAt: "2026-07-18T08:00:00.000Z",
      }]}
      selectedAreaId="asset-well"
      selectedAssetId="asset-well"
      editableAssetId="asset-well"
      onSelectArea={vi.fn()}
      onSelectAsset={vi.fn()}
      onMoveAsset={onMoveAsset}
      onAppendVertex={vi.fn()}
      vertexLabel={() => "Boundary point"}
      midpointLabel={() => "Boundary midpoint"}
      ariaLabel="Fixed asset map"
    />);

    await waitFor(() => expect(leaflet.mapHandlers.get("click")).toBeTypeOf("function"));
    act(() => leaflet.mapHandlers.get("click")?.({ latlng: { lat: 60.6, lng: 24.6 } }));
    expect(onMoveAsset).toHaveBeenLastCalledWith("asset-well", { latitude: 60.6, longitude: 24.6 });

    leaflet.moveMarker(60.8, 24.8);
    act(() => leaflet.markerHandlers.get("dragend")?.());
    expect(onMoveAsset).toHaveBeenLastCalledWith("asset-well", { latitude: 60.8, longitude: 24.8 });

    const dataTransfer = {
      types: ["application/x-stuga-property-asset-id"],
      getData: (type: string) => type === "application/x-stuga-property-asset-id" ? "asset-well" : "",
    };
    fireEvent.drop(screen.getByRole("region", { name: "Fixed asset map" }), { dataTransfer });
    expect(onMoveAsset).toHaveBeenLastCalledWith("asset-well", { latitude: 61.25, longitude: 25.75 });
  });

  it("replaces the provisional property center when the first geometry appears", () => {
    const propertyLocation = { latitude: 60.17, longitude: 24.93 };
    const provisional = propertyViewportPlan([], [], propertyLocation, "property-main");
    const mapped = propertyViewportPlan([{
      id: "area-yard",
      propertyId: "property-main",
      name: "Yard",
      kind: "yard",
      description: null,
      polygon: [
        { latitude: 60.171, longitude: 24.931 },
        { latitude: 60.171, longitude: 24.932 },
        { latitude: 60.172, longitude: 24.932 },
      ],
      createdAt: "2026-07-16T08:00:00.000Z",
      updatedAt: "2026-07-16T08:00:00.000Z",
    }], [], propertyLocation, "property-main");

    expect(provisional).toEqual({
      state: "property-main:property:60.17:24.93",
      points: [[60.17, 24.93]],
    });
    expect(mapped?.state).toBe("property-main:geometry");
    expect(mapped?.points).toHaveLength(3);
  });
});
