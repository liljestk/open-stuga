/**
 * Resolve after `delayMs`, or as soon as `signal` aborts. It never rejects:
 * pollers wait with it between attempts and treat an abort as "stop quietly",
 * and the timer is unref'd so a pending wait never keeps the process alive.
 */
export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
