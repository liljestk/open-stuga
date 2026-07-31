import { describe, expect, it } from "vitest";
import {
  MCP_THERMAL_HISTORY_READ_CONCURRENCY,
  runMcpThermalWork,
} from "../src/mcp-server/thermal-work.js";

describe("MCP thermal work", () => {
  it("forwards one request signal and caps indoor history reads at two", async () => {
    const controller = new AbortController();
    const observedSignals: Array<AbortSignal | undefined> = [];
    let activeIndoorReads = 0;
    let maximumIndoorReads = 0;

    const result = await runMcpThermalWork({
      subjects: [1, 2, 3, 4, 5],
      signal: controller.signal,
      readOutdoor: async (signal) => {
        observedSignals.push(signal);
        return "outdoor";
      },
      readIndoor: async (subject, signal) => {
        observedSignals.push(signal);
        activeIndoorReads += 1;
        maximumIndoorReads = Math.max(maximumIndoorReads, activeIndoorReads);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeIndoorReads -= 1;
        return `indoor-${subject}`;
      },
      complete: ({ indoor, outdoor }, signal) => {
        observedSignals.push(signal);
        return { indoor, outdoor };
      },
    });

    expect(MCP_THERMAL_HISTORY_READ_CONCURRENCY).toBe(2);
    expect(maximumIndoorReads).toBe(2);
    expect(observedSignals.every((signal) => signal === controller.signal)).toBe(true);
    expect(result).toEqual({
      outdoor: "outdoor",
      indoor: ["indoor-1", "indoor-2", "indoor-3", "indoor-4", "indoor-5"],
    });
  });

  it("does not start reads for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    let readStarted = false;

    await expect(runMcpThermalWork({
      subjects: [1],
      signal: controller.signal,
      readOutdoor: async () => {
        readStarted = true;
        return "outdoor";
      },
      readIndoor: async () => {
        readStarted = true;
        return "indoor";
      },
      complete: () => "complete",
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(readStarted).toBe(false);
  });
});
