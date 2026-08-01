import type { MeasurementSample } from "@climate-twin/contracts";
import { describe, expect, it } from "vitest";
import {
  assertHomeAssistantHistoryChunkLimit,
  boundedHomeAssistantHistoryJson,
  HA_HISTORY_MAX_CHUNKS,
  storeBoundedHomeAssistantHistorySample,
} from "../src/home-assistant/history-limits.js";

function sample(timestamp: string): MeasurementSample {
  return {
    sensorId: "sensor-01",
    metric: "temperature",
    value: 21,
    canonicalUnit: "°C",
    timestamp,
    source: "home-assistant",
    quality: "good",
  };
}

describe("Home Assistant history recovery limits", () => {
  it("rejects a streamed recorder response once its byte limit is exceeded", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("[[{\"state\":\"21\"}"));
        controller.enqueue(new TextEncoder().encode("]]"));
        controller.close();
      },
    }));

    await expect(boundedHomeAssistantHistoryJson(response, 16)).rejects.toThrow(
      "Home Assistant history response exceeds the 16-byte limit",
    );
  });

  it("allows 30 daily chunks and rejects a longer recovery range before fetching", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    expect(() => assertHomeAssistantHistoryChunkLimit(
      start,
      start + HA_HISTORY_MAX_CHUNKS * 24 * 60 * 60_000,
    )).not.toThrow();
    expect(() => assertHomeAssistantHistoryChunkLimit(
      start,
      start + HA_HISTORY_MAX_CHUNKS * 24 * 60 * 60_000 + 1,
    )).toThrow("Home Assistant history recovery exceeds the 30-chunk (30-day) limit");
  });

  it("rejects a new unique sample after the aggregate limit is reached", () => {
    const samples = new Map<string, MeasurementSample>();
    storeBoundedHomeAssistantHistorySample(samples, sample("2026-01-01T00:00:00.000Z"), 1);

    expect(() => storeBoundedHomeAssistantHistorySample(
      samples,
      sample("2026-01-01T00:01:00.000Z"),
      1,
    )).toThrow("Home Assistant history recovery exceeds the 1-sample limit");
    expect(samples.size).toBe(1);
  });
});
