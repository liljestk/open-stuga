import type {
  IntegrationDiscoveryJob,
  IntegrationDiscoveryResult,
} from "@climate-twin/contracts";

import {
  API_BASE,
  INTEGRATION_DISCOVERY_REQUEST_TIMEOUT_MS,
  request,
} from "./support";

interface DiscoveryJobEnvelope {
  job: IntegrationDiscoveryJob;
}

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
      signal ? { signal } : undefined,
    )).job;
  }
}

export async function waitForIntegrationDiscovery(
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
        signal ? { signal } : undefined,
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
  onStarted?.(response.job);
  return waitForIntegrationDiscovery(response.job, signal);
}

export async function resumeIntegrationDiscovery(
  jobId: string,
  signal?: AbortSignal,
): Promise<IntegrationDiscoveryResult> {
  const response = await request<DiscoveryJobEnvelope>(
    `/integrations/discovery-jobs/${encodeURIComponent(jobId)}`,
    signal ? { signal } : undefined,
  );
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
