// The appliance serves the UI over HTTP/1.1 and keeps live-event connections
// open. Bound ordinary requests so a history fan-out cannot fill the browser's
// per-origin connection pool before queued work reaches the API.
export const MAX_CONCURRENT_API_REQUESTS = 3;

// Keep one request slot available for session checks and mutations while
// history reads are filling the bounded read queue.
export const MAX_CONCURRENT_API_READ_REQUESTS = MAX_CONCURRENT_API_REQUESTS - 1;

export type ApiRequestSchedulingClass = "background" | "interactive";

export type ApiRequestInit = RequestInit & {
  schedulingClass?: ApiRequestSchedulingClass;
};

type ApiRequestWaiter = {
  signal: AbortSignal;
  schedulingClass: ApiRequestSchedulingClass;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  abort: () => void;
};

let activeApiRequestCount = 0;
let activeApiReadRequestCount = 0;
const apiRequestWaiters: ApiRequestWaiter[] = [];

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The API request was cancelled", "AbortError");
}

function drainApiRequestWaiters(): void {
  while (activeApiRequestCount < MAX_CONCURRENT_API_REQUESTS && apiRequestWaiters.length > 0) {
    const waiterIndex = apiRequestWaiters.findIndex((candidate) => (
      candidate.schedulingClass === "interactive"
      || activeApiReadRequestCount < MAX_CONCURRENT_API_READ_REQUESTS
    ));
    if (waiterIndex < 0) return;
    const waiter = apiRequestWaiters.splice(waiterIndex, 1)[0]!;
    waiter.signal.removeEventListener("abort", waiter.abort);
    if (waiter.signal.aborted) {
      waiter.reject(abortReason(waiter.signal));
      continue;
    }
    activeApiRequestCount += 1;
    if (waiter.schedulingClass === "background") activeApiReadRequestCount += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      activeApiRequestCount -= 1;
      if (waiter.schedulingClass === "background") activeApiReadRequestCount -= 1;
      drainApiRequestWaiters();
    });
  }
}

/** Wait for browser/API capacity. Queue time is deliberately not request time. */
export function acquireApiRequestSlot(
  signal: AbortSignal,
  schedulingClass: ApiRequestSchedulingClass,
): Promise<() => void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const waiter: ApiRequestWaiter = {
      signal,
      schedulingClass,
      resolve,
      reject,
      abort: () => {
        const index = apiRequestWaiters.indexOf(waiter);
        if (index >= 0) apiRequestWaiters.splice(index, 1);
        reject(abortReason(signal));
      },
    };
    waiter.signal.addEventListener("abort", waiter.abort, { once: true });
    apiRequestWaiters.push(waiter);
    drainApiRequestWaiters();
  });
}
