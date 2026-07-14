import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HouseLocationMap } from "./HouseLocationMap";

const leaflet = vi.hoisted(() => {
  const state = { markerElement: null as HTMLElement | null };
  const map = {
    invalidateSize: vi.fn(),
    on: vi.fn(),
    panTo: vi.fn(),
    remove: vi.fn(),
  };
  const marker = {
    options: {} as { title?: string; alt?: string },
    addTo: vi.fn(),
    getElement: vi.fn(() => state.markerElement ?? undefined),
    getLatLng: vi.fn(() => ({ lat: 60.17, lng: 24.94 })),
    on: vi.fn(),
    removeFrom: vi.fn(),
    setLatLng: vi.fn(),
  };
  marker.addTo.mockImplementation(() => marker);
  const markerFactory = vi.fn((_latLng: unknown, options: { title?: string; alt?: string }) => {
    Object.assign(marker.options, options);
    return marker;
  });
  return { map, marker, markerFactory, state };
});

vi.mock("leaflet", () => ({
  default: {
    divIcon: vi.fn((options) => options),
    latLng: vi.fn((latitude, longitude) => ({ lat: latitude, lng: longitude })),
    map: vi.fn(() => leaflet.map),
    marker: leaflet.markerFactory,
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  leaflet.state.markerElement = document.createElement("div");
  leaflet.marker.options = {};
  leaflet.marker.addTo.mockImplementation(() => leaflet.marker);
});

describe("HouseLocationMap", () => {
  it("updates an existing marker's accessible label when the selected house changes", async () => {
    const location = { latitude: 60.17, longitude: 24.94 };
    const { rerender } = render(
      <HouseLocationMap
        value={location}
        onChange={vi.fn()}
        ariaLabel="House location map"
        markerLabel="Coast house location"
      />,
    );

    await waitFor(() => expect(leaflet.state.markerElement?.getAttribute("aria-label")).toBe("Coast house location"));
    rerender(
      <HouseLocationMap
        value={location}
        onChange={vi.fn()}
        ariaLabel="House location map"
        markerLabel="Lake house location"
      />,
    );

    await waitFor(() => expect(leaflet.state.markerElement?.getAttribute("title")).toBe("Lake house location"));
    expect(leaflet.state.markerElement?.getAttribute("aria-label")).toBe("Lake house location");
    expect(leaflet.marker.options).toMatchObject({ title: "Lake house location", alt: "Lake house location" });
    expect(leaflet.markerFactory).toHaveBeenCalledTimes(1);
  });
});
