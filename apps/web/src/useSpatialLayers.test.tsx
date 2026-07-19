import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpatialLayers } from "./useSpatialLayers";

afterEach(() => vi.clearAllMocks());

describe("useSpatialLayers optional capability", () => {
  it("keeps core views quiet when the local spatial host returns 503", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "SPATIAL_LAYERS_UNAVAILABLE", message: "Research engine is not configured" } }),
    } as Response);

    const { result } = renderHook(() => useSpatialLayers({ scope: { kind: "house", id: "house-1" } }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.available).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshots).toEqual([]);
  });
});
