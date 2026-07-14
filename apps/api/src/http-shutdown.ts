import type { Server } from "node:http";

export interface DrainableApiRuntime {
  beginShutdown: () => void;
  close: () => void;
}

export interface HttpShutdownResult {
  forced: boolean;
}

/**
 * Stops producers and long-lived event streams before asking Node to drain the
 * remaining requests. The database stays open until every normal request has
 * finished, while a bounded fallback prevents a stuck client from hanging the
 * process forever.
 */
export function shutdownHttpServer(
  server: Server,
  runtime: DrainableApiRuntime,
  timeoutMs = 10_000,
): Promise<HttpShutdownResult> {
  runtime.beginShutdown();

  return new Promise<HttpShutdownResult>((resolve, reject) => {
    let settled = false;
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
    }, timeoutMs);
    timer.unref();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        runtime.close();
      } catch (closeError) {
        reject(closeError);
        return;
      }
      if (error) reject(error);
      else resolve({ forced });
    };

    try {
      server.close(finish);
      server.closeIdleConnections();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("HTTP server shutdown failed"));
    }
  });
}
