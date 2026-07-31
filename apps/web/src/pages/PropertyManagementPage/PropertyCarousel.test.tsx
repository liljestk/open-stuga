import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../../domain";
import carouselStyles from "./PropertyCarousel.css?raw";
import { PropertyCarousel } from "./PropertyCarousel";

const messages: Record<string, string> = {
  "properties.browseProperties": "Browse properties",
  "properties.carouselHelp": "Swipe, scroll, or use the controls to move between properties.",
  "properties.previousProperty": "Previous property",
  "properties.nextProperty": "Next property",
  "properties.carouselPosition": "{current} of {count}",
  "properties.jumpToProperty": "Jump to property",
  "properties.noDescription": "No description has been added yet.",
  "properties.updated": "Updated {date}",
  "properties.houses": "Homes",
  "properties.areas": "Areas",
  "properties.inventory": "Inventory",
  "properties.openProperty": "Open {property}",
  "nav.maintenance": "Maintenance",
};

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string, values: Record<string, string | number> = {}) => Object.entries(values)
      .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[key] ?? key),
  }),
}));

describe("PropertyCarousel", () => {
  it("uses a horizontally scrollable snap track with touch-sized controls", () => {
    expect(carouselStyles).toMatch(/\.property-carousel-track\s*\{[^}]*grid-auto-flow:\s*column/);
    expect(carouselStyles).toMatch(/\.property-carousel-track\s*\{[^}]*overflow-x:\s*auto/);
    expect(carouselStyles).toMatch(/\.property-carousel-track\s*\{[^}]*scroll-snap-type:\s*x mandatory/);
    expect(carouselStyles).toMatch(/\.property-carousel-arrow\s*\{[^}]*width:\s*42px[^}]*height:\s*42px/);
  });

  it("browses dozens of properties directly and exposes useful details", () => {
    const state = createDemoState();
    const firstProperty = state.properties[0]!;
    state.properties = Array.from({ length: 24 }, (_, index) => ({
      ...firstProperty,
      id: `property-${index + 1}`,
      name: `Property ${index + 1}`,
      description: index === 0 ? "Woodland home and lakeside buildings." : null,
    }));
    state.houses = [{ ...state.houses[0]!, propertyId: "property-1" }];
    state.propertyAreas = [];
    state.areaEquipment = [];
    state.maintenanceTasks = [];
    const onOpenProperty = vi.fn();
    const { container } = render(<PropertyCarousel
      properties={state.properties}
      state={state}
      onOpenProperty={onOpenProperty}
      propertyShareLabel={() => null}
    />);

    expect(screen.getByRole("heading", { name: "Browse properties" })).not.toBeNull();
    const picker = screen.getByLabelText("Jump to property") as HTMLSelectElement;
    expect(picker.options).toHaveLength(24);
    const firstCard = container.querySelector<HTMLElement>(".property-index-card")!;
    expect(within(firstCard).getByText("Woodland home and lakeside buildings.")).not.toBeNull();
    expect(within(firstCard).getByText("Homes")).not.toBeNull();
    expect(within(firstCard).getByText("Inventory")).not.toBeNull();

    const track = container.querySelector<HTMLOListElement>(".property-carousel-track")!;
    track.focus();
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(picker.value).toBe("property-2");
    fireEvent.change(picker, { target: { value: "property-24" } });
    expect(picker.value).toBe("property-24");
    fireEvent.click(screen.getByRole("button", { name: "Open Property 24" }));
    expect(onOpenProperty).toHaveBeenCalledWith("property-24");
  });
});
