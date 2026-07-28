import { describe, expect, it } from "vitest";
import type { OpeningStateObservation } from "@climate-twin/contracts";
import { deriveOpeningAnalytics, type OpeningAnalyticsTarget } from "./openingAnalytics";

const from = Date.parse("2026-07-28T00:00:00.000Z");
const to = Date.parse("2026-07-28T04:00:00.000Z");

const target: OpeningAnalyticsTarget = {
  key: "ground:front-door",
  floorId: "ground",
  floorName: "Ground floor",
  elementId: "front-door",
  kind: "door",
  label: "Front door",
  binding: { provider: "tapo", externalId: "t110-entry", staleAfterSeconds: 900 },
};

function observation(
  id: string,
  observedAt: string,
  state: OpeningStateObservation["state"],
): OpeningStateObservation {
  return {
    id,
    houseId: "home",
    floorId: "ground",
    elementId: "front-door",
    state,
    source: "tapo",
    observedAt,
    externalId: "t110-entry",
  };
}

describe("deriveOpeningAnalytics", () => {
  it("deduplicates heartbeats and bounds open time when a provider becomes stale", () => {
    const result = deriveOpeningAnalytics([target], [
      observation("seed", "2026-07-27T23:55:00.000Z", "closed"),
      observation("open-1", "2026-07-28T01:00:00.000Z", "open"),
      observation("heartbeat", "2026-07-28T01:10:00.000Z", "open"),
      observation("close-1", "2026-07-28T01:30:00.000Z", "closed"),
      observation("open-2", "2026-07-28T02:00:00.000Z", "open"),
      observation("unknown", "2026-07-28T02:10:00.000Z", "unknown"),
      observation("close-2", "2026-07-28T02:20:00.000Z", "closed"),
    ], from, to);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      openedCount: 2,
      closedCount: 1,
      observationCount: 6,
      confirmedOpenMs: 35 * 60_000,
      longestOpenMs: 25 * 60_000,
      currentState: "unknown",
    });
    expect(result[0]!.records.map((record) => record.transition)).toEqual([
      "opened",
      "closed",
      "opened",
      "unknown",
      "initial",
    ]);
    expect(result[0]!.segments).toContainEqual({
      state: "open",
      startedAt: Date.parse("2026-07-28T01:00:00.000Z"),
      endedAt: Date.parse("2026-07-28T01:25:00.000Z"),
    });
  });

  it("respects an inverted contact binding when counting openings", () => {
    const inverted = {
      ...target,
      binding: { ...target.binding!, invert: true },
    };
    const result = deriveOpeningAnalytics([inverted], [
      observation("seed", "2026-07-27T23:55:00.000Z", "closed"),
      observation("raw-open", "2026-07-28T01:00:00.000Z", "open"),
      observation("raw-close", "2026-07-28T01:30:00.000Z", "closed"),
    ], from, Date.parse("2026-07-28T01:35:00.000Z"));

    expect(result[0]!.openedCount).toBe(1);
    expect(result[0]!.records.map((record) => record.state)).toEqual(["closed", "open"]);
    expect(result[0]!.currentState).toBe("open");
  });
});
