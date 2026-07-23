import type { Server } from "node:http";

export interface DrainableApiRuntime {
  beginShutdown: () => void | Promise<void>;
  close: () => void | Promise<void>;
}

export interface HttpShutdownResult {
  forced: boolean;
}

/**
 * Stops accepting new connections immediately while producers and long-lived
 * streams begin shutting down. The database stays open until both lifecycle
 * shutdown and the accepted HTTP requests have drained, while a bounded
 * fallback prevents a stuck client from hanging the process forever.
 */
export function shutdownHttpServer(
  server: Server,
  runtime: DrainableApiRuntime,
  timeoutMs = 10_000,
): Promise<HttpShutdownResult> {
  let forced = false;
  const lifecycle = Promise.resolve().then(() => runtime.beginShutdown());
  void lifecycle.then(
    () => server.closeIdleConnections(),
    () => server.closeIdleConnections(),
  );
  const drained = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
    }, timeoutMs);
    timer.unref();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    try {
      server.close(finish);
      server.closeIdleConnections();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("HTTP server shutdown failed"));
    }
  });

  return Promise.allSettled([lifecycle, drained]).then(async ([lifecycleResult, drainResult]) => {
    await runtime.close();
    if (lifecycleResult.status === "rejected") throw lifecycleResult.reason;
    if (drainResult.status === "rejected") throw drainResult.reason;
    return { forced };
  });
}
