import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HouseLocationMap, type HouseLocationMapItem } from "./HouseLocationMap";

const leaflet = vi.hoisted(() => {
  type LatLngTuple = [number, number];
  type Handler = (event?: unknown) => void;
  type MarkerOptions = {
    alt?: string;
    draggable?: boolean;
    icon?: { html: string; iconSize: number[]; className: string };
    title?: string;
  };
  type MockMarker = {
    addTo: ReturnType<typeof vi.fn>;
    dragging: { disable: ReturnType<typeof vi.fn>; enable: ReturnType<typeof vi.fn> };
    element: HTMLElement;
    getElement: ReturnType<typeof vi.fn>;
    getLatLng: ReturnType<typeof vi.fn>;
    handlers: Map<string, Handler>;
    on: ReturnType<typeof vi.fn>;
    options: MarkerOptions;
    removeFrom: ReturnType<typeof vi.fn>;
    setDraggedLatLng: (latLng: LatLngTuple) => void;
    setIcon: ReturnType<typeof vi.fn>;
    setLatLng: ReturnType<typeof vi.fn>;
    setZIndexOffset: ReturnType<typeof vi.fn>;
  };
  type MockPath = {
    addTo: ReturnType<typeof vi.fn>;
    latLngs: LatLngTuple[];
    options: Record<string, unknown>;
    removeFrom: ReturnType<typeof vi.fn>;
    setLatLngs: ReturnType<typeof vi.fn>;
    setStyle: ReturnType<typeof vi.fn>;
  };

  const state = {
    mapHandlers: new Map<string, Handler>(),
    markers: [] as MockMarker[],
    polygons: [] as MockPath[],
    polylines: [] as MockPath[],
  };
  const map = {
    fitBounds: vi.fn(),
    invalidateSize: vi.fn(),
    on: vi.fn(),
    panTo: vi.fn(),
    remove: vi.fn(),
    setView: vi.fn(),
  };
  map.on.mockImplementation((name: string, handler: Handler) => {
    state.mapHandlers.set(name, handler);
    return map;
  });

  const divIconFactory = vi.fn((options: MarkerOptions["icon"]) => options);
  const markerFactory = vi.fn((latLng: LatLngTuple, options: MarkerOptions) => {
    let current = { lat: latLng[0], lng: latLng[1] };
    const handlers = new Map<string, Handler>();
    const marker: MockMarker = {
      addTo: vi.fn(),
      dragging: { disable: vi.fn(), enable: vi.fn() },
      element: document.createElement("div"),
      getElement: vi.fn(() => marker.element),
      getLatLng: vi.fn(() => current),
      handlers,
      on: vi.fn(),
      options: { ...options },
      removeFrom: vi.fn(),
      setDraggedLatLng: (next) => { current = { lat: next[0], lng: next[1] }; },
      setIcon: vi.fn(),
      setLatLng: vi.fn((next: LatLngTuple) => {
        current = { lat: next[0], lng: next[1] };
        return marker;
      }),
      setZIndexOffset: vi.fn(),
    };
    marker.addTo.mockReturnValue(marker);
    marker.on.mockImplementation((name: string, handler: Handler) => {
      handlers.set(name, handler);
      return marker;
    });
    state.markers.push(marker);
    return marker;
  });

  function makePath(latLngs: LatLngTuple[], options: Record<string, unknown>): MockPath {
    const path: MockPath = {
      addTo: vi.fn(),
      latLngs: latLngs.map((point) => [...point]),
      options: { ...options },
      removeFrom: vi.fn(),
      setLatLngs: vi.fn(),
      setStyle: vi.fn(),
    };
    path.addTo.mockReturnValue(path);
    path.setLatLngs.mockImplementation((next: LatLngTuple[]) => {
      path.latLngs = next.map((point) => [...point]);
      return path;
    });
    path.setStyle.mockImplementation((next: Record<string, unknown>) => {
      Object.assign(path.options, next);
      return path;
    });
    return path;
  }

  const polygonFactory = vi.fn((latLngs: LatLngTuple[], options: Record<string, unknown>) => {
    const path = makePath(latLngs, options);
    state.polygons.push(path);
    return path;
  });
  const polylineFactory = vi.fn((latLngs: LatLngTuple[], options: Record<string, unknown>) => {
    const path = makePath(latLngs, options);
    state.polylines.push(path);
    return path;
  });

  return { divIconFactory, map, markerFactory, polygonFactory, polylineFactory, state };
});

vi.mock("leaflet", () => ({
  default: {
    divIcon: leaflet.divIconFactory,
    map: vi.fn(() => leaflet.map),
    marker: leaflet.markerFactory,
    polygon: leaflet.polygonFactory,
    polyline: leaflet.polylineFactory,
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
  },
}));

