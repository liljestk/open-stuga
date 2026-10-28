import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimateDatabase } from "../src/db.js";
import { reportBackgroundFailure, SystemErrorLog } from "../src/system-error-log.js";

afterEach(() => vi.restoreAllMocks());

describe("background failure reporting", () => {
  it("records a redacted entry in the exportable system error log", () => {
    const database = new ClimateDatabase(":memory:", false);
    const log = new SystemErrorLog(database);
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
    reportBackgroundFailure(log, {
      level: "warning", source: "scheduled-data-exports", code: "WORKER_TICK_FAILED",
      message: "Upload to https://nas.example.test/share failed for owner@example.test",
    });
    expect(log.list()).toEqual([expect.objectContaining({
      level: "warning", source: "scheduled-data-exports", code: "WORKER_TICK_FAILED",
      message: "Upload to [redacted-url] failed for [redacted-email]",
    })]);
    expect(console).not.toHaveBeenCalled();
    database.close();
  });

  it("falls back to a detail-free console line when the log cannot be written", () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
    reportBackgroundFailure({ record: () => false }, { source: "weather", code: "PROJECTION_FAILED", message: "secret detail" });
    reportBackgroundFailure(null, { source: "spatial-layers", code: "ENGINE_UNAVAILABLE", message: "secret detail" });
    expect(console.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: "background_failure", source: "weather", code: "PROJECTION_FAILED" },
      { event: "background_failure", source: "spatial-layers", code: "ENGINE_UNAVAILABLE" },
    ]);
  });
});
