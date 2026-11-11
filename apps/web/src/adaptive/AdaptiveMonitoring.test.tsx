import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AdaptiveFinding, AdaptiveReviewInput, AdaptiveSettings } from "@climate-twin/contracts";
import { createDemoState } from "../domain";
import { I18nProvider } from "../i18n";
import { ConfirmationProvider } from "../components/ConfirmationProvider";
import { AdaptiveLearningSettings } from "./AdaptiveLearningSettings";
import { AdaptiveFindingReview } from "./AdaptiveFindingReview";

const demo = createDemoState();
const house = demo.houses[0]!;
const thermometer = { ...demo.sensors[0]!, id: "example-thermometer", name: "Bedroom thermometer" };
const settings: AdaptiveSettings = { revision: 3, mode: "shadow", enabledAt: "2026-01-01T00:00:00Z", referenceGroups: [], promotionReceiptId: null };
const finding: AdaptiveFinding = {
  id: "example-finding", revision: 2, houseId: house.id, propertyId: house.propertyId, sensorId: thermometer.id,
  sensorName: thermometer.name, floorId: thermometer.floorId, room: "Bedroom", epoch: "example-epoch",
  metric: "temperature", kind: "climate-departure", direction: "low", severity: "notice", state: "candidate",
  firstEvidenceAt: "2026-11-11T10:00:00Z", lastEvidenceAt: "2026-11-11T12:00:00Z", recordedAt: "2026-11-11T12:05:00Z",
  freshness: "stale", observed: 18, expected: 21, low: 20, high: 22, unit: "°C", coverage: 0.9,
  sourceIds: [thermometer.id], contextGaps: [], modelId: "example-model", review: null,
};

describe("adaptive monitoring settings and evidence", () => {
  it("writes an explicit mode with its revision and prevents unqualified advisory selection", async () => {
    const save = vi.fn().mockResolvedValue(settings);
    render(<I18nProvider><AdaptiveLearningSettings settings={settings} sensors={[thermometer]} referenceSensors={[thermometer]}
      homeName="Cedar cottage" dataMode="live" busy={false} onSave={save} /></I18nProvider>);
    fireEvent.click(screen.getByText("Learning settings"));
    expect(screen.getByRole("option", { name: "Show qualified suggestions" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Learning mode" }), "off");
    expect(save).toHaveBeenCalledWith({ dataMode: "live", baseRevision: 3, mode: "off" });
    expect(await screen.findByText("Learning settings saved.")).toBeInTheDocument();
  });
  it("names the sensor and Home in a reset confirmation and preserves state on Cancel", async () => {
    const save = vi.fn().mockResolvedValue(settings);
    render(<I18nProvider><ConfirmationProvider><AdaptiveLearningSettings settings={settings} sensors={[thermometer]} referenceSensors={[thermometer]}
      homeName="Cedar cottage" dataMode="live" busy={false} onSave={save} /></ConfirmationProvider></I18nProvider>);
    fireEvent.click(screen.getByText("Learning settings")); fireEvent.click(screen.getByText("Start a new baseline"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sensor" }), thermometer.id);
    await userEvent.type(screen.getByRole("textbox", { name: "Reason for the new baseline" }), "Confirmed move");
    await userEvent.click(screen.getByRole("button", { name: "Start new baseline" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Bedroom thermometer in Cedar cottage");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Reason for the new baseline" })).toHaveValue("Confirmed move");
  });
  it("retries an unchanged review idempotently and explains delayed evidence", async () => {
    const reviews: AdaptiveReviewInput[] = [];
    const review = vi.fn(async (body: AdaptiveReviewInput) => {
      reviews.push(body); if (reviews.length === 1) throw new Error("Example connection failure");
    });
    render(<I18nProvider><AdaptiveFindingReview finding={finding} house={house} definition={demo.measurementDefinitions.find(d => d.id === "temperature")}
      units="metric" dataMode="live" readOnly={false} busy={false} open onOpen={() => undefined} onReview={review} /></I18nProvider>);
    expect(screen.getByText(/Missing readings do not confirm recovery/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Save review" });
    await userEvent.click(button); await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    await userEvent.click(button); await waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    expect(reviews[1]?.idempotencyKey).toBe(reviews[0]?.idempotencyKey);
    expect(await screen.findByText(/Review saved. It does not resolve/)).toBeInTheDocument();
  });
  it("offers evidence without a personal feedback form in a read-only view", () => {
    render(<I18nProvider><AdaptiveFindingReview finding={finding} house={house} definition={undefined} units="metric"
      dataMode="live" readOnly busy={false} open onOpen={() => undefined} onReview={vi.fn()} /></I18nProvider>);
    expect(screen.getByText("Review candidate")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
