import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ReplayControls } from "./ReplayControls";

const min = Date.parse("2026-07-14T20:30:00.000Z");
const timestamp = Date.parse("2026-07-14T21:30:00.000Z");
const max = Date.parse("2026-07-14T22:30:00.000Z");

function renderControls(timeZone = "Europe/Helsinki") {
  return render(
    <I18nProvider>
      <ReplayControls
        active playing={false} timestamp={timestamp} min={min} max={max} speed={4} timeZone={timeZone}
        onActive={vi.fn()} onPlaying={vi.fn()} onTimestamp={vi.fn()} onSpeed={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe("ReplayControls time and speed labels", () => {
  it("uses the house timezone and includes dates when its calendar day changes", () => {
    const view = renderControls();
    const expected = (value: number) => new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Helsinki",
    }).format(value);
    const labels = Array.from(view.container.querySelectorAll(".timeline-labels time"));

    expect(labels.map((label) => label.textContent)).toEqual([expected(min), expected(max)]);
    expect(screen.getByText(`Replaying ${expected(timestamp)}`)).not.toBeNull();
  });

  it("falls back to the browser timezone when a configured timezone is invalid", () => {
    expect(() => renderControls("Not/A_Timezone")).not.toThrow();
    expect(screen.getByText(/^Replaying /)).not.toBeNull();
    expect(document.querySelectorAll(".timeline-labels time")).toHaveLength(2);
  });

  it("localizes every speed option", () => {
    localStorage.setItem("climate-twin-locale", "fi");
    renderControls();
    const select = screen.getByLabelText("Toistonopeus");

    expect(within(select).getByRole("option", { name: "1 minuutti sekunnissa" })).not.toBeNull();
    expect(within(select).getByRole("option", { name: "4 minuuttia sekunnissa" })).not.toBeNull();
    expect(within(select).getByRole("option", { name: "12 minuuttia sekunnissa" })).not.toBeNull();
    expect(within(select).getByRole("option", { name: "48 minuuttia sekunnissa" })).not.toBeNull();
  });
});
