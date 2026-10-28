import type { Response } from "express";

export const MAX_SSE_QUEUE_MESSAGES = 128;

export const MAX_SSE_QUEUE_BYTES = 256 * 1024;

export const MAX_EVENT_STREAMS_GLOBAL = 64;

export const MAX_EVENT_STREAMS_PER_USER = 8;

export interface BoundedSseWriter {
  send: (payload: string) => boolean;
  dispose: () => void;
}

export function boundedSseWriter(response: Response): BoundedSseWriter {
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let disposed = false;
  const flush = (): void => {
    if (disposed || response.destroyed || response.writableEnded) return;
    blocked = false;
    while (queue.length > 0 && !blocked) {
      const payload = queue.shift()!;
      queuedBytes -= Buffer.byteLength(payload);
      blocked = !response.write(payload);
    }
  };
  response.on("drain", flush);
  return {
    send(payload): boolean {
      if (disposed || response.destroyed || response.writableEnded) return false;
      if (!blocked && queue.length === 0) {
        blocked = !response.write(payload);
        return true;
      }
      const bytes = Buffer.byteLength(payload);
      if (queue.length >= MAX_SSE_QUEUE_MESSAGES || queuedBytes + bytes > MAX_SSE_QUEUE_BYTES) {
        disposed = true;
        response.off("drain", flush);
        response.end();
        return false;
      }
      queue.push(payload);
      queuedBytes += bytes;
      return true;
    },
    dispose(): void {
      disposed = true;
      queue.length = 0;
      queuedBytes = 0;
      response.off("drain", flush);
    },
  };
}
