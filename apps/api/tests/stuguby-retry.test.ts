import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  type StugubyMember,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";

import { StugubyService } from "../src/stuguby/service.js";
import {
  stugubyServiceState,
  type StugubyServiceInternals,
} from "../src/stuguby/service/core.js";
import { node, stop, type RunningNode } from "./stugubyTestSupport.js";

const FIRST_STUGUBY_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_STUGUBY_ID = "10000000-0000-4000-8000-000000000002";
const FIRST_COORDINATOR_ID = "20000000-0000-4000-8000-000000000001";
const SECOND_COORDINATOR_ID = "20000000-0000-4000-8000-000000000002";

function seedFederation(
  current: RunningNode,
  id = FIRST_STUGUBY_ID,
  coordinatorNodeId = FIRST_COORDINATOR_ID,
): StugubySummary {
  const service = current.runtime.stuguby;
  const now = new Date().toISOString();
  const localMember: StugubyMember = {
    stugubyId: id,
    nodeId: service.identity.nodeId,
    displayName: service.identity.displayName,
    role: "participant",
    state: "active",
    publicKey: service.identity.publicKey,
    keyFingerprint: service.identity.keyFingerprint,
    joinedAt: now,
    updatedAt: now,
  };
  const coordinator: StugubyMember = {
    ...localMember,
    nodeId: coordinatorNodeId,
    displayName: `Coordinator ${id}`,
    role: "steward",
  };
  const summary: StugubySummary = {
    id,
    name: `Federation ${id}`,
    description: null,
    coordinatorNodeId,
    coordinatorUrl: "https://coordinator.example.test",
    localRole: "participant",
    localMemberState: "active",
    memberCount: 2,
    createdAt: now,
    updatedAt: now,
    lastSyncAt: null,
    lastSyncError: null,
  };
  return service.store.saveJoinedStuguby(summary, [coordinator, localMember], localMember);
}

function replacementService(
  current: RunningNode,
  fetcher: typeof fetch,
  syncIntervalMs = 2_000,
): StugubyService {
  return new StugubyService({
    database: current.runtime.database,
    store: current.runtime.stuguby.store,
    keys: current.runtime.stuguby.keys,
    bus: current.runtime.bus,
    assetDirectory: current.directory,
    fetcher,
    syncIntervalMs,
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({
    error: { code: "REMOTE_TEST_ERROR", message: `Remote returned ${status}` },
  }), {
    status,
    headers: { "content-type": STUGBY_MEDIA_TYPE },
  });
}

function emptyEventPage(cursor = 0): Response {
  return new Response(JSON.stringify({
    protocolVersion: STUGBY_PROTOCOL_VERSION,
    events: [],
    cursor,
    hasMore: false,
  }), {
    status: 200,
    headers: { "content-type": STUGBY_MEDIA_TYPE },
  });
}

describe("Stuguby retry scheduling", () => {
  const nodes: RunningNode[] = [];
  const startedServices: StugubyService[] = [];

  afterEach(async () => {
    for (const service of startedServices.splice(0).reverse()) await service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const current of nodes.splice(0).reverse()) await stop(current);
  });

  it("clears the SSE connection timeout after response headers", async () => {
    const current = await node("SSE timeout participant");
    nodes.push(current);
    const summary = seedFederation(current);
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      observedSignal = init?.signal ?? null;
      return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const service = replacementService(current, fetcher);
    const manual = new AbortController();
    const response = await (service as unknown as StugubyServiceInternals).signedFetch(
      summary,
      `/api/v1/stugby-protocol/stugbys/${summary.id}/events/stream?cursor=0`,
      { method: "GET", signal: manual.signal, stream: true },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(observedSignal?.aborted).toBe(false);
    manual.abort();
    expect(observedSignal?.aborted).toBe(true);
    await response.body?.cancel();
  });

  it("aborts an SSE attempt that never receives response headers", async () => {
    const current = await node("SSE connect timeout participant");
    nodes.push(current);
    const summary = seedFederation(current);
    vi.useFakeTimers();
    const fetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = (): void => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    const service = replacementService(current, fetcher);
    const request = (service as unknown as StugubyServiceInternals).signedFetch(
      summary,
      `/api/v1/stugby-protocol/stugbys/${summary.id}/events/stream?cursor=0`,
      { method: "GET", signal: new AbortController().signal, stream: true },
    );
    const rejected = expect(request).rejects.toThrow(/connection timed out/u);

    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it("backs off transient stream failures exponentially", async () => {
    const current = await node("SSE retry participant");
    nodes.push(current);
    seedFederation(current);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    const streamAttempts: number[] = [];
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("/events/stream?")) {
        streamAttempts.push(Date.now());
        throw new Error("temporary stream outage");
      }
      return emptyEventPage();
    };
    const service = replacementService(current, fetcher, 300_000);
    startedServices.push(service);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamAttempts).toEqual([Date.parse("2026-07-30T12:00:00.000Z")]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(streamAttempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamAttempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(streamAttempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamAttempts).toHaveLength(3);
  });

  it("probes permission failures no more than once every five minutes", async () => {
    const current = await node("SSE permission participant");
    nodes.push(current);
    seedFederation(current);
    vi.useFakeTimers();
    const streamAttempts: number[] = [];
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("/events/stream?")) {
        streamAttempts.push(Date.now());
        return errorResponse(403);
      }
      return emptyEventPage();
    };
    const service = replacementService(current, fetcher, 300_000);
    startedServices.push(service);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamAttempts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(streamAttempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamAttempts).toHaveLength(2);
  });

  it("cools down failed automatic pulls while manual sync bypasses and success clears it", async () => {
    const current = await node("Pull cooldown participant");
    nodes.push(current);
    const summary = seedFederation(current);
    vi.useFakeTimers();
    let fail = true;
    const pulls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      pulls.push(String(input));
      return fail ? errorResponse(403) : emptyEventPage();
    };
    const service = replacementService(current, fetcher);

    await service.syncAll();
    await service.syncAll();
    expect(pulls).toHaveLength(1);
    await expect(service.syncNow(summary.id)).rejects.toMatchObject({ status: 403 });
    expect(pulls).toHaveLength(2);

    fail = false;
    await service.syncNow(summary.id);
    await service.syncAll();
    expect(pulls).toHaveLength(4);
  });

  it("coalesces a federation sync and targets only the notified federation", async () => {
    const current = await node("Targeted notification participant");
    nodes.push(current);
    seedFederation(current);
    seedFederation(current, SECOND_STUGUBY_ID, SECOND_COORDINATOR_ID);
    const pullUrls: string[] = [];
    const controller = new AbortController();
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/events/stream?")) {
        return new Response(`event: available\ndata: ${JSON.stringify({ cursor: 1 })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      pullUrls.push(url);
      controller.abort();
      return emptyEventPage();
    };
    const service = replacementService(current, fetcher);
    const internals = service as unknown as StugubyServiceInternals;
    internals[stugubyServiceState].started = true;
    await internals.notificationLoop(FIRST_STUGUBY_ID, controller);
    internals[stugubyServiceState].started = false;

    expect(pullUrls).toHaveLength(1);
    expect(pullUrls[0]).toContain(`/stugbys/${FIRST_STUGUBY_ID}/events?`);
    expect(pullUrls[0]).not.toContain(SECOND_STUGUBY_ID);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const syncOne = vi.spyOn(internals, "syncOne").mockImplementation(async () => blocked);
    const first = internals.syncFederation(FIRST_STUGUBY_ID, false, true);
    const second = internals.syncFederation(FIRST_STUGUBY_ID, false, true);
    expect(syncOne).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
  });
});
