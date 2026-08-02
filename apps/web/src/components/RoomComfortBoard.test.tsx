import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { BUILTIN_MEASUREMENTS } from "../measurements";
import { now, sample, sensor } from "./DecisionLayerTestSupport";
import { RoomComfortBoard } from "./RoomComfortBoard";

type OpenRoom = (floorId: string, roomId: string | null) => void;

function renderBoard(input: {
  latestMeasurements?: Record<string, Record<string, ReturnType<typeof sample>>>;
  onOpenRoom?: OpenRoom;
} = {}) {
  const onOpenRoom: OpenRoom = input.onOpenRoom ?? vi.fn();
  const view = render(
    <I18nProvider><RoomComfortBoard
      sensors={[sensor]}
      latestMeasurements={input.latestMeasurements ?? {}}
      measurementHistory={{}}
      definitions={BUILTIN_MEASUREMENTS}
      alerts={[]}
      units="metric"
      now={now}
      onOpenRoom={onOpenRoom}
    /></I18nProvider>,
  );
  return { ...view, onOpenRoom };
}

describe("RoomComfortBoard evidence", () => {
  it("labels missing evidence as unavailable instead of good quality", () => {
    const view = renderBoard();

    fireEvent.click(screen.getByRole("button", { name: /^Open Office\. Status: Waiting for data\./ }));
    const panel = view.container.querySelector<HTMLElement>(".room-evidence-panel")!;

    expect(within(panel).getAllByText("No data yet")).toHaveLength(3);
    expect(within(panel).queryByText("Good")).toBeNull();
  });

  it("opens stable Room evidence without stealing focus on data refresh and restores the trigger on close", async () => {
    const latestMeasurements = {
      [sensor.id]: {
        temperature: sample("temperature", 22),
        humidity: sample("humidity", 45),
      },
    };
    const view = renderBoard({ latestMeasurements });
    const roomCard = screen.getByRole("button", { name: /^Open Office\. Status: Comfortable\./ });

    expect(roomCard).not.toHaveAttribute("aria-controls");
    fireEvent.click(roomCard);
    const panel = view.container.querySelector<HTMLElement>(".room-evidence-panel")!;
    expect(roomCard).toHaveAttribute("aria-controls", panel.id);
    await waitFor(() => expect(document.activeElement).toBe(panel));
    expect(view.onOpenRoom).toHaveBeenCalledWith("floor", "room-office");

    const sensorDisclosure = within(panel).getByText(/^Sensors/).closest("summary")!;
    sensorDisclosure.focus();
    view.rerender(
      <I18nProvider><RoomComfortBoard
        sensors={[sensor]}
        latestMeasurements={{
          [sensor.id]: {
            temperature: sample("temperature", 23),
            humidity: sample("humidity", 46),
          },
        }}
        measurementHistory={{}}
        definitions={BUILTIN_MEASUREMENTS}
        alerts={[]}
        units="metric"
        now={now}
        onOpenRoom={view.onOpenRoom}
      /></I18nProvider>,
    );
    expect(document.activeElement).toBe(sensorDisclosure);

    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(roomCard));
    expect(roomCard.getAttribute("aria-expanded")).toBe("false");
    expect(roomCard).not.toHaveAttribute("aria-controls");
  });
});
