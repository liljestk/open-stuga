import type { Server } from "node:http";

export interface DrainableApiRuntime {
  beginShutdown: () => void | Promise<void>;
  close: () => void | Promise<void>;
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
  const begin = runtime.beginShutdown();

  return Promise.resolve(begin).then(() => new Promise<HttpShutdownResult>((resolve, reject) => {
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
      let closing: void | Promise<void>;
      try {
        closing = runtime.close();
      } catch (closeError) {
        reject(closeError);
        return;
      }
      void Promise.resolve(closing).then(() => {
        if (error) reject(error);
        else resolve({ forced });
      }, reject);
    };

    try {
      server.close(finish);
      server.closeIdleConnections();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("HTTP server shutdown failed"));
    }
  }));
}
