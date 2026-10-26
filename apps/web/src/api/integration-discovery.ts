import type {
  IntegrationDiscoveryJob,
  IntegrationDiscoveryResult,
} from "@climate-twin/contracts";

import {
  API_BASE,
  INTEGRATION_DISCOVERY_REQUEST_TIMEOUT_MS,
  request,
} from "./support";
import { withSignal } from "./support/signal";

interface DiscoveryJobEnvelope {
  job: IntegrationDiscoveryJob;
}

interface ActiveDiscoveryWait {
  controller: AbortController;
  promise: Promise<IntegrationDiscoveryResult>;
  settled: boolean;
  subscribers: number;
}

const activeDiscoveryWaits = new Map<string, ActiveDiscoveryWait>();
const discoveryJobRequests = new Map<string, Promise<DiscoveryJobEnvelope>>();

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Device discovery subscription cancelled", "AbortError");
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function completedResult(job: IntegrationDiscoveryJob): IntegrationDiscoveryResult | null {
  if (job.status === "running") return null;
  if (job.status === "completed" && job.result) return job.result;
  throw new Error(job.error?.trim() || "Device discovery failed");
}

async function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const dispose = () => signal.removeEventListener("abort", abort);
    const finish = (callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      dispose();
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      dispose();
      reject(error);
    };
    const abort = () => fail(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(resolve, value), fail);
    if (signal.aborted) abort();
  });
}

async function pollDiscoveryJob(
  job: IntegrationDiscoveryJob,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<IntegrationDiscoveryResult> {
  let current = job;
  while (true) {
    if (signal?.aborted) throw abortReason(signal);
    const result = completedResult(current);
    if (result) return result;
    if (Date.now() >= deadlineAt) throw new Error("Device discovery is still running. Return to Set up to see the result.");
    await pause(1_000, signal);
    current = (await request<DiscoveryJobEnvelope>(
      `/integrations/discovery-jobs/${encodeURIComponent(job.id)}`,
      withSignal(signal),
    )).job;
  }
}

async function waitForIntegrationDiscoveryOnce(
  job: IntegrationDiscoveryJob,
  signal?: AbortSignal,
): Promise<IntegrationDiscoveryResult> {
  if (signal?.aborted) throw abortReason(signal);
  const immediate = completedResult(job);
  if (immediate) return immediate;
  const deadlineAt = Date.now() + INTEGRATION_DISCOVERY_REQUEST_TIMEOUT_MS;
  if (typeof EventSource === "undefined") return pollDiscoveryJob(job, deadlineAt, signal);

  return new Promise<IntegrationDiscoveryResult>((resolve, reject) => {
    const source = new EventSource(
      `${API_BASE}/integrations/discovery-jobs/events?jobId=${encodeURIComponent(job.id)}`,
      { withCredentials: true },
    );
    let settled = false;
    let fallbackStarted = false;
    let abortListener: (() => void) | null = null;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      source.close();
      void request<DiscoveryJobEnvelope>(
        `/integrations/discovery-jobs/${encodeURIComponent(job.id)}`,
        withSignal(signal),
      ).then(({ job: latest }) => {
        const result = completedResult(latest);
        if (result) finish(result);
        else fail(new Error("Device discovery is still running. Return to Set up to see the result."));
      }).catch(fail);
    }, INTEGRATION_DISCOVERY_REQUEST_TIMEOUT_MS);
    const dispose = () => {
      if (settled) return false;
      settled = true;
      globalThis.clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      source.close();
      return true;
    };
    const finish = (result: IntegrationDiscoveryResult) => {
      if (dispose()) resolve(result);
    };
    const fail = (error: unknown) => {
      if (dispose()) reject(error);
    };
    const consume = (message: MessageEvent<string>) => {
      try {
        const update = JSON.parse(message.data) as IntegrationDiscoveryJob;
        if (update.id !== job.id) return;
        const result = completedResult(update);
        if (result) finish(result);
      } catch (error) {
        fail(error);
      }
    };
    source.addEventListener("integration-discovery", (message) => consume(message as MessageEvent<string>));
    source.onerror = () => {
      if (fallbackStarted || settled) return;
      fallbackStarted = true;
      source.close();
      void pollDiscoveryJob(job, deadlineAt, signal).then(finish).catch(fail);
    };
    abortListener = () => fail(abortReason(signal!));
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) abortListener();
  });
}

