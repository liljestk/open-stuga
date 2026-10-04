import type { Response } from "express";

/** Disconnects cancel queued work and terminate running SQLite worker scans. */
export async function withResponseSignal<T>(response: Response, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
  response.once("close", abort);
  if (response.destroyed) abort();
  try {
    return await operation(controller.signal);
  } finally {
    response.off("close", abort);
  }
}
