import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api";
import { historyIsPreparing, historyRefreshInterval } from "./historyPreparation";

describe("history preparation polling", () => {
  it("uses short active polling only for the server's explicit preparation state", () => {
    const interval = historyRefreshInterval(true, 900_000);
    const preparing = new ApiRequestError(503, "TELEMETRY_ROLLUPS_MATERIALIZING", "Preparing");
    expect(historyIsPreparing(preparing)).toBe(true);
    expect(interval({ state: { error: preparing } })).toBe(5_000);
    for (const error of [null, new Error("failed"),
      new ApiRequestError(403, "TELEMETRY_ROLLUPS_MATERIALIZING", "Denied"),
      new ApiRequestError(503, "ANALYTICS_BUSY", "Busy")]) {
      expect(historyIsPreparing(error)).toBe(false);
      expect(interval({ state: { error } })).toBe(900_000);
    }
    expect(historyRefreshInterval(false, 900_000)({ state: { error: preparing } })).toBe(false);
  });
});