function activeDiscoveryWait(job: IntegrationDiscoveryJob): ActiveDiscoveryWait {
  const existing = activeDiscoveryWaits.get(job.id);
  if (existing) return existing;
  const controller = new AbortController();
  const entry: ActiveDiscoveryWait = {
    controller,
    promise: waitForIntegrationDiscoveryOnce(job, controller.signal),
    settled: false,
    subscribers: 0,
  };
  activeDiscoveryWaits.set(job.id, entry);
  const settle = () => {
    entry.settled = true;
    if (activeDiscoveryWaits.get(job.id) === entry) activeDiscoveryWaits.delete(job.id);
  };
  void entry.promise.then(settle, settle);
  return entry;
}

function joinDiscoveryWait(
  jobId: string,
  entry: ActiveDiscoveryWait,
  signal?: AbortSignal,
): Promise<IntegrationDiscoveryResult> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  entry.subscribers += 1;
  return new Promise<IntegrationDiscoveryResult>((resolve, reject) => {
    let settled = false;
    const release = () => {
      signal?.removeEventListener("abort", abort);
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers !== 0 || entry.settled) return;
      if (activeDiscoveryWaits.get(jobId) === entry) activeDiscoveryWaits.delete(jobId);
      entry.controller.abort(new DOMException("Device discovery has no active browser watcher", "AbortError"));
    };
    const finish = (result: IntegrationDiscoveryResult) => {
      if (settled) return;
      settled = true;
      release();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      release();
      reject(error);
    };
    const abort = () => fail(abortReason(signal!));
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(finish, fail);
    if (signal?.aborted) abort();
  });
}

export async function waitForIntegrationDiscovery(
  job: IntegrationDiscoveryJob,
  signal?: AbortSignal,
): Promise<IntegrationDiscoveryResult> {
  if (signal?.aborted) throw abortReason(signal);
  const immediate = completedResult(job);
  if (immediate) return immediate;
  return joinDiscoveryWait(job.id, activeDiscoveryWait(job), signal);
}

function discoveryJobRequest(jobId: string): Promise<DiscoveryJobEnvelope> {
  const existing = discoveryJobRequests.get(jobId);
  if (existing) return existing;
  const pending = request<DiscoveryJobEnvelope>(
    `/integrations/discovery-jobs/${encodeURIComponent(jobId)}`,
  );
  discoveryJobRequests.set(jobId, pending);
  const settle = () => {
    if (discoveryJobRequests.get(jobId) === pending) discoveryJobRequests.delete(jobId);
  };
  void pending.then(settle, settle);
  return pending;
}

export async function discoverIntegrationsInBackground(
  houseId: string,
  tpLinkCredentials?: { username: string; password: string },
  onStarted?: (job: IntegrationDiscoveryJob) => void,
  signal?: AbortSignal,
): Promise<IntegrationDiscoveryResult> {
  const response = await request<DiscoveryJobEnvelope>("/integrations/discovery-jobs", {
    method: "POST",
    body: JSON.stringify({
      houseId,
      ...(tpLinkCredentials ? {
        tpLinkUsername: tpLinkCredentials.username,
        tpLinkPassword: tpLinkCredentials.password,
      } : {}),
    }),
  });
  const waiting = waitForIntegrationDiscovery(response.job, signal);
  onStarted?.(response.job);
  return waiting;
}

export async function resumeIntegrationDiscovery(
  jobId: string,
  signal?: AbortSignal,
): Promise<IntegrationDiscoveryResult> {
  const active = activeDiscoveryWaits.get(jobId);
  if (active) return joinDiscoveryWait(jobId, active, signal);
  const response = await withCallerAbort(discoveryJobRequest(jobId), signal);
  return waitForIntegrationDiscovery(response.job, signal);
}

export async function latestIntegrationDiscovery(
  houseId: string,
): Promise<IntegrationDiscoveryJob | null> {
  const response = await request<{ job: IntegrationDiscoveryJob | null }>(
    `/integrations/discovery-jobs/latest?houseId=${encodeURIComponent(houseId)}`,
  );
  return response.job;
}
