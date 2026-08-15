import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpeningActivityRequest, OpeningActivityResponse } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { useOpeningActivityQuery } from "./openingActivityQuery";

function response(requestId: string): OpeningActivityResponse {
  return { requestId } as OpeningActivityResponse;
}

function Probe({ request }: Readonly<{ request: OpeningActivityRequest }>) {
  const query = useOpeningActivityQuery(request, "24h");
  return <output>{query.data?.requestId ?? "empty"}</output>;
}

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("useOpeningActivityQuery", () => {
  it("retains cached data while rolling bounds refetch under one stable key", async () => {
    const firstRequest = {
      apiVersion: "1.0",
      requestId: "opening-first",
      houseId: "house-1",
      dataMode: "demo",
      range: {
        start: "2026-08-11T12:00:00.000Z",
        end: "2026-08-12T12:00:00.000Z",
      },
    } as const satisfies OpeningActivityRequest;
    const nextRequest = {
      ...firstRequest,
      requestId: "opening-next",
      range: {
        start: "2026-08-11T12:01:00.000Z",
        end: "2026-08-12T12:01:00.000Z",
      },
    } satisfies OpeningActivityRequest;
    let resolveNext!: (value: OpeningActivityResponse) => void;
    const nextResponse = new Promise<OpeningActivityResponse>((resolve) => {
      resolveNext = resolve;
    });
    const openingActivity = vi.spyOn(api, "openingActivity")
      .mockResolvedValueOnce(response(firstRequest.requestId))
      .mockReturnValueOnce(nextResponse);

    const view = render(<Probe request={firstRequest} />);
    expect(await screen.findByText(firstRequest.requestId)).not.toBeNull();

    view.rerender(<Probe request={nextRequest} />);
    await waitFor(() => expect(openingActivity).toHaveBeenCalledTimes(2));
    expect(screen.getByText(firstRequest.requestId)).not.toBeNull();
    expect(queryClient.getQueryCache().findAll({ queryKey: ["analytics", "opening-activity"] })).toHaveLength(1);
    expect(openingActivity).toHaveBeenLastCalledWith(nextRequest, expect.any(AbortSignal));

    resolveNext(response(nextRequest.requestId));
    expect(await screen.findByText(nextRequest.requestId)).not.toBeNull();
  });

  it("cancels and supersedes same-key bounds changes while the first request is pending", async () => {
    const firstRequest = {
      apiVersion: "1.0",
      requestId: "opening-pending",
      houseId: "house-1",
      dataMode: "demo",
      range: {
        start: "2026-08-11T12:00:00.000Z",
        end: "2026-08-12T12:00:00.000Z",
      },
    } as const satisfies OpeningActivityRequest;
    const nextRequest = {
      ...firstRequest,
      requestId: "opening-replacement",
      range: {
        start: "2026-08-11T12:01:00.000Z",
        end: "2026-08-12T12:01:00.000Z",
      },
    } satisfies OpeningActivityRequest;
    let firstSignal: AbortSignal | undefined;
    let nextSignal: AbortSignal | undefined;
    let resolveFirst!: (value: OpeningActivityResponse) => void;
    let resolveNext!: (value: OpeningActivityResponse) => void;
    const firstResponse = new Promise<OpeningActivityResponse>((resolve) => { resolveFirst = resolve; });
    const nextResponse = new Promise<OpeningActivityResponse>((resolve) => { resolveNext = resolve; });
    const openingActivity = vi.spyOn(api, "openingActivity")
      .mockImplementationOnce((_request, signal) => {
        firstSignal = signal;
        return firstResponse;
      })
      .mockImplementationOnce((_request, signal) => {
        nextSignal = signal;
        return nextResponse;
      });

    const view = render(<Probe request={firstRequest} />);
    await waitFor(() => expect(openingActivity).toHaveBeenCalledOnce());
    expect(firstSignal?.aborted).toBe(false);

    view.rerender(<Probe request={nextRequest} />);
    await waitFor(() => expect(openingActivity).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    expect(nextSignal?.aborted).toBe(false);

    await act(async () => {
      resolveFirst(response(firstRequest.requestId));
      await firstResponse;
    });
    expect(screen.getByText("empty")).not.toBeNull();

    resolveNext(response(nextRequest.requestId));
    expect(await screen.findByText(nextRequest.requestId)).not.toBeNull();
  });
});