const floor: NonNullable<HouseLocationMapItem["floor"]> = {
  width: 10,
  height: 4,
  walls: [
    { id: "top", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
    { id: "right", from: { x: 10, y: 0 }, to: { x: 10, y: 4 } },
    { id: "bottom", from: { x: 10, y: 4 }, to: { x: 0, y: 4 } },
    { id: "left", from: { x: 0, y: 4 }, to: { x: 0, y: 0 } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  leaflet.state.mapHandlers.clear();
  leaflet.state.markers.length = 0;
  leaflet.state.polygons.length = 0;
  leaflet.state.polylines.length = 0;
  leaflet.map.on.mockImplementation((name: string, handler: (event?: unknown) => void) => {
    leaflet.state.mapHandlers.set(name, handler);
    return leaflet.map;
  });
});

describe("HouseLocationMap", () => {
  it("renders two accessible handles and routes selection, dragging, and map clicks to the correct house", async () => {
    const onSelect = vi.fn();
    const onChange = vi.fn();
    const unsafeLabel = '<img src=x onerror="alert(1)">';
    const items: HouseLocationMapItem[] = [
      { id: "coast", label: "Coast house", location: { latitude: 60.17, longitude: 24.94 } },
      { id: "lake", label: unsafeLabel, location: { latitude: 61.5, longitude: 23.75 } },
    ];
    const { rerender } = render(
      <HouseLocationMap
        items={items}
        selectedHouseId="coast"
        editable
        onSelect={onSelect}
        onChange={onChange}
        ariaLabel="Property houses"
      />,
    );

    await waitFor(() => expect(leaflet.state.markers).toHaveLength(2));
    const coast = leaflet.state.markers.find((marker) => marker.options.title === "Coast house")!;
    const lake = leaflet.state.markers.find((marker) => marker.options.title === unsafeLabel)!;
    expect(coast.element.getAttribute("role")).toBe("button");
    expect(coast.element.tabIndex).toBe(0);
    expect(coast.element.getAttribute("aria-label")).toBe("Coast house");
    expect(coast.element.getAttribute("aria-pressed")).toBe("true");
    expect(lake.element.getAttribute("aria-label")).toBe(unsafeLabel);
    expect(lake.element.getAttribute("aria-pressed")).toBe("false");
    expect(coast.options.draggable).toBe(true);
    expect(lake.options.draggable).toBe(false);
    expect(coast.dragging.enable).toHaveBeenCalled();
    expect(lake.dragging.disable).toHaveBeenCalled();
    expect(coast.options.icon?.iconSize).toEqual([30, 38]);
    expect(lake.options.icon?.html).not.toContain(unsafeLabel);

    act(() => lake.handlers.get("click")?.());
    expect(onSelect).toHaveBeenCalledWith("lake");
    onSelect.mockClear();
    fireEvent.keyDown(lake.element, { key: "Enter" });
    fireEvent.keyDown(coast.element, { key: " " });
    expect(onSelect.mock.calls).toEqual([["lake"], ["coast"]]);

    coast.setDraggedLatLng([60.171, 24.942]);
    act(() => coast.handlers.get("dragend")?.());
    expect(onChange).toHaveBeenCalledWith("coast", { latitude: 60.171, longitude: 24.942 });

    const click = leaflet.state.mapHandlers.get("click")!;
    act(() => click({ latlng: { lat: 60.2, lng: 24.99 } }));
    expect(onChange).toHaveBeenLastCalledWith("coast", { latitude: 60.2, longitude: 24.99 });

    rerender(
      <HouseLocationMap
        items={items}
        selectedHouseId="lake"
        editable
        onSelect={onSelect}
        onChange={onChange}
        ariaLabel="Property houses"
      />,
    );
    await waitFor(() => expect(lake.options.draggable).toBe(true));
    expect(coast.options.draggable).toBe(false);
    expect(lake.element.getAttribute("aria-pressed")).toBe("true");
    act(() => click({ latlng: { lat: 61.6, lng: 23.8 } }));
    expect(onChange).toHaveBeenLastCalledWith("lake", { latitude: 61.6, longitude: 23.8 });

    const callsBeforeReadOnlyClick = onChange.mock.calls.length;
    rerender(
      <HouseLocationMap
        items={items}
        selectedHouseId="lake"
        editable={false}
        onSelect={onSelect}
        onChange={onChange}
        ariaLabel="Property houses"
      />,
    );
    act(() => click({ latlng: { lat: 62, lng: 24 } }));
    expect(onChange).toHaveBeenCalledTimes(callsBeforeReadOnlyClick);
  });

  it("draws geographic polygon and top-edge layers whose footprint doubles with plan scale", async () => {
    const item: HouseLocationMapItem = {
      id: "main",
      label: "Main house",
      location: { latitude: 60, longitude: 25 },
      orientationDegrees: 0,
      metersPerPlanUnit: 1,
      floor,
    };
    const { rerender } = render(
      <HouseLocationMap
        items={[item]}
        selectedHouseId="main"
        editable
        onSelect={vi.fn()}
        onChange={vi.fn()}
        ariaLabel="Property houses"
      />,
    );

    await waitFor(() => expect(leaflet.state.polygons).toHaveLength(1));
    expect(leaflet.state.polylines).toHaveLength(1);
    const polygon = leaflet.state.polygons[0]!;
    const first = polygon.latLngs.map((point) => [...point] as [number, number]);
    const span = (points: [number, number][], coordinate: 0 | 1) => (
      Math.max(...points.map((point) => point[coordinate])) - Math.min(...points.map((point) => point[coordinate]))
    );
    expect(span(first, 0)).toBeGreaterThan(0);
    expect(span(first, 1)).toBeGreaterThan(0);
    expect((first[0]![0] + first[1]![0]) / 2).toBeGreaterThan(60);

    rerender(
      <HouseLocationMap
        items={[{ ...item, metersPerPlanUnit: 2 }]}
        selectedHouseId="main"
        editable
        onSelect={vi.fn()}
        onChange={vi.fn()}
        ariaLabel="Property houses"
      />,
    );
    await waitFor(() => expect(polygon.setLatLngs).toHaveBeenCalled());
    expect(span(polygon.latLngs, 0)).toBeCloseTo(span(first, 0) * 2, 9);
    expect(span(polygon.latLngs, 1)).toBeCloseTo(span(first, 1) * 2, 9);
    expect(leaflet.polygonFactory).toHaveBeenCalledTimes(1);
    expect(leaflet.polylineFactory).toHaveBeenCalledTimes(1);

    const topEdge = leaflet.state.polylines[0]!;
    rerender(
      <HouseLocationMap
        items={[{ ...item, metersPerPlanUnit: 2, orientationDegrees: 90 }]}
        selectedHouseId="main"
        editable
        onSelect={vi.fn()}
        onChange={vi.fn()}
        ariaLabel="Property houses"
      />,
    );
    await waitFor(() => expect(topEdge.setLatLngs).toHaveBeenCalledTimes(2));
    expect((topEdge.latLngs[0]![1] + topEdge.latLngs[1]![1]) / 2).toBeGreaterThan(25);
  });

  it("falls back to fixed pins for unscaled or unoriented houses and skips unlocated houses", async () => {
    render(
      <HouseLocationMap
        items={[
          {
            id: "unscaled",
            label: "Unscaled house",
            location: { latitude: 60.17, longitude: 24.94 },
            orientationDegrees: 0,
            floor,
          },
          {
            id: "unoriented",
            label: "Unoriented house",
            location: { latitude: 60.18, longitude: 24.95 },
            metersPerPlanUnit: 1,
            floor,
          },
          { id: "unlocated", label: "Unlocated house", location: null },
        ]}
        selectedHouseId="unscaled"
        editable
        onSelect={vi.fn()}
        onChange={vi.fn()}
        ariaLabel="Property houses"
      />,
    );

    await waitFor(() => expect(leaflet.state.markers).toHaveLength(2));
    expect(leaflet.polygonFactory).not.toHaveBeenCalled();
    expect(leaflet.polylineFactory).not.toHaveBeenCalled();
    for (const marker of leaflet.state.markers) {
      expect(marker.options.icon?.html).toContain("house-location-marker");
      expect(marker.options.icon?.iconSize).toEqual([30, 38]);
    }
  });

  it("fits all houses initially and only moves again for an intentional viewport request", async () => {
    const firstItems: HouseLocationMapItem[] = [
      { id: "coast", label: "Coast house", location: { latitude: 60.17, longitude: 24.94 } },
      { id: "lake", label: "Lake house", location: { latitude: 61.5, longitude: 23.75 } },
    ];
    const props = {
      editable: true,
      onSelect: vi.fn(),
      onChange: vi.fn(),
      ariaLabel: "Property houses",
    };
    const { rerender } = render(
      <HouseLocationMap items={firstItems} selectedHouseId="coast" {...props} />,
    );

    await waitFor(() => expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1));
    expect(leaflet.map.setView).not.toHaveBeenCalled();
    expect(leaflet.map.fitBounds.mock.calls[0]?.[0]).toEqual([
      [60.17, 24.94],
      [61.5, 23.75],
    ]);

    const movedItems = [
      { ...firstItems[0]!, location: { latitude: 60.2, longitude: 25 } },
      firstItems[1]!,
    ];
    rerender(<HouseLocationMap items={movedItems} selectedHouseId="coast" {...props} />);
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1);
    expect(leaflet.map.setView).not.toHaveBeenCalled();

    rerender(<HouseLocationMap items={movedItems} selectedHouseId="coast" viewport="selected" {...props} />);
    await waitFor(() => expect(leaflet.map.setView).toHaveBeenCalledTimes(1));
    expect(leaflet.map.setView).toHaveBeenLastCalledWith([60.2, 25], 17, { animate: false });

    const secondDraft = [
      { ...movedItems[0]!, location: { latitude: 60.21, longitude: 25.01 } },
      movedItems[1]!,
    ];
    rerender(<HouseLocationMap items={secondDraft} selectedHouseId="coast" viewport="selected" {...props} />);
    expect(leaflet.map.setView).toHaveBeenCalledTimes(1);

    rerender(<HouseLocationMap items={secondDraft} selectedHouseId="lake" viewport="selected" {...props} />);
    await waitFor(() => expect(leaflet.map.setView).toHaveBeenCalledTimes(2));
    expect(leaflet.map.setView).toHaveBeenLastCalledWith([61.5, 23.75], 17, { animate: false });
  });
});
